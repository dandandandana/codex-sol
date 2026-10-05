import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createObservationStore } from '../src/store.mjs';
import { ValidationEngine, digestChangedPaths } from '../src/validation.mjs';

async function fixture(commands) {
  const root = await mkdtemp(join(tmpdir(), 'codex-sol-validation-'));
  await writeFile(join(root, 'target.py'), 'print(1)\n');
  const store = await createObservationStore(root);
  const rules = { schema_version: 1, rules: [{ schema_version: 1, id: 'python', globs: ['**/*.py'], watch_paths: ['**/*'], commands }] };
  const engine = new ValidationEngine(store, rules);
  const event = async (origin = 'agent') => ({ schema_version: 1, event_id: randomUUID(), workspace_id: store.workspaceId, call_id: randomUUID(), origin, changed_paths: ['target.py'], change_digest: await digestChangedPaths(root, ['target.py']) });
  return { root, store, engine, event };
}

const command = (id, script, timeout_ms = 10000) => ({ id, argv: [process.execPath, '-e', script], cwd: '.', timeout_ms });

test('successful validation captures separate stdout and stderr, persists and deduplicates receipt', async () => {
  const { store, engine, event } = await fixture([command('ok', "process.stdout.write('out');process.stderr.write('err')")]);
  const change = await event();
  const receipt = await engine.onChange(change);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.checks[0].reason, 'success');
  assert.equal(receipt.checks[0].output.length, 2);
  assert.equal((await store.readVerified(receipt.checks[0].output[0].handle)).buffer.toString(), 'out');
  assert.equal((await store.readVerified(receipt.checks[0].output[1].handle)).buffer.toString(), 'err');
  assert.deepEqual(await engine.onChange(change), receipt);
  assert.deepEqual(await new ValidationEngine(store, { schema_version: 1, rules: engine.rules }).onChange(change), receipt);
  assert.equal(JSON.parse((await store.readVerified(receipt.evidence_handle)).buffer.toString()).status, 'passed');
});

test('failed command preserves status and skips later checks', async () => {
  const { engine, event } = await fixture([command('bad', 'process.exit(7)'), command('later', 'process.exit(0)')]);
  const receipt = await engine.onChange(await event());
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.checks[0].exit_code, 7);
  assert.equal(receipt.checks[0].reason, 'nonzero_exit');
  assert.equal(receipt.checks[1].status, 'skipped');
  assert.equal(receipt.checks[1].reason, 'prior_failure');
});

test('validation-origin event is skipped and input changes are stale', async () => {
  const { root, engine, event } = await fixture([command('mutates', "require('fs').writeFileSync('target.py','print(2)\\n')")]);
  const skipped = await engine.onChange(await event('validation'));
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'validation_origin');
  const stale = await engine.onChange(await event());
  assert.equal(stale.status, 'stale');
  assert.equal(stale.reason, 'input_changed');
  assert.equal(await readFile(join(root, 'target.py'), 'utf8'), 'print(2)\n');
});

test('timed-out command is reported and following command does not run', async () => {
  const { engine, event } = await fixture([command('hang', 'setInterval(() => {}, 1000)', 150), command('later', 'process.exit(0)')]);
  const receipt = await engine.onChange(await event());
  assert.equal(receipt.status, 'timeout');
  assert.equal(receipt.checks[0].status, 'timeout');
  assert.equal(receipt.checks[1].status, 'skipped');
});

test('unmatched changes skip rules and declared generated files do not stale validation', async () => {
  const { root, store, engine, event } = await fixture([command('produces', "require('fs').writeFileSync('generated.pyc','cache')")]);
  const unmatched = { ...await event(), changed_paths: ['notes.txt'] };
  unmatched.change_digest = await digestChangedPaths(root, unmatched.changed_paths);
  const noRule = await engine.onChange(unmatched);
  assert.equal(noRule.status, 'skipped');
  assert.equal(noRule.reason, 'no_rule');
  const generatedEngine = new ValidationEngine(store, { schema_version: 1, rules: engine.rules }, { generated: ['**/*.pyc'] });
  const checked = await generatedEngine.onChange(await event());
  assert.equal(checked.status, 'passed');
});

test('receipt storage failure is explicit and never reported as passed', async () => {
  const { store, engine, event } = await fixture([command('ok', 'process.exit(0)')]);
  store.beginCapture = async () => { throw new Error('disk unavailable'); };
  const receipt = await engine.onChange(await event());
  assert.equal(receipt.status, 'error');
  assert.equal(receipt.reason, 'storage');
  assert.equal(receipt.evidence_handle, null);
});

test('re-delivering an event does not execute its command again', async () => {
  const counterRoot = await mkdtemp(join(tmpdir(), 'codex-sol-count-'));
  const counter = join(counterRoot, 'runs');
  const script = `require('fs').appendFileSync(${JSON.stringify(counter)},'x')`;
  const { engine, event } = await fixture([command('count', script)]);
  const change = await event();
  assert.equal((await engine.onChange(change)).status, 'passed');
  assert.equal((await engine.onChange(change)).status, 'passed');
  assert.equal(await readFile(counter, 'utf8'), 'x');
});

test('timeout kills a spawned descendant before it can write later', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-sol-tree-'));
  const marker = join(root, 'late-marker');
  const childScript = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 800)`;
  const parentScript = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const fixtureData = await fixture([command('tree', parentScript, 200)]);
  const receipt = await fixtureData.engine.onChange(await fixtureData.event());
  assert.equal(receipt.status, 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('cancellation records interrupted instead of passed and keeps partial output', async () => {
  const { engine, event, store } = await fixture([command('long', "process.stdout.write('started',()=>require('fs').writeFileSync('.codex/sol/cancel-ready','ready'));setInterval(()=>{},1000)", 10000)]);
  const controller = new AbortController();
  const checked = engine.onChange(await event(), { signal: controller.signal });
  try {
    // Cancel a running command with real output, regardless of hashing/startup time.
    const deadline = Date.now() + 5000;
    while (!(await readFile(join(store.solRoot, 'cancel-ready'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }))) {
      assert.ok(Date.now() < deadline, 'The check did not emit its startup output.');
      await delay(10);
    }
    controller.abort();
    const receipt = await checked;
    assert.equal(receipt.status, 'error');
    assert.equal(receipt.reason, 'interrupted');
    assert.equal(receipt.checks[0].reason, 'interrupted');
    assert.equal(receipt.checks[0].output[0].complete, false);
    assert.equal((await store.readVerified(receipt.checks[0].output[0].handle)).buffer.toString(), 'started');
  } finally { controller.abort(); await checked; }
});

test('missing executable is an error and does not run later checks', async () => {
  const { engine, event } = await fixture([{ id: 'missing', argv: ['codex-sol-no-such-command'], cwd: '.', timeout_ms: 1000 }, command('later', 'process.exit(0)')]);
  const receipt = await engine.onChange(await event());
  assert.equal(receipt.status, 'error');
  assert.equal(receipt.checks[0].status, 'error');
  assert.match(receipt.checks[0].reason, /^runner_error:/);
  assert.equal(receipt.checks[1].status, 'skipped');
});
