import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 5000;

export class McpCancellationError extends Error {
  constructor(requestId, reason) {
    super(reason ? `MCP request ${requestId} was cancelled: ${reason}` : `MCP request ${requestId} was cancelled.`);
    this.name = 'McpCancellationError';
    this.code = 'INTERRUPTED';
    this.requestId = requestId;
  }
}

function processClose(child) {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function terminateTree(child, waitForClose) {
  if (child.exitCode !== null || child.signalCode !== null) return waitForClose;

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  }
  return waitForClose;
}

export function startMcpServer({ workspace, rulesPath, serverPath = fileURLToPath(new URL('../../src/server.mjs', import.meta.url)), serverArgs = [], env = {} }) {
  const child = spawn(process.execPath, [serverPath, ...serverArgs], {
    cwd: workspace,
    env: { ...process.env, CODEX_SOL_WORKSPACE: workspace, CODEX_SOL_RULES: rulesPath, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  const protocolErrors = [];
  let nextId = 0;
  let stderr = '';
  let closed = false;
  let closeResult;
  const waitForClose = processClose(child);

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  function rejectPending(error) {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(error);
      pending.delete(id);
    }
  }

  child.once('exit', (code, signal) => {
    const error = new Error(`MCP server exited before replying (code=${code}, signal=${signal}).${stderr ? ` stderr: ${stderr}` : ''}`);
    rejectPending(error);
  });
  child.stdin.on('error', (error) => rejectPending(error));
  child.once('close', (code, signal) => {
    closed = true;
    closeResult = { code, signal };
    lines.close();
    rejectPending(new Error(`MCP server closed before replying (code=${code}, signal=${signal}).${stderr ? ` stderr: ${stderr}` : ''}`));
  });

  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch (error) {
      protocolErrors.push(new Error(`Invalid JSON-RPC line: ${line}`, { cause: error }));
      return;
    }
    if (message.id === undefined || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    clearTimeout(request.timer);
    pending.delete(message.id);
    request.resolve(message);
  });

  function send(message) {
    if (closed || child.stdin.destroyed) throw new Error('MCP server stdin is closed.');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function beginRequest(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (closed || child.exitCode !== null || child.signalCode !== null) {
      return { id: null, promise: Promise.reject(new Error('MCP server is not running.')) };
    }
    const id = ++nextId;
    let resolveResponse;
    let rejectResponse;
    const promise = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectResponse(new Error('MCP request ' + method + ' (id=' + id + ') timed out after ' + timeoutMs + ' ms.'));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer, method });
    try { send({ jsonrpc: '2.0', id, method, params }); }
    catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      rejectResponse(error);
    }
    return { id, promise };
  }

  return {
    child,
    get stderr() { return stderr; },
    get protocolErrors() { return [...protocolErrors]; },
    beginRequest,
    request(method, params = {}, options) { return beginRequest(method, params, options).promise; },
    notify(method, params = {}) { send({ jsonrpc: '2.0', method, params }); },
    cancel(requestId, reason = 'test cancellation') {
      send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason } });
      const request = pending.get(requestId);
      if (request) {
        clearTimeout(request.timer);
        pending.delete(requestId);
        request.reject(new McpCancellationError(requestId, reason));
      }
    },
    async initialize({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      const response = await this.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'codex-sol-test', version: '0.1.0' },
      }, { timeoutMs });
      if (!response.result) throw new Error(`MCP initialization failed: ${JSON.stringify(response)}${stderr ? ` stderr: ${stderr}` : ''}`);
      this.notify('notifications/initialized');
      return response;
    },
    async waitForClose() {
      return closed ? closeResult : waitForClose;
    },
    async terminateTree() {
      await terminateTree(child, waitForClose);
      return waitForClose;
    },
    async close({ gracefulMs = 1000 } = {}) {
      if (closed) return closeResult;
      if (!child.stdin.destroyed) child.stdin.end();
      const graceful = await Promise.race([waitForClose.then((result) => ({ result })), delay(gracefulMs).then(() => null)]);
      if (graceful) return graceful.result;
      await terminateTree(child, waitForClose);
      return waitForClose;
    },
  };
}
