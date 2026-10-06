import { spawn } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { SolFault } from './store.mjs';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
function fault(stage = 'rollout', cause = 'unverified') {
  const error = new SolFault('HOST_STATE_ERROR', `Could not verify configured Codex cancellation evidence (${stage}:${cause}); managed work was stopped.`);
  error.stage = stage; error.causeCode = cause;
  return error;
}

/** Decode only the identity fields the adapter actually consumes. */
export function decodeHostTurnMetadata(metadata) {
  const target = metadata?.['x-codex-turn-metadata'];
  if (typeof target?.thread_id !== 'string' || typeof target?.turn_id !== 'string'
    || !uuid.test(target.thread_id) || !uuid.test(target.turn_id)) throw fault('metadata', 'invalid_identity');
  return { thread_id: target.thread_id, turn_id: target.turn_id };
}

export function decodeHostThread(thread, threadId) {
  if (!thread || thread.id !== threadId || typeof thread.cwd !== 'string'
    || typeof thread.path !== 'string' || !isAbsolute(thread.cwd) || !isAbsolute(thread.path))
    throw fault('thread', 'invalid_shape');
  return { id: thread.id, cwd: thread.cwd, path: thread.path };
}
export function interruptionReason(signal) {
  return signal?.reason?.code === 'HOST_STATE_ERROR' ? 'host_state_error' : 'interrupted';
}

// A separate app-server interprets unfinished foreign turns as interrupted.
// Use it only to locate the thread; only an explicit rollout event can cancel.
async function readHostThread(executable, threadId, signal, timeoutMs, spawnProcess) {
  const child = spawnProcess(executable, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const pending = new Map();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let sequence = 0;
  let readerError = null;
  let exited = false;
  const rejectPending = (error) => { for (const slot of pending.values()) slot.reject(error); pending.clear(); };
  const fail = (cause = 'transport_failed') => { readerError = fault('thread', typeof cause === 'string' ? cause : 'transport_failed'); rejectPending(readerError); };
  const onExit = () => { exited = true; fail('process_exit'); };
  const onAbort = () => rejectPending(signal.reason ?? fault());
  const onStderr = () => {}; // Do not retain private host diagnostics.
  const onData = (bytes) => {
    buffer += decoder.write(bytes);
    if (Buffer.byteLength(buffer, 'utf8') > 1024 * 1024) { fail('response_limit'); return; }
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { fail('invalid_json'); return; }
      const slot = pending.get(message.id);
      if (!slot) continue;
      pending.delete(message.id);
      if (message.error || !Object.hasOwn(message, 'result')) slot.reject(fault('thread', 'rpc_failed'));
      else slot.resolve(message.result);
    }
  };
  child.once('error', fail); child.once('close', onExit);
  child.stdin.on('error', fail); child.stdout.on('data', onData); child.stderr.on('data', onStderr);
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => fail('rpc_timeout'), timeoutMs);
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (readerError || signal.aborted) { reject(readerError ?? signal.reason ?? fault()); return; }
    const id = ++sequence; pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => { if (error) fail(); });
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'codex-sol-cancellation-reader', version: '0.1.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const { thread } = await rpc('thread/read', { threadId, includeTurns: false });
    return thread;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', onAbort);
    rejectPending(fault()); child.stdin.end();
    if (!exited) {
      let cleanupTimer;
      let onCleanupExit;
      const exit = new Promise((done) => { onCleanupExit = done; child.once('close', onCleanupExit); });
      child.kill();
      await Promise.race([exit, new Promise((done) => { cleanupTimer = setTimeout(done, 1000); })]);
      clearTimeout(cleanupTimer); child.removeListener('close', onCleanupExit);
      if (!exited) child.kill('SIGKILL');
    }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    child.removeListener('error', fail); child.removeListener('close', onExit);
    child.stdin.removeListener('error', fail); child.stdout.removeListener('data', onData); child.stderr.removeListener('data', onStderr);
  }
}

