import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcpServer } from './helpers/mcp-client.mjs';
import { createObservationStore, SolFault } from '../src/store.mjs';
import { withWorkspaceLock } from '../src/workspace-lock.mjs';

const SERVER_TIMEOUT_MS = 8000;

function validationConfig(timeoutMs = 12000) {
  const script = [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const dir=path.join(process.cwd(),'.codex','sol','test-state');",
    'fs.mkdirSync(dir,{recursive:true});',
    "const counter=path.join(dir,'runs');",
    "const run=(Number(fs.existsSync(counter)?fs.readFileSync(counter,'utf8'):0)||0)+1;",
    "fs.writeFileSync(counter,String(run));",
    "fs.writeFileSync(path.join(dir,'started-'+run),String(process.pid));",
    'let finished=false;',
    "const finish=()=>{if(finished)return;finished=true;fs.writeFileSync(path.join(dir,'finished-'+run),'yes');process.exit(0)};",
    "if(run<=2){const release=path.join(dir,run===1?'release-first':'release-second');const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);finish()}},10)}else finish();",
  ].join('');
  return {
    schema_version: 1,
    rules: [{
      schema_version: 1,
      id: 'txt',
      globs: ['**/*.txt'],
      watch_paths: ['**/*'],
      commands: [{ id: 'slow-once', argv: [process.execPath, '-e', script], cwd: '.', timeout_ms: timeoutMs }],
    }],
  };
}

async function createWorkspace() {
  const workspace = await mkdtemp(join(tmpdir(), 'codex-sol-failure-'));
  const rulesPath = join(workspace, 'rules.json');
  await writeFile(rulesPath, JSON.stringify(validationConfig()));
  return { workspace, rulesPath };
}

function statePath(workspace, name) {
  return join(workspace, '.codex', 'sol', 'test-state', name);
}

async function exists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

async function waitForFile(path, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(path)) return;
    await delay(15);
  }
  throw new Error('Timed out waiting for file handshake: ' + path);
}

async function waitForRunningReceipt(workspace, timeoutMs = 4000) {
  const receiptRoot = join(workspace, '.codex', 'sol', 'receipts');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = await readdir(receiptRoot).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const name = names.find((entry) => entry.endsWith('.running'));
    if (name) {
      const path = join(receiptRoot, name);
      try {
        const text = await readFile(path, 'utf8');
        return { path, text, value: JSON.parse(text) };
      } catch (error) {
        if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error;
      }
    }
    await delay(15);
  }
  throw new Error('Timed out waiting for the running validation receipt.');
}

async function acknowledgePriorCall(client) {
  const response = await client.request('tools/list', {}, { timeoutMs: 3000 });
  assert.ok(response.result?.tools, 'tools/list failed: ' + JSON.stringify(response) + ' ' + client.stderr);
}

function expectInterrupted(error) {
  assert.ok(error instanceof Error, 'cancelled request did not settle with an error');
  assert.equal(error.code, 'INTERRUPTED', String(error));
}

async function finishSlowValidation(workspace) {
  await Promise.all(['release-first', 'release-second'].map((name) => writeFile(statePath(workspace, name), 'release').catch(() => {})));
}

async function stopProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (!(await isProcessAlive(pid))) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
    return;
  }
  try { process.kill(pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

async function waitForProcessExit(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessAlive(pid))) return;
    await delay(15);
  }
  throw new Error('Timed out waiting for validator process ' + pid + ' to exit.');
}

async function waitForProcessAlive(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isProcessAlive(pid)) return;
    await delay(15);
  }
  throw new Error('Timed out waiting for validator process ' + pid + ' to remain alive.');
}

async function waitForRunningOwner(workspace, timeoutMs = 4000) {
  const path = join(workspace, '.codex', 'sol', 'managed-modification.owner.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const owner = JSON.parse(await readFile(path, 'utf8'));
      if (owner.runner?.state === 'running' && Number.isSafeInteger(owner.runner.pid)) return { path, owner };
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(15);
  }
  throw new Error('Timed out waiting for the running validator PID to be recorded.');
}

