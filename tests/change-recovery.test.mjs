import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObservationStore } from '../src/store.mjs';
import { ArchiveRecords } from '../src/records.mjs';
import { ChangeCoordinator, REVIEW_POLICY_ID } from '../src/architecture/change.mjs';
import { INPUT_FINGERPRINT_KIND } from '../src/workspace.mjs';
import { runManagedFileChanges } from '../src/managed-write.mjs';

async function fixture(t, rules = { schema_version: 1, rules: [] }) {
  const root = await mkdtemp(join(tmpdir(), 'sol-operation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'README.md'), 'before\n');
  const store = await createObservationStore(root);
  const records = new ArchiveRecords(store);
  const changes = new ChangeCoordinator({ store, records, loadConfig: async () => ({ sha256: 'a'.repeat(64) }) },
    rules);
  let runners = 0;
  changes.validator.revalidate = async () => { runners++; throw new Error('Recovery must not run checks.'); };
  const current = await changes.publish({ schema_version: 1, kind: 'change_record', workspace_id: store.workspaceId,
    id: '11111111-1111-4111-8111-111111111111', state: 'open', task: { id: 'fixture', goal: 'Update documentation.' },
    requirement_ref: 'README.md', scope: [{ path: 'README.md', module_uid: '00000001' }], acceptance: ['Keep documented intent.'],
    reuse: { decision: 'not_applicable', reason: 'Documentation change.', query_handle: 'a'.repeat(24) },
    architecture_version: 'b'.repeat(64), context_config_sha: 'a'.repeat(64), rules_sha: changes.rulesSha,
    input_fingerprint_kind: INPUT_FINGERPRINT_KIND, review_policy_id: REVIEW_POLICY_ID,
    observed: await changes.snapshot(), accumulated_paths: [], blockers: [], evidence_generation: 0,
    latest_validation: null, pending: null, review_ref: null, completion_ref: null });
  return { root, store, records, changes, current, binding: { id: current.record.id, version: current.record.version }, runners: () => runners };
}

test('one operation identity is durable before execution and outcome links actual evidence before settlement', async (t) => {
  const f = await fixture(t); let calls = 0; let operation;
  const output = await f.records.archive('actual output\n', 'fixture_output', undefined, true);
  const result = await f.changes.run(f.binding, ['README.md'], async (lease, context) => {
    calls++; operation = context;
    assert.equal(context.operationId, context.callId);
    const pending = await f.changes.read();
    assert.equal(pending.record.pending.operation_id, context.operationId);
    assert.deepEqual(pending.record.pending.starting_binding, f.binding);
    assert.equal(typeof lease.setRunner, 'function');
    await writeFile(join(f.root, 'README.md'), 'after\n');
    return { tool_status: 'ok', changed_paths: ['README.md'], raw: output };
  });
  assert.equal(calls, 1); assert.equal(result.tool_status, 'ok');
  const settled = await f.changes.read();
  assert.equal(settled.record.pending, null);
  const pointer = JSON.parse(await readFile(join(f.root, '.codex/sol/architecture/operations', `${operation.operationId}.json`)));
  assert.deepEqual(pointer.change, f.binding);
  assert.equal(pointer.outcome.handle, settled.record.operation_ref.handle);
  const outcome = await f.records.stored(pointer.outcome, 'sol_change_operation_outcome', 'change_operation_outcome');
  assert.deepEqual(outcome.evidence_refs, [output]);
  assert.equal(outcome.operation_id, operation.callId);
  assert.equal(f.runners(), 0);
});

test('outcome links the real event, validation receipt and every captured check output with the same root call identity', async (t) => {
  const f = await fixture(t, { schema_version: 1, rules: [{ schema_version: 1, id: 'docs', globs: ['README.md'],
    watch_paths: ['README.md'], commands: [{ id: 'check', argv: [process.execPath, '-e', 'process.stdout.write("verified docs\\n")'], cwd: '.', timeout_ms: 5000 }] }] });
  let operation;
  const result = await f.changes.run(f.binding, ['README.md'], (lease, context) => {
    operation = context;
    return runManagedFileChanges(f.store, f.changes.validator, [{ action: 'write', path: 'README.md', content: 'after\n' }],
      { lease, callId: context.callId });
  });
  assert.equal(result.tool_status, 'ok'); assert.equal(result.validation.status, 'passed');
  const record = (await f.changes.read()).record;
  const outcome = await f.records.stored(record.operation_ref, 'sol_change_operation_outcome', 'change_operation_outcome');
  const event = (await f.store.readVerifiedJSON(result.change_event_raw.handle)).value;
  assert.equal(event.call_id, operation.operationId);
  const receipt = (await f.store.readVerifiedJSON(result.validation.evidence_handle)).value;
  const expected = [result.change_event_raw.handle, result.validation.evidence_handle, ...receipt.checks.flatMap((check) => check.output.map((ref) => ref.handle))];
  assert.deepEqual(new Set(outcome.evidence_refs.map((ref) => ref.handle)), new Set(expected));
});

for (const stage of ['archive', 'pointer', 'settled']) test(`${stage} publication failure preserves pending and recovers only published outcomes without replay`, async (t) => {
  const f = await fixture(t); let calls = 0; let operation;
  const archive = f.records.archive.bind(f.records);
  const publish = f.changes.publish.bind(f.changes);
  const directory = f.changes.operationDirectory.bind(f.changes);
  if (stage === 'archive') f.records.archive = (...args) => args[1] === 'sol_change_operation_outcome' ? Promise.reject(new Error('archive unavailable')) : archive(...args);
  if (stage === 'pointer') f.changes.operationDirectory = (create) => create ? Promise.reject(new Error('operation pointer unavailable')) : directory(create);
  if (stage === 'settled') f.changes.publish = (record, ...args) => record.operation_ref && !record.pending ? Promise.reject(new Error('settled pointer unavailable')) : publish(record, ...args);
  const result = await f.changes.run(f.binding, ['README.md'], async (_, context) => {
    calls++; operation = context;
    await writeFile(join(f.root, 'README.md'), 'partially applied\n');
    return { tool_status: 'error', error: { code: 'FIXTURE', message: 'Known partial failure.' }, changed_paths: ['README.md'] };
  });
  assert.equal(result.tool_status, 'error'); assert.equal(result.change.recovery_required, true);
  const pending = await f.changes.read(); assert.equal(pending.record.pending.operation_id, operation.operationId);
  f.records.archive = archive; f.changes.publish = publish; f.changes.operationDirectory = directory;
  const recovered = await f.changes.status(); const record = (await f.changes.read()).record;
  assert.equal(recovered.state, 'interrupted'); assert.equal(record.recovery.status, stage === 'settled' ? 'known' : 'unknown');
  assert.equal(!!record.pending, stage !== 'settled'); assert.equal(calls, 1); assert.equal(f.runners(), 0);
  assert.deepEqual(record.accumulated_paths, ['README.md']);
  if (stage === 'settled') {
    const evidence = await f.records.stored(record.operation_ref, 'sol_change_operation_outcome', 'change_operation_outcome');
    assert.equal(evidence.outcome.error.code, 'FIXTURE');
  }
  const again = await f.changes.status(); assert.equal(again.change.version, recovered.change.version);
  const resumed = await f.changes.transition(recovered.change, 'dirty');
  assert.equal(resumed.state, 'dirty'); assert.equal((await f.changes.read()).record.pending, null);
  assert.equal(calls, 1); assert.equal(f.runners(), 0);
});

test('corrupt operation identity or outcome bytes do not replace the active pointer', async (t) => {
  const f = await fixture(t); let operation;
  const publish = f.changes.publish.bind(f.changes);
  f.changes.publish = (record, ...args) => record.operation_ref && !record.pending ? Promise.reject(new Error('settled unavailable')) : publish(record, ...args);
  await f.changes.run(f.binding, ['README.md'], async (_, context) => {
    operation = context; await writeFile(join(f.root, 'README.md'), 'after\n');
    return { tool_status: 'ok', changed_paths: ['README.md'] };
  });
  f.changes.publish = publish;
  const activePath = join(f.root, '.codex/sol/architecture/active-change.json');
  const pointerPath = join(f.root, '.codex/sol/architecture/operations', `${operation.operationId}.json`);
  const active = await readFile(activePath, 'utf8');
  const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
  await writeFile(pointerPath, JSON.stringify({ ...pointer, change: { ...pointer.change, version: 'f'.repeat(64) } }));
  await assert.rejects(f.changes.status(), { code: 'CHANGE_CORRUPT' });
  assert.equal(await readFile(activePath, 'utf8'), active);
  await writeFile(pointerPath, JSON.stringify(pointer));
  await writeFile(join(f.root, '.codex/sol/observations', pointer.outcome.handle, 'raw'), 'corrupted');
  await assert.rejects(f.changes.status(), { code: 'CORRUPT' });
  assert.equal(await readFile(activePath, 'utf8'), active); assert.equal(f.runners(), 0);
});

test('a missing published archive stays unknown and a later verified archive is associated only by explicit status', async (t) => {
  const f = await fixture(t); const publish = f.changes.publish.bind(f.changes);
  f.changes.publish = (record, ...args) => record.operation_ref && !record.pending ? Promise.reject(new Error('settled unavailable')) : publish(record, ...args);
  await f.changes.run(f.binding, ['README.md'], async () => {
    await writeFile(join(f.root, 'README.md'), 'after\n'); return { tool_status: 'ok', changed_paths: ['README.md'] };
  });
  f.changes.publish = publish;
  const pending = (await f.changes.read()).record;
  const pointer = JSON.parse(await readFile(join(f.root, '.codex/sol/architecture/operations', `${pending.pending.operation_id}.json`)));
  const archivePath = join(f.store.observationsRoot, pointer.outcome.handle); const offline = `${archivePath}.offline`;
  await rename(archivePath, offline);
  const unknown = await f.changes.status(); assert.equal((await f.changes.read()).record.recovery.status, 'unknown');
  assert.ok((await f.changes.read()).record.pending);
  await rename(offline, archivePath);
  const active = await readFile(f.changes.pointer);
  const projection = (await f.changes.inspectLocked()).projection;
  assert.equal(projection.needs_status_refresh, true); assert.equal(projection.task_complete, false);
  assert.deepEqual(await readFile(f.changes.pointer), active);
  const known = await f.changes.status(); assert.notEqual(known.change.version, unknown.change.version);
  assert.equal((await f.changes.read()).record.recovery.status, 'known'); assert.equal((await f.changes.read()).record.pending, null);
  assert.equal(known.state, 'interrupted'); assert.equal(f.runners(), 0);
});
