import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createObservationStore } from '../src/store.mjs';
import { ContextEngine } from '../src/architecture/context.mjs';
import { ChangeCoordinator } from '../src/architecture/change.mjs';
import { fingerprintOf } from '../vendor/normify/engine/store.js';
import { startMcpServer } from './helpers/mcp-client.mjs';

const example = JSON.parse(await readFile(new URL('../context.example.json', import.meta.url)));
const initialSource = 'export const escapeHtml = (text) => String(text);\n';
const modifiedSource = 'export const escapeHtml = (text) => String(text).replaceAll("<", "&lt;");\n';
async function fixture(t, rules = { schema_version: 1, rules: [] }, generated = []) {
  const root = await mkdtemp(join(tmpdir(), 'sol-change-'));
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src/html.mjs'), initialSource);
  await writeFile(join(root, 'README.md'), 'Managed change fixture.\n');
  const source = [{ path: 'src/html.mjs' }];
  const module = (id, uid, files, fingerprint) => ({ id, uid, parent: id === 'demo' ? null : 'demo',
    name: { zh: id, en: id }, description: { zh: '职责', en: 'Responsibility' }, source: files,
    fingerprint, revision: '0'.repeat(40), updated_at: '2026-10-03T00:00:00Z' });
  const manifest = { schema_version: 1, modules: [module('demo', '00000001', [], 'pending'),
    { ...module('demo.html', '00000002', source, (await fingerprintOf(root, source)).hash),
      apis: [{ protocol: 'rpc', path: 'escapeHtml', description: { zh: '转义', en: 'Escape HTML' } }] }],
    policy: { schema_version: 1, updated_at: '2026-10-03T00:00:00Z', rules: [] } };
  await writeFile(join(root, 'architecture.json'), JSON.stringify(manifest));
  const config = structuredClone(example); config.architecture = { path: 'architecture.json' };
  await writeFile(join(root, 'context.json'), JSON.stringify(config)); await writeFile(join(root, 'rules.json'), JSON.stringify(rules));
  const store = await createObservationStore(root);
  const engine = await new ContextEngine(store, 'context.json').initialize();
  const changes = new ChangeCoordinator(engine, rules, { generated });
  const start = async (extra = {}) => {
    const client = startMcpServer({ workspace: root, rulesPath: join(root, 'rules.json'), env: {
      CODEX_SOL_CONTEXT_RULES: join(root, 'context.json'), CODEX_SOL_HOST_EXECUTABLE: '',
      CODEX_SOL_GENERATED_PATHS: JSON.stringify(generated), ...extra } });
    clients.push(client); await client.initialize(); return client;
  };
  const query = await engine.architectureQuery({ paths: ['src/html.mjs'], capability: 'escapeHtml' });
  const args = { task: { id: 'escaping', goal: 'Extend existing escaping.' }, requirement_ref: 'README.md: escaping requirement',
    scope: [{ path: 'src/html.mjs', module_uid: '00000002' }, { path: 'architecture.json', module_uid: '00000001' }, { path: 'missing.txt', module_uid: '00000001' }],
    acceptance: ['Preserve the existing export and escape angle brackets.'], expected_architecture_version: query.version,
    reuse: { decision: 'extend', reason: 'Existing HTML helper owns escaping.', query_handle: query.raw.handle, capability: { uid: '00000002', symbol: 'escapeHtml' } } };
  return { root, store, engine, changes, args, start, manifest };
}
async function call(client, name, args = {}, error = false) {
  const response = await client.request('tools/call', { name, arguments: args }, { timeoutMs: 15000 });
  assert.ok(response.result, JSON.stringify(response));
  assert.equal(response.result.isError, error, response.result.content[0].text);
  return JSON.parse(response.result.content[0].text);
}
const fault = (promise, code) => assert.rejects(promise, (error) => error.code === code);
async function waitForMarker(root) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { if (await readFile(join(root, '.codex/sol/runner-marker'), 'utf8') === 'ready') return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  assert.fail('Validator did not start.');
}
const slowRules = { schema_version: 1, rules: [{ schema_version: 1, id: 'source', globs: ['src/**'], watch_paths: ['src/**'],
  commands: [{ id: 'wait', argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(".codex/sol/runner-marker", "ready"); setTimeout(() => {}, 10000);'], cwd: '.', timeout_ms: 15000 }] }] };

test('registration requires current query, valid ownership and a justified verified reuse candidate', async (t) => {
  const { root, changes, args } = await fixture(t);
  assert.equal((await changes.status()).state, 'none');
  await fault(changes.open({ ...args, expected_architecture_version: 'f'.repeat(64) }), 'CHANGE_QUERY_STALE');
  await fault(changes.open({ ...args, reuse: { ...args.reuse, capability: undefined } }), 'CHANGE_REUSE');
  await fault(changes.open({ ...args, scope: [{ path: 'src/html.mjs', module_uid: '00000001' }] }), 'CHANGE_OWNERSHIP');
  await fault(changes.open({ ...args, scope: [...args.scope, args.scope[0]] }), 'CHANGE_SCOPE');
  await fault(changes.open({ ...args, scope: [{ path: '../outside.txt', module_uid: '00000001' }] }), 'PATH_ERROR');
  await writeFile(join(root, 'src/html.mjs'), modifiedSource);
  await fault(changes.open(args), 'CHANGE_QUERY_STALE');
  assert.equal((await changes.status()).state, 'none');
});

test('real STDIO registers, binds writes, rejects all out-of-scope targets before writing and retains partial effects', { timeout: 20000 }, async (t) => {
  const { root, args, start, engine } = await fixture(t);
  let client = await start();
  const missingBinding = await client.request('tools/call', { name: 'sol_apply_changes', arguments: { changes: [{ action: 'write', path: 'src/html.mjs', content: modifiedSource }] } });
  assert.equal(missingBinding.result.isError, true); assert.match(missingBinding.result.content[0].text, /change/);
  let state = await call(client, 'sol_change_open', args);
  const outside = await call(client, 'sol_apply_changes', { change: state.change, changes: [
    { action: 'write', path: 'src/html.mjs', content: modifiedSource }, { action: 'write', path: 'outside.txt', content: 'forbidden' }] }, true);
  assert.equal(outside.error.code, 'CHANGE_OUTSIDE_SCOPE'); assert.equal(await readFile(join(root, 'src/html.mjs'), 'utf8'), initialSource);
  const moved = await call(client, 'sol_apply_patch', { change: state.change,
    patch: '*** Begin Patch\n*** Update File: src/html.mjs\n*** Move to: outside.mjs\n@@\n-' + initialSource.trim() + '\n+' + modifiedSource.trim() + '\n*** End Patch' }, true);
  assert.equal(moved.error.code, 'CHANGE_OUTSIDE_SCOPE');
  const partial = await call(client, 'sol_apply_changes', { change: state.change, changes: [
    { action: 'write', path: 'src/html.mjs', content: modifiedSource }, { action: 'delete', path: 'missing.txt' }] }, true);
  assert.deepEqual(partial.changed_paths, ['src/html.mjs']); assert.equal(partial.change.state, 'dirty');
  assert.equal(partial.change.task_complete, false); assert.equal(partial.validation.status, 'skipped'); assert.equal(partial.validation.reason, 'no_rule');
  const stale = await call(client, 'sol_apply_changes', { change: state.change, changes: [{ action: 'write', path: 'src/html.mjs', content: initialSource }] }, true);
  assert.equal(stale.error.code, 'CHANGE_VERSION'); assert.equal(await readFile(join(root, 'src/html.mjs'), 'utf8'), modifiedSource);
  state = partial.change;
  const unchanged = await call(client, 'sol_apply_changes', { change: state.change, changes: [{ action: 'write', path: 'src/html.mjs', content: modifiedSource }] });
  assert.deepEqual(unchanged.changed_paths, []); assert.equal(unchanged.validation, null);
  assert.equal(unchanged.change.evidence_generation, state.evidence_generation);
  await client.close(); client = await start(); state = await call(client, 'sol_change_status');
  assert.equal(state.state, 'dirty'); assert.equal(state.accumulated_path_count, 1);
  const record = await engine.stored(state.raw.handle, 'sol_change_record', 'change_record');
  assert.deepEqual(record.accumulated_paths, ['src/html.mjs']); assert.deepEqual(record.acceptance, args.acceptance); assert.ok(record.previous_handle);
  const abandoned = await call(client, 'sol_change_abandon', { change: state.change, reason: 'Fixture finished without completing the task.' });
  assert.equal(abandoned.state, 'abandoned'); assert.equal(await readFile(join(root, 'src/html.mjs'), 'utf8'), modifiedSource);
});

test('singleton registration, explicit scope adjustment and same-version writes serialize across coordinators', async (t) => {
  const { changes, engine, args, root } = await fixture(t);
  const other = new ChangeCoordinator(engine, { schema_version: 1, rules: [] });
  const results = await Promise.allSettled([changes.open(args), other.open(args)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'CHANGE_ACTIVE');
  let state = await changes.status();
  state = await changes.open({ ...args, change: state.change, scope: [...args.scope, { path: 'README.md', module_uid: '00000001' }] });
  assert.equal(state.scope_count, 4);
  let writes = 0;
  const operation = async () => { writes += 1; await writeFile(join(root, 'README.md'), 'Updated requirement.'); return { tool_status: 'ok', changed_paths: ['README.md'] }; };
  const writers = await Promise.allSettled([changes.run(state.change, ['README.md'], operation), other.run(state.change, ['README.md'], operation)]);
  assert.equal(writes, 1); assert.equal(writers.find((r) => r.status === 'rejected').reason.code, 'CHANGE_VERSION');
  const current = await changes.status();
  await fault(changes.open({ ...args, change: current.change }), 'CHANGE_SCOPE');
});

test('external drift invalidates old receipts and scope adjustment explicitly accounts for discovered paths', async (t) => {
  const { root, changes, args, engine } = await fixture(t);
  const opened = await changes.open(args);
  await writeFile(join(root, 'README.md'), 'External requirement change.');
  const state = await changes.status();
  assert.equal(state.state, 'dirty'); assert.ok(state.evidence_generation > opened.evidence_generation);
  const record = await engine.stored(state.raw.handle, 'sol_change_record', 'change_record');
  assert.equal(record.latest_validation, null); assert.deepEqual(record.blockers, [{ code: 'CHANGE_OUTSIDE_SCOPE', paths: ['README.md'] }]);
  await fault(changes.run(state.change, ['src/html.mjs'], () => assert.fail('Must not write')), 'CHANGE_BLOCKED');
  const adjusted = await changes.open({ ...args, change: state.change, scope: [...args.scope, { path: 'README.md', module_uid: '00000001' }] });
  assert.deepEqual(adjusted.blockers, []); assert.equal(adjusted.task_complete, false);
});

test('real STDIO cancellation preserves written source and requires explicit resume', { timeout: 20000 }, async (t) => {
  const { root, args, start } = await fixture(t, slowRules);
  const client = await start(); const opened = await call(client, 'sol_change_open', args);
  const request = client.beginRequest('tools/call', { name: 'sol_apply_changes', arguments: {
    change: opened.change, changes: [{ action: 'write', path: 'src/html.mjs', content: modifiedSource }] } }, { timeoutMs: 15000 });
  const settled = request.promise.catch((error) => error);
  await waitForMarker(root); client.cancel(request.id); assert.equal((await settled).code, 'INTERRUPTED');
  const state = await call(client, 'sol_change_status'); assert.equal(state.state, 'interrupted');
  assert.equal(await readFile(join(root, 'src/html.mjs'), 'utf8'), modifiedSource);
  const blocked = await call(client, 'sol_apply_changes', { change: state.change, changes: [{ action: 'write', path: 'src/html.mjs', content: initialSource }] }, true);
  assert.equal(blocked.error.code, 'CHANGE_STATE');
  const resumed = await call(client, 'sol_change_resume', { change: state.change }); assert.equal(resumed.state, 'dirty');
  assert.equal(await readFile(join(root, 'src/html.mjs'), 'utf8'), modifiedSource); assert.equal(resumed.task_complete, false);
});

test('real server and validator tree termination recovers pending change without replay', { timeout: 20000, skip: !['win32', 'linux'].includes(process.platform) }, async (t) => {
  const { root, args, start, engine } = await fixture(t, slowRules);
  let client = await start(); const opened = await call(client, 'sol_change_open', args);
  const request = client.beginRequest('tools/call', { name: 'sol_apply_changes', arguments: {
    change: opened.change, changes: [{ action: 'write', path: 'src/html.mjs', content: modifiedSource }] } }, { timeoutMs: 15000 });
  const settled = request.promise.catch((error) => error);
  await waitForMarker(root); await client.terminateTree(); await settled;
  client = await start(); const state = await call(client, 'sol_change_status');
  assert.equal(state.state, 'interrupted'); assert.equal(state.accumulated_path_count, 1);
  assert.equal(await readFile(join(root, 'src/html.mjs'), 'utf8'), modifiedSource);
  const record = await engine.stored(state.raw.handle, 'sol_change_record', 'change_record');
  assert.equal(record.pending, null); assert.equal(record.latest_validation, null);
  assert.equal((await call(client, 'sol_change_resume', { change: state.change })).state, 'dirty');
});

test('corrupt pointer refuses recovery; unpublished archive does not overwrite current identity', async (t) => {
  const { changes, args, root } = await fixture(t);
  const state = await changes.open(args);
  const pointerPath = join(root, '.codex/sol/architecture/active-change.json');
  const pointer = JSON.parse(await readFile(pointerPath)); pointer.change.version = 'f'.repeat(64);
  await writeFile(pointerPath, JSON.stringify(pointer));
  await fault(changes.status(), 'CHANGE_CORRUPT');
  pointer.change.version = state.change.version; await writeFile(pointerPath, JSON.stringify(pointer));
  const original = changes.engine.archive.bind(changes.engine);
  changes.engine.archive = async (...params) => { await original(...params); throw new Error('publication fault'); };
  await assert.rejects(changes.transition(state.change, 'abandoned', { reason: 'Test storage failure.' }), /publication fault/);
  changes.engine.archive = original;
  assert.equal((await changes.status()).state, 'open');
});

test('final archive failure leaves recoverable pending state and preserves actual source modifications', async (t) => {
  const { changes, args, root } = await fixture(t);
  const state = await changes.open(args); const archive = changes.engine.archive.bind(changes.engine);
  const result = await changes.run(state.change, ['src/html.mjs'], async () => {
    await writeFile(join(root, 'src/html.mjs'), modifiedSource);
    changes.engine.archive = async () => { throw new Error('final archive unavailable'); };
    return { tool_status: 'ok', changed_paths: ['src/html.mjs'] };
  });
  assert.equal(result.tool_status, 'error'); assert.equal(result.change.recovery_required, true);
  assert.deepEqual(result.changed_paths, ['src/html.mjs']);
  changes.engine.archive = archive;
  const recovered = await changes.status(); assert.equal(recovered.state, 'interrupted');
  assert.equal(recovered.accumulated_path_count, 1); assert.equal(await readFile(join(root, 'src/html.mjs'), 'utf8'), modifiedSource);
});

test('generated exclusions cannot hide managed targets, and pre-cancelled registration writes nothing', async (t) => {
  const { changes, args } = await fixture(t, undefined, ['*.txt']);
  await fault(changes.open(args), 'CHANGE_SCOPE');
  const controller = new AbortController(); controller.abort();
  await fault(changes.open({ ...args, scope: args.scope.slice(0, 2) }, { signal: controller.signal }), 'INTERRUPTED');
  assert.equal((await changes.status()).state, 'none');
});

test('real Codex patch runs under the bound workspace lease and returns exactly one change event', {
  timeout: 20000, skip: !process.env.CODEX_SOL_PATCH_EXECUTABLE && 'Configure the installed Codex patch executable to run this native case.' }, async (t) => {
  const rules = { schema_version: 1, rules: [{ schema_version: 1, id: 'source', globs: ['src/**'], watch_paths: ['src/**'],
    commands: [{ id: 'syntax', argv: [process.execPath, '--check', 'src/html.mjs'], cwd: '.', timeout_ms: 5000 }] }] };
  const { root, args, start, store } = await fixture(t, rules);
  const client = await start(); const opened = await call(client, 'sol_change_open', args);
  const result = await call(client, 'sol_apply_patch', { change: opened.change,
    patch: '*** Begin Patch\n*** Update File: src/html.mjs\n@@\n-' + initialSource.trim() + '\n+' + modifiedSource.trim() + '\n*** End Patch' });
  assert.equal(result.validation.status, 'passed'); assert.equal(result.change.state, 'dirty'); assert.equal(result.change.task_complete, false);
  assert.deepEqual(result.changed_paths, ['src/html.mjs']); assert.equal(await readFile(join(root, 'src/html.mjs'), 'utf8'), modifiedSource);
  const event = await (await new ContextEngine(store, 'context.json').initialize()).stored(result.change.raw.handle, 'sol_change_record', 'change_record');
  assert.equal(event.latest_validation.event_id, result.validation.event_id);
  const receipts = await readdir(join(store.solRoot, 'receipts'));
  assert.equal(receipts.filter((file) => file.endsWith('.json')).length, 1);
  const duplicate = await call(client, 'sol_apply_changes', { change: result.change.change, changes: [{ action: 'write', path: 'src/html.mjs', content: modifiedSource }] });
  assert.equal(duplicate.validation, null); assert.deepEqual(duplicate.changed_paths, []);
  assert.equal((await readdir(join(store.solRoot, 'receipts'))).filter((file) => file.endsWith('.json')).length, 1);
});

test('failed synchronous check stays dirty; subsequent external change invalidates its receipt', { timeout: 15000 }, async (t) => {
  const rules = { schema_version: 1, rules: [{ schema_version: 1, id: 'source', globs: ['src/**'], watch_paths: ['src/**'],
    commands: [{ id: 'fail', argv: [process.execPath, '-e', 'process.exit(2)'], cwd: '.', timeout_ms: 5000 }] }] };
  const { root, args, start, engine } = await fixture(t, rules);
  const client = await start(); const opened = await call(client, 'sol_change_open', args);
  const result = await call(client, 'sol_apply_changes', { change: opened.change, changes: [{ action: 'write', path: 'src/html.mjs', content: modifiedSource }] });
  assert.equal(result.validation.status, 'failed'); assert.equal(result.change.state, 'dirty'); assert.equal(result.change.task_complete, false);
  await writeFile(join(root, 'src/html.mjs'), initialSource);
  const state = await call(client, 'sol_change_status'); assert.ok(state.evidence_generation > result.change.evidence_generation);
  assert.equal(state.validation_status, null);
  const old = await engine.stored(result.change.raw.handle, 'sol_change_record', 'change_record'); assert.equal(old.latest_validation.status, 'failed');
});

test('generated directory exclusions reject a new managed target before registration', async (t) => {
  const { root, changes, args } = await fixture(t, undefined, ['cache*']);
  await fault(changes.open({ ...args, scope: [{ path: 'cache-data/new.mjs', module_uid: '00000001' }] }), 'CHANGE_SCOPE');
  assert.equal((await changes.status()).state, 'none');
  await assert.rejects(readFile(join(root, 'cache-data/new.mjs')), { code: 'ENOENT' });
});

test('real STDIO creates a scoped new file and recovers its paths without updating architecture sources', { timeout: 20000 }, async (t) => {
  const content = 'A newly managed file.\n';
  const rules = { schema_version: 1, rules: [{ schema_version: 1, id: 'new-file', globs: ['*.txt'], watch_paths: ['*.txt'],
    commands: [{ id: 'content', argv: [process.execPath, '-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("missing.txt", "utf8"), "A newly managed file.\\n");'], cwd: '.', timeout_ms: 5000 }] }] };
  const { root, args, start, engine } = await fixture(t, rules);
  const declarationBefore = await readFile(join(root, 'architecture.json'), 'utf8');
  let client = await start();
  const queryBefore = await call(client, 'sol_architecture_query', { paths: ['missing.txt'], capability: 'escapeHtml' });
  const opened = await call(client, 'sol_change_open', args);
  const result = await call(client, 'sol_apply_changes', { change: opened.change,
    changes: [{ action: 'write', path: 'missing.txt', content }] });
  assert.deepEqual(result.changed_paths, ['missing.txt']); assert.equal(result.validation.status, 'passed');
  assert.equal(result.change.state, 'dirty'); assert.equal(result.change.task_complete, false);
  assert.equal(result.change.accumulated_path_count, 1); assert.equal(await readFile(join(root, 'missing.txt'), 'utf8'), content);
  await client.close(); client = await start();
  const recovered = await call(client, 'sol_change_status');
  assert.equal(recovered.state, 'dirty'); assert.equal(recovered.accumulated_path_count, 1);
  assert.equal(recovered.validation_status, 'passed'); assert.equal(recovered.task_complete, false);
  const record = await engine.stored(recovered.raw.handle, 'sol_change_record', 'change_record');
  assert.deepEqual(record.accumulated_paths, ['missing.txt']);
  const queryAfter = await call(client, 'sol_architecture_query', { paths: ['missing.txt'], capability: 'escapeHtml' });
  assert.deepEqual(queryAfter.owners, []); assert.equal(queryAfter.version, queryBefore.version);
  assert.equal(await readFile(join(root, 'architecture.json'), 'utf8'), declarationBefore);
  assert.ok(JSON.parse(declarationBefore).modules.every((module) => module.source.every((source) => source.path !== 'missing.txt')));
  t.diagnostic('The explicit change scope persists, but a new file is not automatically added to architecture source declarations.');
});
