import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSolServer } from '../src/server.mjs';
import { runManagedCommand } from '../src/managed-command.mjs';
import { fingerprintOf } from '../vendor/normify/engine/store.js';
import { startMcpServer } from './helpers/mcp-client.mjs';

const example = JSON.parse(await readFile(new URL('../context.example.json', import.meta.url), 'utf8'));
const task = { id: 'escape-task', goal: 'Escape angle brackets with the existing helper.' };
const initialSource = 'export const escapeHtml = (text) => String(text);\n';
const changedSource = 'export const escapeHtml = (text) => String(text).replaceAll("<", "&lt;");\n';
const driftSource = `${changedSource}export const externalDrift = true;\n`;
const marker = '.codex/sol/runner-marker';
const rules = { schema_version: 1, rules: [{ schema_version: 1, id: 'core', globs: ['src/core.mjs'],
  watch_paths: ['src/core.mjs'], commands: [{ id: 'guard', argv: [process.execPath, '-e',
    `const fs=require('node:fs');const p=${JSON.stringify(marker)};fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1))`], cwd: '.', timeout_ms: 5000 }] }] };

async function fixture(t, { architecture = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sol-context-change-'));
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'README.md'), 'Escape angle brackets in generated markup.\n');
  await writeFile(join(root, 'src/core.mjs'), initialSource);
  await writeFile(join(root, 'outside.mjs'), 'export const outside = true;\n');
  const module = (id, uid, parent, source, fingerprint) => ({ id, uid, parent,
    name: { zh: id, en: id }, description: { zh: '职责', en: 'Responsibility' }, source, fingerprint,
    revision: '0'.repeat(40), updated_at: '2026-10-04T00:00:00Z',
    ...(source.length ? { apis: [{ protocol: 'rpc', path: 'escapeHtml', description: { zh: '转义', en: 'Escaping' } }] } : {}) });
  if (architecture) {
    const source = [{ path: 'src/core.mjs' }];
    const manifest = { schema_version: 1, modules: [module('demo', '00000001', null, [], 'pending'),
      module('demo.core', '00000002', 'demo', source, (await fingerprintOf(root, source)).hash)],
      policy: { schema_version: 1, updated_at: '2026-10-04T00:00:00Z', rules: [] } };
    await writeFile(join(root, 'architecture.json'), JSON.stringify(manifest));
  }
  const context = structuredClone(example);
  if (architecture) context.architecture = { path: 'architecture.json' };
  await writeFile(join(root, 'context.json'), JSON.stringify(context));
  await writeFile(join(root, 'rules.json'), JSON.stringify(rules));
  const service = await createSolServer(root, rules, { contextRulesPath: join(root, 'context.json'), rulesPath: join(root, 'rules.json') });
  const { contextEngine: engine, changesEngine: changes, store, validator } = service;
  const args = { task, requirement_ref: 'README.md: escaping requirement',
    scope: [{ path: 'src/core.mjs', module_uid: '00000002' }],
    acceptance: ['The existing escapeHtml export escapes angle brackets.'], reuse: { decision: 'extend',
      reason: 'Keep escaping in the existing helper.', query_handle: 'a'.repeat(24), capability: { uid: '00000002', symbol: 'escapeHtml' } } };
  const query = async () => engine.architectureQuery({ paths: ['src/core.mjs'], capability: 'escapeHtml' });
  const open = async (extra = {}) => {
    const current = await query();
    return changes.open({ ...args, ...extra, expected_architecture_version: current.version,
      reuse: { ...args.reuse, query_handle: current.raw.handle, ...(extra.reuse ?? {}) } });
  };
  const adjust = async (binding, extra = {}) => open({ ...extra, change: binding });
  const start = async () => {
    const client = startMcpServer({ workspace: root, rulesPath: join(root, 'rules.json'), env: {
      CODEX_SOL_CONTEXT_RULES: join(root, 'context.json'), CODEX_SOL_HOST_EXECUTABLE: '' } });
    clients.push(client);
    await client.initialize();
    return client;
  };
  return { root, engine, changes, store, validator, args, open, adjust, start };
}

function prepareInput(extra = {}) {
  return { task, role: 'plan', targets: ['src/core.mjs'], ...extra };
}

function submitInput(packet) {
  return { context_handle: packet.raw.handle, task_id: packet.task.id, role: packet.role.id,
    version: packet.version, output: { plan: 'Keep escaping in the existing helper.', constraints: [], unresolved: [] } };
}

