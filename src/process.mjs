import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { SolFault } from './store.mjs';
import { interruptionReason } from './host-cancellation.mjs';

function captureMeta(store, callId, channel, tool) {
  return { schema_version: 1, workspace_id: store.workspaceId, call_id: callId, tool, captured_at: new Date().toISOString(), media_type: 'text/plain; charset=utf-8', encoding: 'utf-8', source_form: 'stream_bytes', channel };
}

async function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((done) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', done); killer.once('exit', done);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export async function runCapturedCommand(store, command, { id = randomUUID(), tool = 'validation', remainingMs = 300000, signal, onRunnerState } = {}) {
  const root = store.workspaceRoot;
  const started = Date.now();
  if (signal?.aborted) return { id, status: 'error', reason: interruptionReason(signal), exit_code: null, duration_ms: 0, output: [] };
  let stdout;
  let stderr;
  const output = [];
  let child;
  let timedOut = false;
  let interrupted = false;
  let spawnError = null;
  let captureError = null;
  let exitCode = null;
  let completion;
  let streams;
  let timer;
  let runnerPrepared = false;
  const onAbort = () => { interrupted = true; if (child) void killTree(child); };
  const timeoutMs = Math.min(command.timeout_ms, remainingMs);
  try {
    const cwd = resolve(root, command.cwd);
    if (cwd !== root && !cwd.startsWith(`${root}${sep}`)) throw new SolFault('PATH_ERROR', 'Command cwd escapes workspace.');
    const actualCwd = await realpath(cwd);
    if (actualCwd !== root && !actualCwd.startsWith(`${root}${sep}`)) throw new SolFault('PATH_ERROR', 'Command cwd points outside workspace.');
    stdout = await store.beginCapture(captureMeta(store, id, 'stdout', tool));
    stderr = await store.beginCapture(captureMeta(store, id, 'stderr', tool));
    if (signal?.aborted) {
      interrupted = true;
      throw new SolFault('INTERRUPTED', 'Command was interrupted before launch.');
    }
    await onRunnerState?.({ state: 'starting', pid: null });
    runnerPrepared = true;
    child = spawn(command.argv[0], command.argv.slice(1), { cwd: actualCwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    completion = new Promise((done) => {
      child.once('error', (error) => { spawnError = error; });
      child.once('close', (code) => { exitCode = code; done(); });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const consume = async (stream, writer) => {
      try { for await (const bytes of stream) await writer.write(bytes); }
      catch (error) { captureError ??= error; await killTree(child); }
    };
    streams = Promise.all([consume(child.stdout, stdout), consume(child.stderr, stderr)]);
    timer = setTimeout(() => { timedOut = true; void killTree(child); }, timeoutMs);
    if (child.pid) await onRunnerState?.({ state: 'running', pid: child.pid });
    await completion;
    await streams;
    if (captureError) throw captureError;
    output.push(await stdout.commit({ complete: !timedOut && !interrupted && !spawnError }));
    output.push(await stderr.commit({ complete: !timedOut && !interrupted && !spawnError }));
  } catch (error) {
    if (child) {
      await killTree(child);
      await completion;
      await streams;
    }
    await Promise.allSettled([stdout?.abort(), stderr?.abort()]);
    if (!spawnError) spawnError = error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (runnerPrepared) await onRunnerState?.({ state: 'idle', pid: null });
  }
  const status = interrupted ? 'error' : spawnError ? 'error' : timedOut ? 'timeout' : exitCode === 0 ? 'passed' : 'failed';
  const reason = interrupted ? interruptionReason(signal) : spawnError ? `runner_error:${spawnError.code ?? spawnError.message}` : timedOut ? 'timeout' : exitCode === 0 ? 'success' : 'nonzero_exit';
  return { id, status, reason, exit_code: exitCode, duration_ms: Date.now() - started, output };
}
