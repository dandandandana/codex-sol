import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const CLOSE_GRACE_MS = 300;

function clientError(code, message, cause) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function aborted(signal) {
  const reason = signal?.reason;
  const error = reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'Operation was aborted.');
  error.code ??= 'ABORT_ERR';
  return error;
}

function timeoutValue(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a finite non-negative number.`);
  return value;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Launch a private stdio App Server child. Requests and notifications are sent
 * only to that process; received notifications stay in this object's memory and
 * are never printed or persisted. The caller owns closing the child.
 */
export function startAppServer({ executable, cwd, args = [], requestTimeoutMs = 30_000 }) {
  if (typeof executable !== 'string' || !executable) throw new TypeError('executable must be a non-empty string.');
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('cwd must be a non-empty string.');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('args must be an array of strings.');
  timeoutValue(requestTimeoutMs, 'requestTimeoutMs');

  const child = spawn(executable, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32', shell: false });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  const waiters = new Set();
  const retiredIds = new Set();
  const notifications = [];
  let nextId = 0;
  let terminalError = null;
  let closing = false;
  let closed = false;
  let closePromise = null;
  let resolveChildClosed;
  const childClosed = new Promise((resolve) => { resolveChildClosed = resolve; });

  // Stderr is intentionally drained and discarded; it may contain user or host data.
  child.stderr.resume();

  function settleRequest(id, error, value, retire = false) {
    const slot = pending.get(id);
    if (!slot) return;
    pending.delete(id);
    clearTimeout(slot.timer);
    if (slot.signal && slot.abort) slot.signal.removeEventListener('abort', slot.abort);
    if (retire) retiredIds.add(id);
    if (error) slot.reject(error);
    else slot.resolve(value);
  }

  function settleWaiter(waiter, error, value) {
    if (!waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
    if (error) waiter.reject(error);
    else waiter.resolve(value);
  }

  function rejectOutstanding(error) {
    for (const id of [...pending.keys()]) settleRequest(id, error, undefined, true);
    for (const waiter of [...waiters]) settleWaiter(waiter, error);
  }

  function failTransport(error) {
    if (terminalError) return;
    terminalError = error;
    rejectOutstanding(error);
  }

  function protocolFailure(message) {
    failTransport(clientError('APP_SERVER_PROTOCOL', message));
  }

  function checkWaiters(notification, index) {
    for (const waiter of [...waiters]) {
      if (index < waiter.after) continue;
      try {
        if (waiter.predicate(notification)) settleWaiter(waiter, null, notification);
      } catch (error) {
        settleWaiter(waiter, error);
      }
    }
  }

  function receive(line) {
    if (terminalError || closing || closed) return;
    let message;
    try { message = JSON.parse(line); }
    catch { return protocolFailure('App Server emitted malformed JSON on stdout.'); }
    if (!isObject(message) || (message.jsonrpc !== undefined && message.jsonrpc !== '2.0'))
      return protocolFailure('App Server emitted an invalid JSON-RPC message.');

    const hasId = Object.hasOwn(message, 'id');
    const hasMethod = Object.hasOwn(message, 'method');
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');

    if (hasMethod) {
      if (hasId) return protocolFailure('Server-initiated requests are unsupported by this client.');
      if (typeof message.method !== 'string' || !message.method || hasResult || hasError)
        return protocolFailure('App Server emitted an invalid notification.');
      if (message.params !== undefined && message.params !== null && !isObject(message.params) && !Array.isArray(message.params))
        return protocolFailure('App Server notification params must be an object or array.');
      const index = notifications.push(message) - 1;
      checkWaiters(message, index);
      return;
    }

    if (!hasId || hasResult === hasError || typeof message.id !== 'number' || !Number.isSafeInteger(message.id))
      return protocolFailure('App Server emitted an invalid response.');

    if (hasError && (!isObject(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string'))
      return protocolFailure('App Server emitted an invalid JSON-RPC error response.');

    const slot = pending.get(message.id);
    if (!slot) {
      if (retiredIds.delete(message.id)) return; // A timed-out or cancelled request replied late.
      return protocolFailure('App Server replied with an unknown request id.');
    }
    if (hasError) {
      const error = clientError(message.error.code, message.error.message);
      error.data = message.error.data;
      error.rpcCode = message.error.code;
      error.name = 'AppServerRpcError';
      settleRequest(message.id, error);
    } else {
      settleRequest(message.id, null, message.result);
    }
  }

  function usableError() {
    if (terminalError) return terminalError;
    if (closing || closed) return clientError('APP_SERVER_CLOSED', 'App Server client is closed.');
    return null;
  }

  function encode(message) {
    const text = JSON.stringify(message);
    if (typeof text !== 'string') throw new TypeError('JSON-RPC message could not be serialized.');
    return `${text}\n`;
  }

  function send(message) {
    const error = usableError();
    if (error) throw error;
    const frame = encode(message);
    if (!child.stdin.writable || child.stdin.destroyed) throw clientError('APP_SERVER_CLOSED', 'App Server input is closed.');
    child.stdin.write(frame, (writeError) => { if (writeError) failTransport(clientError('APP_SERVER_IO', 'Could not write to App Server stdin.', writeError)); });
  }

  lines.on('line', receive);
  lines.on('error', (error) => failTransport(clientError('APP_SERVER_IO', 'Could not read App Server stdout.', error)));
  child.stdout.on('error', (error) => failTransport(clientError('APP_SERVER_IO', 'Could not read App Server stdout.', error)));
  child.stderr.on('error', (error) => failTransport(clientError('APP_SERVER_IO', 'Could not drain App Server stderr.', error)));
  child.stdin.on('error', (error) => failTransport(clientError('APP_SERVER_IO', 'Could not write to App Server stdin.', error)));
  child.once('error', (error) => failTransport(clientError('APP_SERVER_PROCESS', 'Could not start or manage the App Server child.', error)));
  child.once('close', () => {
    closed = true;
    lines.close();
    rejectOutstanding(terminalError ?? clientError('APP_SERVER_CLOSED', 'App Server child exited.'));
    resolveChildClosed();
  });

  function request(method, params, { signal, timeoutMs = requestTimeoutMs } = {}) {
    if (typeof method !== 'string' || !method) return Promise.reject(new TypeError('method must be a non-empty string.'));
    try { timeoutValue(timeoutMs, 'timeoutMs'); }
    catch (error) { return Promise.reject(error); }
    const unavailable = usableError();
    if (unavailable) return Promise.reject(unavailable);
    if (signal?.aborted) return Promise.reject(aborted(signal));

    const id = ++nextId;
    const message = { id, method, ...(params === undefined ? {} : { params }) };
    let frame;
    try { frame = encode(message); }
    catch (error) { return Promise.reject(error); }

    return new Promise((resolve, reject) => {
      const slot = { resolve, reject, signal, timer: null, abort: null };
      pending.set(id, slot);
      if (signal) {
        slot.abort = () => settleRequest(id, aborted(signal), undefined, true);
        signal.addEventListener('abort', slot.abort, { once: true });
        if (signal.aborted) {
          slot.abort();
          return;
        }
      }
      slot.timer = setTimeout(() => settleRequest(id,
        clientError('APP_SERVER_TIMEOUT', `App Server request timed out: ${method}`), undefined, true), timeoutMs);
      try {
        if (!child.stdin.writable || child.stdin.destroyed) throw clientError('APP_SERVER_CLOSED', 'App Server input is closed.');
        child.stdin.write(frame, (writeError) => { if (writeError) failTransport(clientError('APP_SERVER_IO', 'Could not write to App Server stdin.', writeError)); });
      } catch (error) {
        failTransport(error.code ? error : clientError('APP_SERVER_IO', 'Could not write to App Server stdin.', error));
      }
    });
  }

  function notify(method, params) {
    if (typeof method !== 'string' || !method) throw new TypeError('method must be a non-empty string.');
    send({ method, ...(params === undefined ? {} : { params }) });
  }

  function waitFor(predicate, { after = 0, signal, timeoutMs = 30_000 } = {}) {
    if (typeof predicate !== 'function') return Promise.reject(new TypeError('predicate must be a function.'));
    if (!Number.isSafeInteger(after) || after < 0) return Promise.reject(new TypeError('after must be a non-negative notification index.'));
    try { timeoutValue(timeoutMs, 'timeoutMs'); }
    catch (error) { return Promise.reject(error); }
    const unavailable = usableError();
    if (unavailable) return Promise.reject(unavailable);
    if (signal?.aborted) return Promise.reject(aborted(signal));

    for (let index = after; index < notifications.length; index += 1) {
      try {
        if (predicate(notifications[index])) return Promise.resolve(notifications[index]);
      } catch (error) { return Promise.reject(error); }
    }

    return new Promise((resolve, reject) => {
      const waiter = { predicate, after, signal, resolve, reject, timer: null, abort: null };
      waiters.add(waiter);
      if (signal) {
        waiter.abort = () => settleWaiter(waiter, aborted(signal));
        signal.addEventListener('abort', waiter.abort, { once: true });
        if (signal.aborted) {
          waiter.abort();
          return;
        }
      }
      waiter.timer = setTimeout(() => settleWaiter(waiter,
        clientError('APP_SERVER_TIMEOUT', 'Timed out while waiting for an App Server notification.')), timeoutMs);
    });
  }

  function waitForClose(timeoutMs) {
    if (closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      childClosed.then(() => { clearTimeout(timer); resolve(true); });
    });
  }

  async function killOwnedTree() {
    if (closed || child.pid === undefined) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true, shell: false });
      const result = await new Promise((resolve, reject) => {
        killer.once('error', reject);
        killer.once('close', (code, signal) => resolve({ code, signal }));
      });
      if (result.code !== 0 && !closed && child.exitCode === null && child.signalCode === null)
        throw clientError('APP_SERVER_TERMINATE', 'Could not terminate the App Server process tree.');
      return;
    }

    try { process.kill(-child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (await waitForClose(CLOSE_GRACE_MS)) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      if (!closed) child.kill('SIGKILL');
    }
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    rejectOutstanding(clientError('APP_SERVER_CLOSED', 'App Server client was closed.'));
    closePromise = (async () => {
      if (closed) return;
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.end();
      if (await waitForClose(CLOSE_GRACE_MS)) return;
      await killOwnedTree();
      await childClosed;
    })();
    return closePromise;
  }

  return { request, notify, waitFor, notifications, close };
}