test('Context source metadata and freshness include ordinary POSIX mode independently of a bound change', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t); const sourcePath = join(f.root, 'src/core.mjs');
  const originalMode = (await stat(sourcePath)).mode & 0o777;
  const packet = await f.engine.prepare(prepareInput());
  const source = packet.sources.find((item) => item.path === 'src/core.mjs');
  assert.equal(source.mode, originalMode);
  const archives = await observations(f.store);
  await chmod(sourcePath, originalMode === 0o755 ? 0o644 : 0o755);
  await assert.rejects(f.engine.submit(submitInput(packet)), { code: 'CONTEXT_STALE' });
  assert.deepEqual(await observations(f.store), archives);
  const renewed = await f.engine.prepare(prepareInput());
  assert.equal(renewed.sources.find((item) => item.path === 'src/core.mjs').mode, originalMode === 0o755 ? 0o644 : 0o755);
  assert.notEqual(renewed.version, packet.version);
});

const fault = (promise, code) => assert.rejects(promise, (error) => error.code === code);

async function observations(store) {
  const result = new Map();
  for (const entry of await readdir(store.observationsRoot)) {
    if (entry.startsWith('.')) continue;
    const meta = JSON.parse(await readFile(join(store.observationsRoot, entry, 'meta.json'), 'utf8'));
    result.set(entry, meta.tool);
  }
  return result;
}

function reviewOutput(context) {
  const source = (path) => context.sources.find((item) => item.path === path && item.raw)?.raw.handle;
  const declaration = source('architecture.json');
  const checks = context.plan.rules.flatMap((rule) => rule.check_ids);
  return { method: 'self_review', modules: context.maintenance.affected_uids.map((uid) => {
    const current = context.architecture.tree.find((item) => item.uid === uid);
    const currentSource = current?.source.map((item) => source(item.path)).find(Boolean) ?? declaration;
    const prior = context.before_sources.find((item) => item.raw && context.maintenance.suggestions.some((suggestion) =>
      suggestion.module_uid === uid && suggestion.path === item.path))?.raw.handle;
    return { uid, disposition: current ? 'preserved' : 'removed', contract_refs: prior ? [currentSource, prior] : [currentSource],
      evidence_handles: [currentSource], rationale: 'Reviewed the current declaration and captured implementation.', unresolved: [] };
  }), acceptance: context.acceptance.map((_, index) => ({ index,
    evidence_handles: [source('src/core.mjs') ?? declaration], check_ids: checks,
    rationale: 'The captured source implements the registered behavior and the listed checks cover it.', unresolved: [] })),
  uncovered: context.maintenance.uncovered.map((item, index) => {
    const refs = [source(item.path), ...context.before_sources.filter((prior) => prior.path === item.path && prior.raw).map((prior) => prior.raw.handle), declaration].filter(Boolean);
    return { index, evidence_handles: [...new Set(refs)],
      rationale: 'Reviewed this uncovered relationship against the captured source and declaration.', unresolved: [] };
  }), checks_not_applicable: context.checks_not_applicable_paths.map((path) => ({ path, evidence_handles: [source(path) ?? declaration],
    rationale: 'This documentation path does not add executable behavior.' })), unresolved: [] };
}

test('bound projection follows explicit identity and targets never enlarge registered scope', async (t) => {
  const f = await fixture(t);
  const opened = await f.open();
  const packet = await f.engine.prepare(prepareInput({ change: opened.change, targets: ['src/core.mjs', 'outside.mjs'] }));
  const state = packet.change_state;
  assert.equal(packet.capabilities.change_state, 'bound');
  assert.equal(state.availability, 'bound');
  assert.deepEqual(state.change, opened.change);
  assert.equal(state.task_id, task.id);
  assert.equal(state.state, 'open');
  assert.equal(state.scope_count, opened.scope_count);
  assert.deepEqual(state.selected_scope, [
    { path: 'src/core.mjs', in_scope: true, module_uid: '00000002' },
    { path: 'outside.mjs', in_scope: false },
  ]);
  assert.deepEqual(state.blocking, { count: 0, codes: [] });
  assert.equal(state.latest_validation, null);
  assert.deepEqual(state.review, { ref: null, validity: 'absent' });
  assert.deepEqual(state.completion, { ref: null, validity: 'absent' });
  assert.equal(state.raw.handle, opened.raw.handle);
  assert.equal(state.needs_status_refresh, false);
  assert.equal(state.task_complete, false);
  assert.match(state.next, /sol_change_review/u);
  assert.match(state.version, /^[a-f0-9]{64}$/u);
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 4096);
  assert.ok(packet.sources.some((source) => source.path === 'outside.mjs'));
  const archived = await f.engine.stored(packet.raw.handle, 'sol_context_prepare', 'context_record');
  assert.deepEqual(archived.change_state, state);

  // A corrupt active pointer proves the unbound path does not read the workspace task.
  const pointer = join(f.root, '.codex', 'sol', 'architecture', 'active-change.json');
  const corrupt = Buffer.from('{invalid pointer');
  await writeFile(pointer, corrupt);
  const unbound = await f.engine.prepare(prepareInput());
  assert.equal(unbound.capabilities.change_state, 'not_bound');
  assert.equal(Object.hasOwn(unbound, 'change_state'), false);
  assert.deepEqual(await readFile(pointer), corrupt);
});

