import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { decodeHostTurnMetadata, decodeHostThread, interruptionReason, openHostCancellation } from '../src/host-cancellation.mjs';

test('host shape adapters accept extra fields but reject changed critical identity types safely', () => {
  const threadId = randomUUID();
  const turnId = randomUUID();
  assert.deepEqual(decodeHostTurnMetadata({ 'x-codex-turn-metadata': { thread_id: threadId, turn_id: turnId, extra: 'ignored' } }), { thread_id: threadId, turn_id: turnId });
  const thread = { id: threadId, cwd: os.tmpdir(), path: path.join(os.tmpdir(), 'rollout.jsonl'), extra: 'ignored' };
  assert.deepEqual(decodeHostThread(thread, threadId), { id: threadId, cwd: thread.cwd, path: thread.path });
  assert.throws(() => decodeHostTurnMetadata({ 'x-codex-turn-metadata': { thread_id: { private: 'DO_NOT_EXPOSE' }, turn_id: turnId } }), (error) => error.code === 'HOST_STATE_ERROR' && error.stage === 'metadata' && !error.message.includes('DO_NOT_EXPOSE'));
  assert.throws(() => decodeHostThread({ ...thread, path: ['DO_NOT_EXPOSE'] }, threadId), (error) => error.code === 'HOST_STATE_ERROR' && error.stage === 'thread' && !error.message.includes('DO_NOT_EXPOSE'));
});