async function stopValidationProcesses(workspace) {
  const directory = join(workspace, '.codex', 'sol', 'test-state');
  const names = await readdir(directory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  await Promise.all(names.filter((name) => /^started-\d+$/u.test(name)).map(async (name) => {
    const pid = Number(await readFile(join(directory, name), 'utf8'));
    await stopProcess(pid);
  }));
}

test('workspace lock cancellation interrupts a blocked acquisition and permits the next owner', { timeout: 10000 }, async (t) => {
  const { workspace } = await createWorkspace();
  const store = await createObservationStore(workspace);
  let releaseHeld;
  let notifyAcquired;
  const heldGate = new Promise((resolve) => { releaseHeld = resolve; });
  const acquired = new Promise((resolve) => { notifyAcquired = resolve; });
  const ownerTask = withWorkspaceLock(store, async () => {
    notifyAcquired();
    await heldGate;
    return 'released';
  });
  t.after(async () => {
    releaseHeld();
    await ownerTask.catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  });
  await acquired;

  const controller = new AbortController();
  const waiter = withWorkspaceLock(store, async () => {
    throw new Error('cancelled lock waiter must not run');
  }, { signal: controller.signal });
  const waiterResult = waiter.then(
    () => ({ unexpectedSuccess: true }),
    (error) => ({ error }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const cancelStarted = Date.now();
  controller.abort('test cancellation');
  const cancelled = await Promise.race([
    waiterResult,
    delay(1000).then(() => ({ timedOut: true })),
  ]);
  assert.equal(cancelled.timedOut, undefined, 'lock acquisition cancellation must settle promptly');
  assert.ok(cancelled.error instanceof SolFault);
  assert.equal(cancelled.error.code, 'INTERRUPTED');
  assert.ok(Date.now() - cancelStarted < 1000);

  releaseHeld();
  assert.equal(await ownerTask, 'released');
  assert.equal(await withWorkspaceLock(store, async () => 'acquired'), 'acquired');
});

test('same-workspace servers serialize modifications and cancel cross-process and same-process waiters', { timeout: 15000 }, async (t) => {
  const { workspace, rulesPath } = await createWorkspace();
  const first = startMcpServer({ workspace, rulesPath });
  const second = startMcpServer({ workspace, rulesPath });
  t.after(async () => {
    await finishSlowValidation(workspace).catch(() => {});
    await Promise.all([first.close(), second.close()]);
    await stopValidationProcesses(workspace);
    await rm(workspace, { recursive: true, force: true });
  });
  await Promise.all([first.initialize(), second.initialize()]);

  const active = first.beginRequest('tools/call', {
    name: 'sol_apply_changes',
    arguments: { changes: [{ action: 'write', path: 'active.txt', content: 'active' }] },
  }, { timeoutMs: SERVER_TIMEOUT_MS });
  await waitForFile(statePath(workspace, 'started-1'));

  const serial = second.beginRequest('tools/call', {
    name: 'sol_apply_changes',
    arguments: { changes: [{ action: 'write', path: 'serial.txt', content: 'serial' }] },
  }, { timeoutMs: SERVER_TIMEOUT_MS });
  await acknowledgePriorCall(second);
  assert.equal(await exists(join(workspace, 'serial.txt')), false, 'the second server must wait while the first validation is active');
  assert.equal(await exists(statePath(workspace, 'started-2')), false, 'the second validation must not overlap the first');

  await writeFile(statePath(workspace, 'release-first'), 'release');
  await waitForFile(statePath(workspace, 'started-2'));
  const activeResponse = await active.promise;
  const activeValue = JSON.parse(activeResponse.result.content[0].text);
  assert.equal(activeValue.validation.status, 'passed');
  assert.equal(await readFile(statePath(workspace, 'runs'), 'utf8'), '2');

  const waiting = first.beginRequest('tools/call', {
    name: 'sol_apply_changes',
    arguments: { changes: [{ action: 'write', path: 'cancelled-lock.txt', content: 'must not exist' }] },
  }, { timeoutMs: SERVER_TIMEOUT_MS });
  await acknowledgePriorCall(first);
  const queued = first.beginRequest('tools/call', {
    name: 'sol_apply_changes',
    arguments: { changes: [{ action: 'write', path: 'cancelled-queue.txt', content: 'must not exist' }] },
  }, { timeoutMs: SERVER_TIMEOUT_MS });
  await acknowledgePriorCall(first);
  const cancellationStarted = Date.now();
  first.cancel(waiting.id);
  first.cancel(queued.id);
  const [waitingError, queuedError] = await Promise.all([
    waiting.promise.catch((error) => error),
    queued.promise.catch((error) => error),
  ]);
  assert.ok(Date.now() - cancellationStarted < 2000, 'both cancelled requests should finish promptly');
  expectInterrupted(waitingError);
  expectInterrupted(queuedError);
  await acknowledgePriorCall(first);
  assert.equal(await exists(join(workspace, 'cancelled-lock.txt')), false);
  assert.equal(await exists(join(workspace, 'cancelled-queue.txt')), false);

  await writeFile(statePath(workspace, 'release-second'), 'release');
  const serialResponse = await serial.promise;
  const serialValue = JSON.parse(serialResponse.result.content[0].text);
  assert.equal(serialValue.validation.status, 'passed');
  await waitForFile(statePath(workspace, 'finished-2'));
  const postCancel = first.beginRequest('tools/call', {
    name: 'sol_apply_changes',
    arguments: { changes: [{ action: 'write', path: 'after-cancel.txt', content: 'runs after cancellation' }] },
  }, { timeoutMs: SERVER_TIMEOUT_MS });
  await acknowledgePriorCall(first);
  const postCancelResponse = await postCancel.promise;
  const postCancelValue = JSON.parse(postCancelResponse.result.content[0].text);
  assert.equal(postCancelValue.validation.status, 'passed');
  assert.equal(await readFile(statePath(workspace, 'runs'), 'utf8'), '3');
  assert.equal(await exists(join(workspace, 'cancelled-lock.txt')), false);
  assert.equal(await exists(join(workspace, 'cancelled-queue.txt')), false);
});

test('a new server recovers a dead process lock without replaying its running validation', { timeout: 15000 }, async (t) => {
  const { workspace, rulesPath } = await createWorkspace();
  const crashed = startMcpServer({ workspace, rulesPath });
  const recovered = startMcpServer({ workspace, rulesPath });
  t.after(async () => {
    await finishSlowValidation(workspace).catch(() => {});
    await Promise.all([crashed.close(), recovered.close()]);
    await stopValidationProcesses(workspace);
    await rm(workspace, { recursive: true, force: true });
  });
  await Promise.all([crashed.initialize(), recovered.initialize()]);

  const oldRequest = crashed.beginRequest('tools/call', {
    name: 'sol_apply_changes',
    arguments: { changes: [{ action: 'write', path: 'interrupted.txt', content: 'old' }] },
  }, { timeoutMs: SERVER_TIMEOUT_MS });
  const oldResponse = oldRequest.promise.catch((error) => error);
  await waitForFile(statePath(workspace, 'started-1'));
  const running = await waitForRunningReceipt(workspace);
  const validatorPid = Number(await readFile(statePath(workspace, 'started-1'), 'utf8'));
  assert.ok(running.value.event_id);
  const oldEventReceipt = JSON.parse(running.text);

  await crashed.terminateTree();
  await stopProcess(validatorPid);
  await waitForProcessExit(validatorPid);
  const processResult = await oldResponse;
  assert.ok(processResult instanceof Error, 'the killed server must reject its pending request');

  const recoveredRequest = recovered.beginRequest('tools/call', {
    name: 'sol_apply_changes',
    arguments: { changes: [{ action: 'write', path: 'recovered.txt', content: 'new' }] },
  }, { timeoutMs: SERVER_TIMEOUT_MS });
  await waitForFile(statePath(workspace, 'started-2'));
  assert.equal(await readFile(statePath(workspace, 'runs'), 'utf8'), '2');
  await writeFile(statePath(workspace, 'release-second'), 'release');
  const recoveredResponse = await recoveredRequest.promise;
  assert.ok(recoveredResponse.result, 'recovered tools/call failed: ' + JSON.stringify(recoveredResponse) + ' ' + recovered.stderr);
  const result = JSON.parse(recoveredResponse.result.content[0].text);
  assert.equal(result.tool_status, 'ok');
  assert.equal(result.validation.status, 'passed');
  assert.equal(await readFile(join(workspace, 'recovered.txt'), 'utf8'), 'new');
  assert.equal(await readFile(statePath(workspace, 'runs'), 'utf8'), '2', 'recovery must run only the new event validation');
  await waitForFile(statePath(workspace, 'finished-2'));

  const preserved = await readFile(running.path, 'utf8');
  assert.equal(preserved, running.text, 'the prior running receipt marker must remain available');
  assert.deepEqual(JSON.parse(preserved), oldEventReceipt);
  assert.equal(oldEventReceipt.event_id, running.value.event_id);
  assert.equal(await exists(statePath(workspace, 'finished-1')), false, 'the interrupted validation must not be replayed');
});

test('a recorded live runner keeps the workspace locked until it exits', { timeout: 15000 }, async (t) => {
  const { workspace, rulesPath } = await createWorkspace();
  let deadOwner;
  let runner;
  const waiter = startMcpServer({ workspace, rulesPath });
  t.after(async () => {
    await finishSlowValidation(workspace).catch(() => {});
    await writeFile(statePath(workspace, 'external-runner-release'), 'release').catch(() => {});
    await waiter.close();
    await stopProcess(runner?.pid);
    await stopProcess(deadOwner?.pid);
    await stopValidationProcesses(workspace);
    await rm(workspace, { recursive: true, force: true });
  });
  const store = await createObservationStore(workspace);
  const stateDirectory = statePath(workspace, 'external-runner-started');
  await mkdir(join(workspace, '.codex', 'sol', 'test-state'), { recursive: true });
  deadOwner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const deadOwnerClosed = new Promise((resolve) => deadOwner.once('close', resolve));
  await waitForProcessAlive(deadOwner.pid);

  const runnerScript = [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const dir=path.join(process.cwd(),'.codex','sol','test-state');",
    "fs.writeFileSync(path.join(dir,'external-runner-started'),String(process.pid));",
    "const timer=setInterval(()=>{if(fs.existsSync(path.join(dir,'external-runner-release'))){clearInterval(timer);fs.writeFileSync(path.join(dir,'external-runner-finished'),'yes')}},10)",
  ].join('');
  runner = spawn(process.execPath, ['-e', runnerScript], {
    cwd: workspace,
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  await waitForFile(stateDirectory);
  const runnerPid = Number(await readFile(stateDirectory, 'utf8'));
  assert.equal(runner.pid, runnerPid);
  await waitForProcessAlive(runnerPid);

  deadOwner.kill('SIGKILL');
  await deadOwnerClosed;
  await waitForProcessExit(deadOwner.pid);
  const ownerPath = join(store.solRoot, 'managed-modification.owner.json');
  const ownerRecord = {
    schema_version: 1,
    token: randomUUID(),
    pid: deadOwner.pid,
    acquired_at: new Date().toISOString(),
    runner: { state: 'running', pid: runnerPid },
  };
  await writeFile(ownerPath, JSON.stringify(ownerRecord));
  const registered = await waitForRunningOwner(workspace);
  assert.deepEqual(registered.owner, ownerRecord);

  const blocked = waiter.beginRequest('tools/call', {
    name: 'sol_apply_changes',
    arguments: { changes: [{ action: 'write', path: 'blocked.txt', content: 'must not exist' }] },
  }, { timeoutMs: SERVER_TIMEOUT_MS });
  const blockedResult = blocked.promise.catch((error) => error);
  await acknowledgePriorCall(waiter);
  assert.equal(await exists(join(workspace, 'blocked.txt')), false);
  assert.equal(await isProcessAlive(runnerPid), true, 'the registered runner must stay alive while the new server waits');

  waiter.cancel(blocked.id);
  expectInterrupted(await blockedResult);
  await acknowledgePriorCall(waiter);
  assert.equal(await exists(join(workspace, 'blocked.txt')), false);

  await writeFile(statePath(workspace, 'external-runner-release'), 'release');
  await waitForFile(statePath(workspace, 'external-runner-finished'));
  await waitForProcessExit(runnerPid);

  const resumed = waiter.beginRequest('tools/call', {
    name: 'sol_apply_changes',
    arguments: { changes: [{ action: 'write', path: 'after-runner-exit.txt', content: 'new' }] },
  }, { timeoutMs: SERVER_TIMEOUT_MS });
  await acknowledgePriorCall(waiter);
  await waitForFile(statePath(workspace, 'started-1'));
  await writeFile(statePath(workspace, 'release-first'), 'release');
  const resumedResponse = await resumed.promise;
  assert.ok(resumedResponse.result, 'new modification failed after the runner exited: ' + JSON.stringify(resumedResponse) + ' ' + waiter.stderr);
  const resumedValue = JSON.parse(resumedResponse.result.content[0].text);
  assert.equal(resumedValue.tool_status, 'ok');
  assert.equal(resumedValue.validation.status, 'passed');
  assert.equal(await readFile(join(workspace, 'after-runner-exit.txt'), 'utf8'), 'new');
  assert.equal(await readFile(statePath(workspace, 'runs'), 'utf8'), '1');
  assert.equal(await exists(join(workspace, 'blocked.txt')), false);
});