test('a legacy unbound Context record keeps its original fields and fingerprint when submitted', async (t) => {
  const f = await fixture(t);
  const packet = await f.engine.prepare(prepareInput());
  const current = await f.engine.stored(packet.raw.handle, 'sol_context_prepare', 'context_record');
  assert.equal(Object.hasOwn(current, 'change_state'), false);
  const originalVersion = current.version;
  const legacy = structuredClone(current);
  legacy.capabilities.change_state = 'unavailable';
  const legacyRaw = await f.engine.archive(legacy, 'sol_context_prepare');
  const legacyPacket = { ...packet, raw: legacyRaw };

  const receipt = await f.engine.submit(submitInput(legacyPacket));
  assert.equal(receipt.accepted, true);
  const reread = await f.engine.stored(legacyRaw.handle, 'sol_context_prepare', 'context_record');
  assert.equal(reread.version, originalVersion);
  assert.equal(reread.capabilities.change_state, 'unavailable');
  assert.equal(Object.hasOwn(reread, 'change_state'), false);
});

test('identity, goal and binding errors are explicit; plain Context stays unavailable', async (t) => {
  const f = await fixture(t);
  const opened = await f.open();
  await fault(f.engine.prepare(prepareInput({ change: { id: randomUUID(), version: opened.change.version } })), 'CHANGE_NOT_CURRENT');
  await fault(f.engine.prepare(prepareInput({ change: { ...opened.change, version: '0'.repeat(64) } })), 'CHANGE_VERSION');
  await fault(f.engine.prepare(prepareInput({ change: opened.change, task: { ...task, id: 'other-task' } })), 'TASK_MISMATCH');
  await fault(f.engine.prepare(prepareInput({ change: opened.change, task: { ...task, goal: 'A different goal.' } })), 'TASK_MISMATCH');

  const plain = await fixture(t, { architecture: false });
  const packet = await plain.engine.prepare(prepareInput());
  assert.equal(packet.capabilities.change_state, 'unavailable');
  assert.equal(Object.hasOwn(packet, 'change_state'), false);
  await fault(plain.engine.prepare(prepareInput({ change: { id: randomUUID(), version: '0'.repeat(64) } })), 'CHANGE_UNAVAILABLE');
});

test('oversized bound identity fails with CONTEXT_BUDGET and leaves the active pointer unchanged', async (t) => {
  const f = await fixture(t);
  const largeTask = { id: task.id, goal: 'g'.repeat(768), constraints: Array.from({ length: 8 }, () => 'c'.repeat(256)) };
  const opened = await f.open({ task: { id: largeTask.id, goal: largeTask.goal } });
  const pointer = join(f.root, '.codex', 'sol', 'architecture', 'active-change.json');
  const beforePointer = await readFile(pointer);

  await fault(f.engine.prepare(prepareInput({ task: largeTask, change: opened.change })), 'CONTEXT_BUDGET');
  assert.deepEqual(await readFile(pointer), beforePointer);
});

test('scope and acceptance changes stale bound Context while an unbound plan remains consumable', async (t) => {
  const f = await fixture(t);
  const opened = await f.open();
  const oldAcceptance = await f.engine.prepare(prepareInput({ change: opened.change }));
  const oldUnbound = await f.engine.prepare(prepareInput());
  const afterAcceptance = await f.adjust(opened.change, { acceptance: ['The helper still escapes angle brackets and preserves other characters.'] });
  await fault(f.engine.submit(submitInput(oldAcceptance)), 'CONTEXT_STALE');
  const unboundArtifact = await f.engine.submit(submitInput(oldUnbound));
  assert.equal(unboundArtifact.accepted, true);

  const oldScope = await f.engine.prepare(prepareInput({ change: afterAcceptance.change }));
  const beforeScopeUnbound = await f.engine.prepare(prepareInput());
  const afterScope = await f.adjust(afterAcceptance.change, { scope: [...f.args.scope, { path: 'README.md', module_uid: '00000001' }] });
  await fault(f.engine.submit(submitInput(oldScope)), 'CONTEXT_STALE');
  const scopeIndependentArtifact = await f.engine.submit(submitInput(beforeScopeUnbound));
  const consumer = await f.engine.prepare({ task, role: 'implement', targets: ['src/core.mjs'],
    upstream_handle: scopeIndependentArtifact.raw.handle, change: afterScope.change });
  assert.equal(consumer.status, 'ready');
  assert.equal(consumer.capabilities.change_state, 'bound');
});