// Optional adapter for Codex hosts that omit notifications/cancelled. No thread
// start/resume, inference, global configuration or synthetic MCP notification.
export async function openHostCancellation({ executable, workspaceRoot, metadata, signal, pollMs = 500, rpcTimeoutMs = 5000, spawnProcess = spawn }) {
  if (!executable) return { signal, close: async () => {} };
  if (!isAbsolute(executable)) throw new SolFault('CONFIG_ERROR', 'CODEX_SOL_HOST_EXECUTABLE must be an absolute executable path.');
  const target = decodeHostTurnMetadata(metadata);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  if (combined.aborted) return { signal: combined, close: async () => {} };
  let file;
  let closed = false;
  let poll;
  let scanning;
  let closing;
  let offset = 0;
  let pendingLine = '';
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(64 * 1024);
  let sessionVerified = false;
  let targetStarted = false;
  const close = () => closing ??= (async () => {
    closed = true; clearTimeout(poll); combined.removeEventListener('abort', onAbort);
    await scanning?.catch(() => {});
    await file?.close();
  })();
  const onAbort = () => { void close().catch(() => {}); };
  const scan = async (path, identity) => {
    const current = await stat(path);
    if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino || current.size < offset || current.size > 256 * 1024 * 1024) throw fault('rollout', 'file_changed');
    while (offset < current.size && !closed && !combined.aborted) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, current.size - offset), offset);
      if (!bytesRead) throw fault('rollout', 'unexpected_end');
      offset += bytesRead;
      pendingLine += decoder.write(buffer.subarray(0, bytesRead));
      for (;;) {
        const end = pendingLine.indexOf('\n');
        if (end < 0) break;
        const line = pendingLine.slice(0, end); pendingLine = pendingLine.slice(end + 1);
        let record;
        try { record = JSON.parse(line); } catch { throw fault('rollout', 'invalid_json'); }
        if (record.type === 'session_meta') {
          if (record.payload?.id !== target.thread_id) throw fault('rollout', 'wrong_session');
          sessionVerified = true;
        } else if (record.type === 'event_msg' && record.payload?.turn_id === target.turn_id) {
          if (record.payload.type === 'task_started') targetStarted = true;
          else if (record.payload.type === 'turn_aborted') controller.abort(new SolFault('INTERRUPTED', 'Codex turn was interrupted.'));
          else if (record.payload.type === 'task_complete') throw fault('rollout', 'turn_finished');
        }
        if (combined.aborted) break;
      }
      if (Buffer.byteLength(pendingLine, 'utf8') > 2 * 1024 * 1024) throw fault('rollout', 'line_limit');
    }
  };
  try {
    const thread = decodeHostThread(await readHostThread(executable, target.thread_id, combined, rpcTimeoutMs, spawnProcess), target.thread_id);
    const [hostRoot, configuredRoot, path] = await Promise.all([realpath(thread.cwd), realpath(workspaceRoot), realpath(thread.path)]);
    const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(hostRoot) !== normalize(configuredRoot)) throw fault('thread', 'wrong_workspace');
    file = await open(path, 'r');
    const identity = await file.stat();
    scanning = scan(path, identity); await scanning;
    if (!sessionVerified || !targetStarted) throw fault('rollout', 'identity_not_started');
    combined.addEventListener('abort', onAbort, { once: true });
    if (combined.aborted) await close();
    else {
      const tick = async () => {
        if (closed || combined.aborted) return;
        try { scanning = scan(path, identity); await scanning; if (!closed && !combined.aborted) poll = setTimeout(tick, pollMs); }
        catch (error) { if (!closed) controller.abort(error instanceof SolFault ? error : fault('rollout', 'read_failed')); }
      };
      poll = setTimeout(tick, pollMs);
    }
    return { signal: combined, close };
  } catch (error) {
    await close();
    throw signal?.aborted ? new SolFault('INTERRUPTED', 'MCP request was interrupted.') : error instanceof SolFault ? error : fault();
  }
}

export async function withHostCancellation(store, options, context, action) {
  const guard = await openHostCancellation({ executable: options.hostExecutable, workspaceRoot: store.workspaceRoot, metadata: context.mcpReq._meta, signal: context.mcpReq.signal });
  try { return await action(guard.signal); }
  finally { await guard.close(); }
}