const NO_REPLY = Symbol('no reply');
const ok = (result) => ({ result });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeReader extends EventEmitter {
  constructor(respond) {
    super();
    this.respond = respond;
    this.requests = [];
    this.notifications = [];
    this.closed = false;
    this.closeScheduled = false;
    this.stdin = new EventEmitter();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    Object.assign(this.stdin, {
      write: (line, callback) => {
        const message = JSON.parse(String(line));
        if (Object.hasOwn(message, 'id')) {
          this.requests.push(message);
          this.emit('request', message);
          Promise.resolve(this.respond(message)).then((response) => {
            if (response === NO_REPLY || this.closed) return;
            this.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, ...response })}\n`));
          }).catch((error) => this.emit('error', error));
        } else this.notifications.push(message);
        callback?.(null);
        return true;
      },
      end: () => { this.stdinEnded = true; this.scheduleClose(); },
      destroy: () => { this.stdinDestroyed = true; },
    });
    this.stdout.destroy = () => { this.stdoutDestroyed = true; };
    this.stderr.destroy = () => { this.stderrDestroyed = true; };
  }

  kill() {
    this.killCalled = true;
    this.scheduleClose();
    return true;
  }

  scheduleClose() {
    if (this.closeScheduled) return;
    this.closeScheduled = true;
    setImmediate(() => {
      this.closed = true;
      this.emit('close', 0, null);
    });
  }

  waitForRequest(method, timeoutMs = 1000) {
    const existing = this.requests.find((request) => request.method === method);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('request', onRequest);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      const onRequest = (request) => {
        if (request.method !== method) return;
        clearTimeout(timer);
        this.removeListener('request', onRequest);
        resolve(request);
      };
      this.on('request', onRequest);
    });
  }
}

async function makeFixture(t, { text, respond, signal, rpcTimeoutMs = 500, pollMs = 10, thread = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-sol-host-cancel-'));
  const workspaceRoot = path.join(root, 'workspace');
  const rolloutPath = path.join(root, 'rollout.jsonl');
  await mkdir(workspaceRoot);
  const threadId = randomUUID();
  const turnId = randomUUID();
  const initialText = typeof text === 'function' ? text({ threadId, turnId }) : text ?? rollout(threadId, turnId);
  await writeFile(rolloutPath, initialText);

  const state = { child: null, guard: null };
  const fixture = { root, workspaceRoot, rolloutPath, initialText, threadId, turnId, state };
  const defaultRespond = (message) => {
    if (message.method === 'initialize') return ok({});
    if (message.method === 'thread/read') {
      return ok({ thread: { id: threadId, cwd: workspaceRoot, path: rolloutPath, status: 'interrupted', ...thread } });
    }
    assert.fail(`Unexpected host RPC method: ${message.method}`);
  };
  fixture.open = async () => {
    const guard = await openHostCancellation({
      executable: process.execPath,
      workspaceRoot,
      metadata: { 'x-codex-turn-metadata': { thread_id: threadId, turn_id: turnId } },
      signal,
      pollMs,
      rpcTimeoutMs,
      spawnProcess: () => {
        state.child = new FakeReader((message) => respond?.(message, defaultRespond) ?? defaultRespond(message));
        return state.child;
      },
    });
    state.guard = guard;
    return guard;
  };
  t.after(async () => {
    await state.guard?.close();
    if (state.child && !state.child.closed) {
      state.child.kill();
      await new Promise((resolve) => state.child.once('close', resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  return fixture;
}

function rollout(threadId, turnId) {
  return [
    JSON.stringify({ type: 'session_meta', payload: { id: threadId } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }),
    '',
  ].join('\n');
}

function sessionLineAtChunkBoundary(threadId) {
  const prefix = `{"type":"session_meta","payload":{"id":"${threadId}","padding":"`;
  const paddingLength = 64 * 1024 - 1 - Buffer.byteLength(prefix);
  assert.ok(paddingLength > 0);
  return `${prefix}${'x'.repeat(paddingLength)}雪"}}\n`;
}

function waitForAbort(signal, timeoutMs = 1000) {
  if (signal.aborted) return Promise.resolve(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Timed out waiting for cancellation.'));
    }, timeoutMs);
    const onAbort = () => { clearTimeout(timer); resolve(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function assertReaderClosed(child) {
  assert.equal(child.closed, true);
  assert.equal(child.stdinEnded, true);
  assert.equal(child.killCalled, true);
  assert.equal(child.stdinDestroyed, true);
  assert.equal(child.stdoutDestroyed, true);
  assert.equal(child.stderrDestroyed, true);
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.stdin.listenerCount('error'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
}

test('thread status alone does not cancel; split UTF-8 and a partial target event are read safely', async (t) => {
  const controller = new AbortController();
  const fixture = await makeFixture(t, {
    signal: controller.signal,
    pollMs: 10,
    text: ({ threadId, turnId }) => `${sessionLineAtChunkBoundary(threadId)}${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } })}\n`,
  });

  const guard = await fixture.open();
  const child = fixture.state.child;
  assert.equal(guard.signal.aborted, false, 'an app-server interrupted status is not cancellation evidence.');
  assert.deepEqual(child.requests.map((request) => request.method), ['initialize', 'thread/read']);
  assert.deepEqual(child.notifications.map((message) => message.method), ['initialized']);
  assert.equal(child.requests[1].params.threadId, fixture.threadId);
  assert.equal(child.requests[1].params.includeTurns, false);
  assertReaderClosed(child);

  const eventPrefix = `{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"${fixture.turnId}`;
  await appendFile(fixture.rolloutPath, eventPrefix);
  await delay(40);
  assert.equal(guard.signal.aborted, false, 'an incomplete JSONL row must remain pending.');
  await appendFile(fixture.rolloutPath, `"}}\n`);

  const reason = await waitForAbort(guard.signal);
  assert.equal(reason.code, 'INTERRUPTED');
  assert.equal(interruptionReason(guard.signal), 'interrupted');
  await guard.close();
});

test('a turn_aborted event for another turn is ignored', async (t) => {
  const fixture = await makeFixture(t);
  const guard = await fixture.open();
  await appendFile(fixture.rolloutPath, `${JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: randomUUID() } })}\n`);
  await delay(40);
  assert.equal(guard.signal.aborted, false);
  await guard.close();
});

test('invalid thread and rollout evidence fails closed', async (t) => {
  const cases = [
    ['wrong workspace', { cwd: path.resolve(os.tmpdir()) }, undefined],
    ['wrong thread id', { id: randomUUID() }, undefined],
    ['wrong session id', {}, ({ turnId }) => rollout(randomUUID(), turnId)],
    ['missing target task_started', {}, ({ threadId }) => `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`],
    ['malformed rollout JSON', {}, ({ threadId, turnId }) => `${rollout(threadId, turnId)}{"broken":}\n`],
    ['target task_complete', {}, ({ threadId, turnId }) => `${rollout(threadId, turnId)}${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } })}\n`],
  ];

  for (const [label, thread, makeText] of cases) {
    await t.test(label, async (subtest) => {
      const fixture = await makeFixture(subtest, {
        thread,
        text: makeText ? ({ threadId, turnId }) => makeText({ threadId, turnId }) : undefined,
      });
      await assert.rejects(fixture.open(), { code: 'HOST_STATE_ERROR' });
      assertReaderClosed(fixture.state.child);
    });
  }
});

test('RPC errors and timeouts fail closed, while an SDK abort interrupts startup', async (t) => {
  for (const [label, response] of [
    ['RPC failure', () => ({ error: { code: -1, message: 'read failed' } })],
    ['RPC timeout', () => NO_REPLY],
  ]) {
    await t.test(label, async (subtest) => {
      const fixture = await makeFixture(subtest, {
        rpcTimeoutMs: 20,
        respond: (message, fallback) => message.method === 'thread/read' ? response() : fallback(message),
      });
      await assert.rejects(fixture.open(), { code: 'HOST_STATE_ERROR' });
      assertReaderClosed(fixture.state.child);
    });
  }

  await t.test('SDK abort while thread/read is pending', async (subtest) => {
    const controller = new AbortController();
    const fixture = await makeFixture(subtest, {
      signal: controller.signal,
      respond: (message, fallback) => message.method === 'thread/read' ? NO_REPLY : fallback(message),
    });
    const opening = fixture.open();
    const child = fixture.state.child;
    if (!child) assert.fail('The host reader did not start.');
    await child.waitForRequest('thread/read');
    controller.abort(new Error('SDK request cancelled'));
    await assert.rejects(opening, { code: 'INTERRUPTED' });
    assertReaderClosed(child);
  });
});

test('truncation or replacement of the rollout file aborts with HOST_STATE_ERROR', async (t) => {
  for (const mutation of ['truncate', 'replace']) {
    await t.test(mutation, async (subtest) => {
      const fixture = await makeFixture(subtest, { pollMs: 10 });
      const guard = await fixture.open();
      if (mutation === 'truncate') {
        await truncate(fixture.rolloutPath, Buffer.byteLength(fixture.initialText) - 1);
      } else {
        const moved = `${fixture.rolloutPath}.old`;
        await rename(fixture.rolloutPath, moved);
        await writeFile(fixture.rolloutPath, fixture.initialText);
      }
      const reason = await waitForAbort(guard.signal);
      assert.equal(reason.code, 'HOST_STATE_ERROR');
      assert.equal(interruptionReason(guard.signal), 'host_state_error');
      await guard.close();
    });
  }
});

test('rollout files larger than 256 MiB fail closed before scanning', async (t) => {
  const fixture = await makeFixture(t);
  await truncate(fixture.rolloutPath, 256 * 1024 * 1024 + 1);
  await assert.rejects(fixture.open(), { code: 'HOST_STATE_ERROR' });
  assertReaderClosed(fixture.state.child);
});

test('close releases the rollout file and stops polling', async (t) => {
  const fixture = await makeFixture(t, { pollMs: 10 });
  const guard = await fixture.open();
  await guard.close();

  const moved = `${fixture.rolloutPath}.closed`;
  await rename(fixture.rolloutPath, moved);
  await writeFile(fixture.rolloutPath, `${JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: fixture.turnId } })}\n`);
  await delay(40);
  assert.equal(guard.signal.aborted, false, 'close must stop the poll timer.');
});