test('a plan prepared against an old bound version cannot be handed to the current change', async (t) => {
  const f = await fixture(t);
  const opened = await f.open();
  const packet = await f.engine.prepare(prepareInput({ change: opened.change }));
  const artifact = await f.engine.submit(submitInput(packet));
  const current = await f.adjust(opened.change, { acceptance: ['Only angle brackets are escaped by the existing helper.'] });
  await fault(f.engine.prepare({ task, role: 'implement', targets: ['src/core.mjs'],
    upstream_handle: artifact.raw.handle, change: current.change }), 'CONTEXT_STALE');
});

test('review submission invalidates an older bound Context packet', async (t) => {
  const f = await fixture(t);
  const opened = await f.open();
  const packet = await f.engine.prepare(prepareInput({ change: opened.change }));
  const reviewPacket = await f.changes.review({ change: opened.change, phase: 'prepare' });
  const reviewContext = await f.engine.stored(reviewPacket.raw.handle, 'sol_change_review_context', 'change_review_context');
  const reviewed = await f.changes.review({ change: opened.change, phase: 'submit',
    review_context_handle: reviewPacket.raw.handle, review: reviewOutput(reviewContext) });
  assert.equal(reviewed.accepted, true);
  await fault(f.engine.submit(submitInput(packet)), 'CONTEXT_STALE');
});

test('source drift returns the durable binding and does not publish change state or run checks', async (t) => {
  const f = await fixture(t);
  const opened = await f.open();
  const write = await f.changes.run(opened.change, ['src/core.mjs'], (lease) => runManagedCommand(f.store, f.validator,
    { id: 'fixture-edit', argv: [process.execPath, '-e',
      `require('node:fs').writeFileSync('src/core.mjs',${JSON.stringify(changedSource)})`], cwd: '.', timeout_ms: 5000 },
    { paths: ['src/core.mjs'], lease }));
  assert.equal(write.tool_status, 'ok');
  assert.equal(await readFile(join(f.root, marker), 'utf8'), '1');
  const pointer = join(f.root, '.codex', 'sol', 'architecture', 'active-change.json');
  const beforePointer = await readFile(pointer);
  const beforeObservations = await observations(f.store);
  await writeFile(join(f.root, 'src/core.mjs'), driftSource);
  const packet = await f.engine.prepare(prepareInput({ change: write.change.change }));
  const state = packet.change_state;
  assert.deepEqual(state.change, write.change.change);
  assert.equal(state.raw.handle, write.change.raw.handle);
  assert.equal(state.state, 'dirty');
  assert.equal(state.needs_status_refresh, true);
  assert.ok(state.blocking.codes.includes('CHANGE_STATUS_REFRESH'));
  assert.equal(state.task_complete, false);
  assert.equal(state.latest_validation.interpretation, 'historical_only');
  assert.equal(state.latest_validation.status, 'passed');
  assert.deepEqual(await readFile(pointer), beforePointer);
  const afterObservations = await observations(f.store);
  const additions = [...afterObservations].filter(([handle]) => !beforeObservations.has(handle));
  assert.ok(additions.length > 0);
  assert.ok(additions.every(([, tool]) => tool.startsWith('sol_context_')), JSON.stringify(additions));
  assert.equal([...beforeObservations.values()].filter((tool) => tool === 'sol_change_record').length,
    [...afterObservations.values()].filter((tool) => tool === 'sol_change_record').length);
  assert.equal(await readFile(join(f.root, marker), 'utf8'), '1');
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 4096);
});

test('real STDIO exposes thirteen tools and accepts a change binding in prepare and recall', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const opened = await f.open();
  const client = await f.start();
  const listed = await client.request('tools/list');
  assert.equal(listed.result.tools.length, 13);
  const response = await client.request('tools/call', { name: 'sol_context_prepare', arguments: prepareInput({ change: opened.change }) });
  assert.equal(response.result?.isError, false, response.result?.content?.[0]?.text);
  const text = response.result.content[0].text;
  assert.ok(Buffer.byteLength(text) <= 4096);
  const packet = JSON.parse(text);
  assert.deepEqual(packet.change_state.change, opened.change);

  let cursor;
  let recalled = '';
  do {
    const pageResponse = await client.request('tools/call', { name: 'sol_recall', arguments: {
      handle: packet.raw.handle, selector: { kind: 'lines', start: 1, end: 1 }, ...(cursor ? { cursor } : {}) } });
    assert.equal(pageResponse.result?.isError, false, pageResponse.result?.content?.[0]?.text);
    const page = JSON.parse(pageResponse.result.content[0].text);
    recalled += page.chunks.map((chunk) => chunk.text).join('');
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(JSON.parse(recalled).change_state, packet.change_state);
});
