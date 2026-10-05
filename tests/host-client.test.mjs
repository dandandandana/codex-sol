import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startAppServer } from '../fixtures/host/app-server-client.mjs';

const peerScript = String.raw`
const { createInterface } = require('node:readline');
const input = createInterface({ input: process.stdin });
let holdOpen = false;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.on('end', () => { if (!holdOpen) process.exit(0); });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, 'id')) {
    send({ method: 'peer/notification', params: { method: message.method, payload: message.params } });
    return;
  }
  if (message.method === 'emit') {
    send({ method: 'peer/notification', params: { token: message.params.token } });
    send({ id: message.id, result: { sent: true } });
    return;
  }
  if (message.method === 'fail') {
    send({ id: message.id, error: { code: -32001, message: 'synthetic failure' } });
    return;
  }
  if (message.method === 'delayed') {
    send({ method: 'peer/started', params: {} });
    setTimeout(() => send({ id: message.id, result: { late: true } }), 40);
    return;
  }
  if (message.method === 'hang') {
    holdOpen = true;
    setInterval(() => {}, 1000);
    send({ method: 'peer/ready', params: {} });
    return;
  }
  if (message.method === 'malformed') {
    holdOpen = true;
    setInterval(() => {}, 1000);
    process.stdout.write('not-json\n');
    return;
  }
  if (message.method === 'server-request') {
    holdOpen = true;
    setInterval(() => {}, 1000);
    send({ id: 999, method: 'server/call', params: {} });
    return;
  }
  if (message.method === 'exit') process.exit(7);
  if (message.method === 'never') return;
  send({ id: message.id, result: message.params ?? null });
});
`;

function peer(t, options = {}) {
  const client = startAppServer({ executable: process.execPath, cwd: tmpdir(), args: ['-e', peerScript], ...options });
  t.after(() => client.close());
  return client;
}

test('requests, outgoing notifications and existing/future notification waits', async (t) => {
  const client = peer(t);
  assert.deepEqual(await client.request('echo', { value: 7 }), { value: 7 });

  client.notify('client/ping', { token: 'first' });
  const first = await client.waitFor((message) => message.method === 'peer/notification', { after: 0, timeoutMs: 2000 });
  assert.equal(first.params.method, 'client/ping');
  assert.equal(first.params.payload.token, 'first');

  const after = client.notifications.length;
  const future = client.waitFor((message) => message.params?.token === 'later', { after, timeoutMs: 2000 });
  assert.deepEqual(await client.request('emit', { token: 'later' }), { sent: true });
  const later = await future;
  assert.equal(later.method, 'peer/notification');
  assert.ok(client.notifications.every((message) => Object.hasOwn(message, 'method') && !Object.hasOwn(message, 'id')
    && !Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')));
});

test('JSON-RPC error responses reject only their request and are not notifications', async (t) => {
  const client = peer(t);
  await assert.rejects(client.request('fail', {}), (error) => error.name === 'AppServerRpcError'
    && error.code === -32001 && error.rpcCode === -32001 && error.message === 'synthetic failure');
  assert.equal(client.notifications.length, 0);
  assert.deepEqual(await client.request('echo', { stillUsable: true }), { stillUsable: true });
});

test('request and notification waits honor individual timeouts and AbortSignal', async (t) => {
  const client = peer(t, { requestTimeoutMs: 5000 });
  const controller = new AbortController();
  const cancelled = client.waitFor(() => false, { signal: controller.signal, timeoutMs: 5000 });
  controller.abort('caller stopped waiting');
  await assert.rejects(cancelled, (error) => error.code === 'ABORT_ERR');

  const requestController = new AbortController();
  const cancelledRequest = client.request('delayed', {}, { signal: requestController.signal, timeoutMs: 5000 });
  await client.waitFor((message) => message.method === 'peer/started', { timeoutMs: 2000 });
  requestController.abort('caller cancelled request');
  await assert.rejects(cancelledRequest, (error) => error.code === 'ABORT_ERR');
  await delay(60); // A late response for a cancelled request must not corrupt the next call.
  await assert.rejects(client.waitFor(() => false, { timeoutMs: 15 }), (error) => error.code === 'APP_SERVER_TIMEOUT');
  await assert.rejects(client.request('never', {}, { timeoutMs: 15 }), (error) => error.code === 'APP_SERVER_TIMEOUT');
  assert.deepEqual(await client.request('echo', { afterTimeout: true }), { afterTimeout: true });
});

test('child exit rejects an outstanding request', async (t) => {
  const client = peer(t);
  await assert.rejects(client.request('exit', {}), (error) => error.code === 'APP_SERVER_CLOSED');
  await client.close();
});

test('malformed JSON and server-initiated requests fail pending calls and never enter notifications', async (t) => {
  for (const method of ['malformed', 'server-request']) {
    const client = peer(t);
    const trigger = client.request(method, {});
    const outstanding = client.request('never', {});
    await Promise.all([
      assert.rejects(trigger, (error) => error.code === 'APP_SERVER_PROTOCOL'),
      assert.rejects(outstanding, (error) => error.code === 'APP_SERVER_PROTOCOL'),
    ]);
    assert.deepEqual(client.notifications, []);
    await client.close();
  }
});

test('close is idempotent, rejects waiters promptly and terminates its own child tree', async (t) => {
  const client = peer(t, { requestTimeoutMs: 60_000 });
  const pending = client.request('hang', {}, { timeoutMs: 60_000 });
  await client.waitFor((message) => message.method === 'peer/ready', { timeoutMs: 2000 });
  const waiter = client.waitFor(() => false, { after: client.notifications.length, timeoutMs: 60_000 });
  const closing = client.close();
  await assert.rejects(pending, (error) => error.code === 'APP_SERVER_CLOSED');
  await assert.rejects(waiter, (error) => error.code === 'APP_SERVER_CLOSED');
  await closing;
  await client.close();
  await assert.rejects(client.request('echo', {}), (error) => error.code === 'APP_SERVER_CLOSED');
  assert.throws(() => client.notify('late/notification'), (error) => error.code === 'APP_SERVER_CLOSED');
  await assert.rejects(client.waitFor(() => true), (error) => error.code === 'APP_SERVER_CLOSED');
});
