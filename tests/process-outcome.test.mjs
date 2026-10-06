import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createObservationStore, SolFault } from '../src/store.mjs';
import { runCapturedCommand, toCheckResult } from '../src/process.mjs';
import { runManagedCommand } from '../src/managed-command.mjs';
import { ValidationEngine } from '../src/validation.mjs';
import { assertContract } from '../src/schema.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sol-process-outcome-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  return { root, store: await createObservationStore(root) };
}

function command(script) {
  return { id: 'outcome', argv: [process.execPath, '-e', script], cwd: '.', timeout_ms: 5000 };
}

test('capture startup failure proves no launch and retains the existing public check shape', async (t) => {
  const { root, store } = await fixture(t);
  store.beginCapture = async () => { throw new SolFault('STORAGE_ERROR', 'Capture unavailable.'); };
  const result = await runCapturedCommand(store, command("require('fs').appendFileSync('marker','x')"));
  assert.equal(result.launch_status, 'not_started');
  assert.equal(result.status, 'error');
  await assert.rejects(readFile(join(root, 'marker')), { code: 'ENOENT' });
  assert.deepEqual(Object.keys(toCheckResult(result)).sort(), ['duration_ms', 'exit_code', 'id', 'output', 'reason', 'status']);
  assertContract('CheckResult', toCheckResult(result));
});

test('output failure after a real file effect never reports that the command did not execute', async (t) => {
  const { root, store } = await fixture(t);
  const begin = store.beginCapture.bind(store);
  store.beginCapture = async (meta) => {
    const writer = await begin(meta);
    if (meta.tool === 'outcome' && meta.channel === 'stdout') await writer.raw.close();
    return writer;
  };
  const validator = new ValidationEngine(store, { schema_version: 1, rules: [] });
  const result = await runManagedCommand(store, validator, command("require('fs').appendFileSync('marker','x');process.stdout.write('trigger');setInterval(()=>{},1000)"), { tool: 'outcome' });
  assert.equal(await readFile(join(root, 'marker'), 'utf8'), 'x');
  assert.equal(result.tool_status, 'error');
  assert.ok(result.changed_paths.includes('marker'));
  assert.match(result.observation.summary, /tool_may_have_executed=true/u);
});

test('stderr commit failure preserves the successful stdout archive and known exit', async (t) => {
  const { root, store } = await fixture(t);
  const begin = store.beginCapture.bind(store);
  store.beginCapture = async (meta) => {
    const writer = await begin(meta);
    if (meta.channel === 'stderr') await writeFile(join(writer.tempDirectory, 'meta.json'), 'commit conflict');
    return writer;
  };
  const result = await runCapturedCommand(store, command("require('fs').appendFileSync('marker','x');process.stdout.write('output')"));
  assert.equal(result.launch_status, 'started');
  assert.equal(result.exit_code, 0);
  assert.equal(result.status, 'error');
  assert.equal(result.capture_error.code, 'STORAGE_ERROR');
  assert.equal(result.output.length, 1);
  assert.equal((await store.readVerified(result.output[0].handle)).buffer.toString(), 'output');
  assert.equal(await readFile(join(root, 'marker'), 'utf8'), 'x');
});

test('idle persistence failure cannot erase closed-child execution and committed outputs', async (t) => {
  const { root, store } = await fixture(t);
  await writeFile(join(root, 'blocker'), 'a file');
  const states = [];
  const result = await runCapturedCommand(store, command("require('fs').appendFileSync('marker','x');process.stdout.write('done')"), {
    onRunnerState: async (runner) => {
      states.push(runner.state);
      if (runner.state === 'idle') await writeFile(join(root, 'blocker', 'owner'), 'cannot persist');
    },
  });
  assert.deepEqual(states, ['starting', 'running', 'idle']);
  assert.equal(result.launch_status, 'started');
  assert.equal(result.exit_code, 0);
  assert.equal(result.status, 'error');
  assert.ok(result.cleanup_error);
  assert.match(result.reason, /^runner_cleanup_error:/u);
  assert.equal(result.output.length, 2);
  assert.equal((await store.readVerified(result.output[0].handle)).buffer.toString(), 'done');
  assert.equal(await readFile(join(root, 'marker'), 'utf8'), 'x');
});

test('cancellation during the persisted starting callback prevents spawn', async (t) => {
  const { root, store } = await fixture(t);
  const controller = new AbortController();
  const result = await runCapturedCommand(store, command("require('fs').appendFileSync('marker','x')"), {
    signal: controller.signal,
    onRunnerState: async ({ state }) => { if (state === 'starting') controller.abort(); },
  });
  assert.equal(result.launch_status, 'not_started');
  assert.equal(result.reason, 'interrupted');
  await assert.rejects(readFile(join(root, 'marker')), { code: 'ENOENT' });
});

test('capture failure and cancellation retain both facts and the committed stdout', async (t) => {
  const { root, store } = await fixture(t);
  const controller = new AbortController();
  const begin = store.beginCapture.bind(store);
  store.beginCapture = async (meta) => {
    const writer = await begin(meta);
    if (meta.tool === 'outcome' && meta.channel === 'stderr') {
      await writeFile(join(writer.tempDirectory, 'meta.json'), 'commit conflict');
      const commit = writer.commit.bind(writer);
      writer.commit = async (...args) => { controller.abort(); return commit(...args); };
    }
    return writer;
  };
  const validator = new ValidationEngine(store, { schema_version: 1, rules: [] });
  const result = await runManagedCommand(store, validator, command("require('fs').appendFileSync('marker','x');process.stdout.write('before-abort')"), { tool: 'outcome', signal: controller.signal });
  assert.equal(result.tool_status, 'error');
  assert.equal(result.execution.reason, 'interrupted');
  assert.equal(result.capture_error.code, 'STORAGE_ERROR');
  assert.equal(result.observation.mode, 'storage_error');
  assert.match(result.observation.summary, /tool_may_have_executed=true/u);
  assert.equal(result.observation.raw.length, 1);
  assert.equal((await store.readVerified(result.observation.raw[0].handle)).buffer.toString(), 'before-abort');
  assert.equal(await readFile(join(root, 'marker'), 'utf8'), 'x');
});
