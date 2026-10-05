import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObservationStore, SolFault } from '../src/store.mjs';
import { digestChangedPaths, receiptSummary, snapshotInputs, ValidationEngine } from '../src/validation.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const command = (id, script) => ({ id, argv: [process.execPath, '-e', script], cwd: '.', timeout_ms: 5000 });
async function fixture(t, customize = (rules) => rules) {
  const root = await mkdtemp(join(tmpdir(), 'sol-validation-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'a'); await writeFile(join(root, 'b.txt'), 'b');
  const store = await createObservationStore(root);
  const rule = (id, watch) => ({ schema_version: 1, id, globs: watch, watch_paths: watch, reuse: 'watched_inputs',
    commands: [command('check', `require('node:fs').appendFileSync('.codex/sol/runs-${id}', 'x');process.stdout.write('${id}')`)] });
  const rules = { schema_version: 1, rules: customize([rule('a', ['a.txt', 'missing.txt']), rule('b', ['b.txt'])]) };
  const engine = new ValidationEngine(store, rules);
  const execute = (options = {}) => engine.revalidate({ rule_ids: ['a', 'b'], paths: ['a.txt', 'b.txt', 'missing.txt'], ...options });
  const recordPath = (receipt) => join(store.solRoot, 'receipts', `${sha(receipt.event_id)}.json`);
  const record = async (receipt) => JSON.parse(await readFile(recordPath(receipt), 'utf8'));
  const runs = async (id) => readFile(join(store.solRoot, `runs-${id}`), 'utf8');
  return { root, store, rules, engine, execute, recordPath, record, runs };
}

test('input snapshots stop during traversal and preserve host cancellation failures without writing evidence', async (t) => {
  const { root, store } = await fixture(t);
  const before = await snapshotInputs(root, ['**/*']);
  for (const [reason, code] of [[undefined, 'INTERRUPTED'], [new SolFault('HOST_STATE_ERROR', 'Host state became unavailable.'), 'HOST_STATE_ERROR']]) {
    const controller = new AbortController();
    const pending = snapshotInputs(root, ['**/*'], [], [], { signal: controller.signal });
    // The real traversal is awaiting readdir here, rather than receiving an already aborted signal.
    controller.abort(reason);
    await assert.rejects(pending, { code });
  }
  assert.deepEqual(await snapshotInputs(root, ['**/*']), before);
  assert.deepEqual(await readdir(store.observationsRoot), []);
});

test('plan uses real rule globs, preserves uncovered paths and rejects invalid rule selections', async (t) => {
  const { engine, store } = await fixture(t);
  assert.deepEqual(engine.plan(['a.txt', 'a.txt', 'b.txt', 'other.mjs']), { rules: [
    { id: 'a', trigger_paths: ['a.txt'], check_ids: ['a/check'] },
    { id: 'b', trigger_paths: ['b.txt'], check_ids: ['b/check'] }], uncovered_paths: ['other.mjs'] });
  assert.deepEqual(engine.plan(['A.TXT']).rules.map((rule) => rule.id), process.platform === 'win32' ? ['a'] : []);
  for (const rule_ids of [[], ['unknown'], ['a', 'a']]) {
    await assert.rejects(engine.revalidate({ rule_ids, paths: ['a.txt'] }), { code: 'VALIDATION_RULES' });
    await assert.rejects(engine.reuse({}, rule_ids), { code: 'VALIDATION_RULES' });
    await assert.rejects(engine.freshness({}, rule_ids), { code: 'VALIDATION_RULES' });
  }
  assert.throws(() => engine.plan(['../outside']), /contract invalid/u);
  assert.deepEqual(await readdir(store.observationsRoot), []);
});

test('explicit revalidation executes once without a ChangeEvent and original evidence reuses with zero runners', async (t) => {
  const { engine, store, execute, record, runs, rules } = await fixture(t);
  const receipt = await execute({ operation_id: 'operation-1' });
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.checks.length, 2);
  assert.equal(receipt.event_id, `revalidation:${sha('operation-1')}`);
  assert.deepEqual(await execute({ operation_id: 'operation-1' }), receipt);
  await assert.rejects(execute({ operation_id: 'operation-1', paths: ['a.txt'] }), { code: 'VALIDATION_OPERATION' });
  const restarted = new ValidationEngine(store, rules);
  assert.deepEqual(await restarted.revalidate({ rule_ids: ['a', 'b'], paths: ['a.txt', 'b.txt', 'missing.txt'], operation_id: 'operation-1' }), receipt);
  await assert.rejects(restarted.revalidate({ rule_ids: ['a'], paths: ['a.txt'], operation_id: 'operation-1' }), { code: 'VALIDATION_OPERATION' });
  const persisted = await record(receipt);
  const provenance = JSON.parse((await store.readVerified(persisted.provenance_ref.handle)).buffer.toString());
  assert.equal(provenance.source_kind, 'revalidation'); assert.equal(provenance.source_id, receipt.event_id);
  assert.deepEqual(provenance.rules[0].seed_paths, ['a.txt', 'b.txt', 'missing.txt']);
  for (const input of [receipt, receiptSummary(receipt)]) {
    const reuse = await restarted.reuse(input, ['a', 'b']);
    assert.deepEqual(reuse.valid_rule_ids, ['a', 'b']); assert.deepEqual(reuse.missing_rule_ids, []);
    assert.deepEqual(reuse.receipt_ref, persisted.receipt_ref); assert.deepEqual(reuse.provenance_ref, persisted.provenance_ref);
  }
  assert.equal(await runs('a'), 'x'); assert.equal(await runs('b'), 'x');
  const tools = await Promise.all((await readdir(store.observationsRoot)).map(async (handle) => JSON.parse(await readFile(join(store.observationsRoot, handle, 'meta.json'))).tool));
  assert.ok(!tools.includes('change_event'));
});

test('real change validation records its source and preserves event redelivery deduplication', async (t) => {
  const { root, store, engine, record, runs } = await fixture(t);
  const event = { schema_version: 1, event_id: randomUUID(), workspace_id: store.workspaceId,
    call_id: randomUUID(), origin: 'agent', changed_paths: ['a.txt'], change_digest: await digestChangedPaths(root, ['a.txt']) };
  const receipt = await engine.onChange(event);
  assert.equal(receipt.status, 'passed'); assert.deepEqual(await engine.onChange(event), receipt);
  const persisted = await record(receipt);
  const provenance = JSON.parse((await store.readVerified(persisted.provenance_ref.handle)).buffer.toString());
  assert.equal(provenance.source_kind, 'change'); assert.equal(provenance.call_id, event.call_id);
  assert.deepEqual((await engine.reuse(receiptSummary(receipt), ['a'])).valid_rule_ids, ['a']);
  assert.equal(await runs('a'), 'x');
});

test('per-rule watched changes and missing seed transitions invalidate only their own rule', async (t) => {
  const { root, engine, execute, runs } = await fixture(t);
  const receipt = await execute();
  await writeFile(join(root, 'a.txt'), 'changed');
  assert.deepEqual((await engine.reuse(receipt, ['a', 'b'])).valid_rule_ids, ['b']);
  const refreshed = await engine.revalidate({ rule_ids: ['a'], paths: ['a.txt', 'missing.txt'] });
  assert.equal(refreshed.status, 'passed'); assert.deepEqual(refreshed.checks.map((check) => check.id), ['a/check']);
  assert.deepEqual((await engine.reuse(refreshed, ['a'])).valid_rule_ids, ['a']);
  assert.equal(await runs('a'), 'xx'); assert.equal(await runs('b'), 'x');
  await writeFile(join(root, 'a.txt'), 'a');
  assert.deepEqual((await engine.reuse(receipt, ['a', 'b'])).valid_rule_ids, ['a', 'b']);
  await writeFile(join(root, 'missing.txt'), 'appeared');
  assert.deepEqual((await engine.reuse(receipt, ['a', 'b'])).valid_rule_ids, ['b']);
  await unlink(join(root, 'missing.txt'));
  assert.deepEqual((await engine.reuse(receipt, ['a', 'b'])).valid_rule_ids, ['a', 'b']);
  await unlink(join(root, 'a.txt'));
  assert.deepEqual((await engine.reuse(receipt, ['a', 'b'])).valid_rule_ids, ['b']);
});

test('a successful command resolved through PATH remains unverified for local reuse', async (t) => {
  const { engine, execute } = await fixture(t, (rules) => {
    rules[0].commands[0].argv[0] = 'node'; return rules;
  });
  const receipt = await execute();
  assert.equal(receipt.status, 'passed');
  const reused = await engine.reuse(receipt, ['a', 'b']);
  assert.deepEqual(reused.valid_rule_ids, ['b']);
  assert.equal(reused.diagnostics[0].reason, 'runtime_conditions_unverified');
  const freshness = await engine.freshness(receipt, ['a', 'b']);
  assert.deepEqual(freshness.valid_rule_ids, ['b']);
  assert.equal(freshness.diagnostics[0].reason, 'runtime_conditions_unverified');
});

test('rule configuration, generated exclusions and inherited environment are verified without revealing env values', async (t) => {
  const { store, engine, rules, execute, record } = await fixture(t);
  const variable = 'SOL_REUSE_TEST_PRIVATE_CONDITION';
  const previous = process.env[variable];
  const secret = `private-test-condition-${randomUUID()}`;
  process.env[variable] = secret;
  try {
    const receipt = await execute();
    const persisted = await record(receipt);
    const provenanceText = (await store.readVerified(persisted.provenance_ref.handle)).buffer.toString();
    assert.ok(!provenanceText.includes(secret)); assert.ok(!provenanceText.includes(variable));
    const modified = structuredClone(rules); modified.rules[0].commands[0].timeout_ms += 1;
    assert.deepEqual((await new ValidationEngine(store, modified).reuse(receipt, ['a', 'b'])).valid_rule_ids, ['b']);
    assert.deepEqual((await new ValidationEngine(store, rules, { generated: ['unused-cache*'] }).reuse(receipt, ['a', 'b'])).valid_rule_ids, []);
    process.env[variable] = 'different';
    const changed = await engine.reuse(receipt, ['a', 'b']);
    assert.deepEqual(changed.valid_rule_ids, []);
    assert.ok(changed.diagnostics.every((diagnostic) => diagnostic.reason === 'runtime_conditions_changed'));
  } finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
});

test('reuse defaults to never and legacy persisted results cannot acquire guessed provenance', async (t) => {
  const { engine, execute, record, recordPath } = await fixture(t, (rules) => rules.map((rule) => {
    const copy = { ...rule }; delete copy.reuse; return copy;
  }));
  const receipt = await execute();
  assert.equal(receipt.status, 'passed'); assert.deepEqual((await engine.reuse(receipt, ['a', 'b'])).valid_rule_ids, []);
  const persisted = await record(receipt); delete persisted.provenance_ref;
  await writeFile(recordPath(receipt), JSON.stringify(persisted));
  const legacy = await engine.reuse(receipt, ['a', 'b']);
  assert.deepEqual(legacy.missing_rule_ids, ['a', 'b']); assert.equal(legacy.provenance_ref, null);
  assert.deepEqual((await engine.freshness(receipt, ['a', 'b'])).missing_rule_ids, ['a', 'b']);
});

test('never rules remain ineligible for reuse while completed freshness verifies without runners or writes', async (t) => {
  const { engine, store, execute, record, runs } = await fixture(t, (rules) => {
    rules[0].reuse = 'never'; delete rules[1].reuse; return rules;
  });
  const receipt = await execute();
  assert.equal(receipt.status, 'passed');
  const persisted = await record(receipt);
  const observations = await readdir(store.observationsRoot);
  for (const input of [receipt, receiptSummary(receipt)]) {
    const fresh = await engine.freshness(input, ['a', 'b']);
    assert.deepEqual(fresh.valid_rule_ids, ['a', 'b']); assert.deepEqual(fresh.missing_rule_ids, []);
    assert.deepEqual(fresh.receipt_ref, persisted.receipt_ref); assert.deepEqual(fresh.provenance_ref, persisted.provenance_ref);
    const reused = await engine.reuse(input, ['a', 'b']);
    assert.deepEqual(reused.valid_rule_ids, []);
    assert.ok(reused.diagnostics.every((diagnostic) => diagnostic.reason === 'reuse_not_declared'));
  }
  assert.deepEqual(await readdir(store.observationsRoot), observations);
  assert.equal(await runs('a'), 'x'); assert.equal(await runs('b'), 'x');
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(engine.freshness(receipt, ['a'], { signal: cancelled.signal }), { code: 'INTERRUPTED' });
});

test('completed freshness detects absolute executable changes outside watched inputs for only its rule', async (t) => {
  const { root, store, rules, runs } = await fixture(t, (rules) => {
    rules.forEach((rule) => { rule.reuse = 'never'; }); return rules;
  });
  const executable = join(root, process.platform === 'win32' ? 'checker.exe' : 'checker');
  await copyFile(process.execPath, executable);
  rules.rules[0].commands[0].argv[0] = executable;
  const engine = new ValidationEngine(store, rules);
  const receipt = await engine.revalidate({ rule_ids: ['a', 'b'], paths: ['a.txt', 'b.txt', 'missing.txt'] });
  assert.equal(receipt.status, 'passed');
  assert.deepEqual((await engine.freshness(receipt, ['a', 'b'])).valid_rule_ids, ['a', 'b']);
  // Replace the file at the same command path without writing a mapped Windows image.
  await rename(executable, `${executable}.previous`);
  await writeFile(executable, 'changed executable identity');
  const fresh = await engine.freshness(receipt, ['a', 'b']);
  assert.deepEqual(fresh.valid_rule_ids, ['b']); assert.deepEqual(fresh.missing_rule_ids, ['a']);
  assert.equal(fresh.diagnostics[0].reason, 'runtime_conditions_changed');
  assert.equal(await runs('a'), 'x'); assert.equal(await runs('b'), 'x');
});

test('tampered caller summaries, receipt pointers, output bytes and provenance are never reusable', async (t) => {
  for (const corruption of ['summary', 'receipt_ref', 'output', 'output_identity', 'workspace', 'provenance']) {
    await t.test(corruption, async (subtest) => {
      const { store, engine, execute, record, recordPath } = await fixture(subtest);
      const receipt = await execute(); const persisted = await record(receipt);
      let input = receiptSummary(receipt);
      if (corruption === 'summary') input = { ...input, change_digest: 'f'.repeat(64) };
      if (corruption === 'receipt_ref') {
        persisted.receipt_ref.sha256 = 'f'.repeat(64); await writeFile(recordPath(receipt), JSON.stringify(persisted));
      }
      if (corruption === 'output') await writeFile(join(store.observationsRoot, receipt.checks[0].output[0].handle, 'raw'), 'tampered');
      if (['output_identity', 'workspace'].includes(corruption)) {
        const metadataPath = join(store.observationsRoot, receipt.checks[0].output[0].handle, 'meta.json');
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
        if (corruption === 'output_identity') metadata.tool = 'shell'; else metadata.workspace_id = 'another-workspace';
        await writeFile(metadataPath, JSON.stringify(metadata));
      }
      if (corruption === 'provenance') await writeFile(join(store.observationsRoot, persisted.provenance_ref.handle, 'raw'), '{}');
      const reused = await engine.reuse(input, ['a', 'b']);
      assert.deepEqual(reused.valid_rule_ids, []); assert.deepEqual(reused.missing_rule_ids, ['a', 'b']);
      assert.equal(reused.diagnostics[0].code, 'VALIDATION_EVIDENCE_UNAVAILABLE');
      assert.deepEqual((await engine.freshness(input, ['a', 'b'])).valid_rule_ids, []);
    });
  }
});

test('revalidation handles cancellation, drift and failed commands without reusable evidence', async (t) => {
  const { root, store, rules, engine } = await fixture(t);
  const controller = new AbortController();
  const cancelled = await engine.revalidate({ rule_ids: ['a'], paths: ['a.txt'] }, { signal: controller.signal,
    onRunnerState: (state) => { if (state.state === 'running') controller.abort(); } });
  assert.equal(cancelled.status, 'error'); assert.equal(cancelled.reason, 'interrupted');
  assert.ok(cancelled.evidence_handle, 'runner cancellation retains the original recallable error receipt');
  assert.equal(JSON.parse((await store.readVerified(cancelled.evidence_handle)).buffer.toString()).reason, 'interrupted');
  assert.deepEqual((await engine.reuse(cancelled, ['a'])).valid_rule_ids, []);
  const stale = await engine.revalidate({ rule_ids: ['a'], paths: ['a.txt'] }, {
    onRunnerState: async (state) => { if (state.state === 'idle') await writeFile(join(root, 'a.txt'), 'outside edit'); } });
  assert.equal(stale.status, 'stale'); assert.deepEqual((await engine.reuse(stale, ['a'])).valid_rule_ids, []);
  const bad = structuredClone(rules); bad.rules[0].commands = [command('fail', 'process.exit(7)')];
  const failedEngine = new ValidationEngine(store, bad);
  const failed = await failedEngine.revalidate({ rule_ids: ['a'], paths: ['a.txt'] });
  assert.equal(failed.status, 'failed'); assert.deepEqual((await failedEngine.reuse(failed, ['a'])).valid_rule_ids, []);
  const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
  await assert.rejects(engine.reuse(cancelled, ['a'], { signal: alreadyCancelled.signal }), { code: 'INTERRUPTED' });
  assert.equal((await engine.revalidate({ rule_ids: ['b'], paths: ['b.txt'] })).status, 'passed');
});

test('provenance storage failure cannot return passed or rerun the same explicit operation', async (t) => {
  const { store, engine, runs } = await fixture(t);
  const begin = store.beginCapture.bind(store);
  store.beginCapture = (meta) => {
    if (meta.tool === 'validation_provenance') throw new Error('provenance disk failure');
    return begin(meta);
  };
  const args = { rule_ids: ['a'], paths: ['a.txt'], operation_id: 'storage-failure' };
  const receipt = await engine.revalidate(args);
  assert.equal(receipt.status, 'error'); assert.equal(receipt.reason, 'storage'); assert.equal(receipt.evidence_handle, null);
  assert.deepEqual(await engine.revalidate(args), receipt); assert.equal(await runs('a'), 'x');
  assert.deepEqual((await engine.reuse(receipt, ['a'])).missing_rule_ids, ['a']);
});

test('cancellation during provenance publication keeps the durable result interrupted', async (t) => {
  const { store, engine, record } = await fixture(t);
  const controller = new AbortController();
  const begin = store.beginCapture.bind(store);
  store.beginCapture = (meta) => {
    if (meta.tool === 'validation_provenance') controller.abort();
    return begin(meta);
  };
  const receipt = await engine.revalidate({ rule_ids: ['a'], paths: ['a.txt'] }, { signal: controller.signal });
  assert.equal(receipt.status, 'error'); assert.equal(receipt.reason, 'interrupted');
  assert.equal(receipt.checks[0].status, 'passed');
  const persisted = await record(receipt);
  assert.deepEqual(persisted.receipt, receipt); assert.equal(persisted.provenance_ref, null); assert.equal(persisted.receipt_ref, null);
  assert.deepEqual((await engine.reuse(receipt, ['a'])).missing_rule_ids, ['a']);
});
