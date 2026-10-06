import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSolServer } from '../src/server.mjs';
import { runManagedCommand } from '../src/managed-command.mjs';
import { fingerprintOf } from '../vendor/normify/engine/store.js';
import { startMcpServer } from './helpers/mcp-client.mjs';
import { ContextSessions } from '../src/architecture/session.mjs';

const original = 'export const escapeHtml = (text) => String(text);\n';
const escaped = 'export const escapeHtml = (text) => String(text).replaceAll("<", "&lt;");\n';
const view = 'import { escapeHtml } from "./html.mjs"; export const render = (text) => "<p>" + escapeHtml(text) + "</p>";\n';
const changedView = view.replace('<p>', '<section>').replace('</p>', '</section>');
const example = JSON.parse(await readFile(new URL('../context.example.json', import.meta.url)));

async function fixture(t, { reuse = 'watched_inputs', ruleIds = ['html', 'view'], extraCommand = '', executable = process.execPath, wideWatch = false, newSourceRule = false, moveRule = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sol-closure-'));
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/html.mjs'), original); await writeFile(join(root, 'src/view.mjs'), view);
  await writeFile(join(root, 'README.md'), 'Escape angle brackets and preserve the shared view import.\n');
  const module = (id, uid, source, api) => ({ id, uid, parent: id === 'demo' ? null : 'demo',
    name: { zh: id, en: id }, description: { zh: '共享职责', en: 'Shared responsibility' },
    source, fingerprint: 'pending', revision: '0'.repeat(40), updated_at: '2026-10-04T00:00:00Z',
    ...(api ? { apis: [{ protocol: 'rpc', path: api, description: { zh: '公共能力', en: 'Public capability' } }] } : {}) });
  const manifest = { schema_version: 1, modules: [module('demo', '00000001', []), module('demo.html', '00000002', [{ path: 'src/html.mjs' }], 'escapeHtml'),
    module('demo.view', '00000003', [{ path: 'src/view.mjs' }], 'render')], policy: { schema_version: 1, updated_at: '2026-10-04T00:00:00Z', rules: [] } };
  for (const m of manifest.modules) if (m.source.length) m.fingerprint = (await fingerprintOf(root, m.source)).hash;
  await writeFile(join(root, 'architecture.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'context.json'), JSON.stringify({ ...example, architecture: { path: 'architecture.json' } }));
  const rules = { schema_version: 1, rules: ruleIds.map((id) => ({ schema_version: 1, id, reuse,
    globs: [`src/${id}.mjs`, ...(newSourceRule && id === 'view' ? ['src/new.mjs'] : []), ...(moveRule && id === 'html' ? ['src/renamed.mjs'] : [])],
    watch_paths: wideWatch ? ['**/*'] : id === 'view' || moveRule ? ['src/*.mjs'] : ['src/html.mjs'],
    commands: [{ id: 'behavior', argv: [executable, '-e', `const fs=require('node:fs');const p='.codex/sol/count-${id}';fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1));${extraCommand}${newSourceRule && id === 'view' ? "if(fs.existsSync('src/new.mjs'))import('./src/new.mjs').then(m=>require('node:assert/strict').equal(m.renderTag(),'new capability'));" : ''}import(${moveRule && id === 'html' ? "fs.existsSync('src/html.mjs')?'./src/html.mjs':'./src/renamed.mjs'" : `'./src/${id}.mjs'`}).then(m=>require('node:assert/strict').${id === 'html' ? "equal(m.escapeHtml('<'),'&lt;')" : "ok(m.render('<').includes('&lt;'))"});`], cwd: '.', timeout_ms: 5000 }] })) };
  await writeFile(join(root, 'rules.json'), JSON.stringify(rules));
  const service = await createSolServer(root, rules, { contextRulesPath: join(root, 'context.json'), rulesPath: join(root, 'rules.json') });
  const { changesEngine: changes, contextEngine: engine, store, validator } = service;
  const query = await engine.architectureQuery({ paths: ['src/html.mjs'], capability: 'escapeHtml' });
  const args = { task: { id: 'escape-task', goal: 'Escape angle brackets using the existing shared helper.' }, requirement_ref: 'README.md: escaping requirement',
    scope: [{ path: 'src/html.mjs', module_uid: '00000002' }, { path: 'src/view.mjs', module_uid: '00000003' },
      { path: 'src/new.mjs', module_uid: '00000003' }, { path: 'src/renamed.mjs', module_uid: '00000002' }, { path: 'architecture.json', module_uid: '00000001' }, { path: 'README.md', module_uid: '00000001' }],
    acceptance: ['The shared escapeHtml export escapes < and the existing view reuses it.'], expected_architecture_version: query.version,
    reuse: { decision: 'extend', reason: 'The shared HTML helper owns escaping.', query_handle: query.raw.handle, capability: { uid: '00000002', symbol: 'escapeHtml' } } };
  const count = async (id) => { try { return Number(await readFile(join(root, `.codex/sol/count-${id}`), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } };
  const write = async (binding, path, content) => (await changes.run(binding, [path], (lease) => runManagedCommand(store, validator,
    { id: 'edit', argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(path)},${JSON.stringify(content)})`], cwd: '.', timeout_ms: 5000 },
    { paths: [path], lease }))).change;
  const declaration = async (binding) => {
    for (const m of manifest.modules) if (m.source.length) m.fingerprint = (await fingerprintOf(root, m.source)).hash;
    return write(binding, 'architecture.json', JSON.stringify(manifest));
  };
  const start = async () => {
    const client = startMcpServer({ workspace: root, rulesPath: join(root, 'rules.json'), env: { CODEX_SOL_CONTEXT_RULES: join(root, 'context.json'), CODEX_SOL_HOST_EXECUTABLE: '' } });
    clients.push(client); await client.initialize(); return client;
  };
  return { root, changes, engine, store, validator, args, manifest, count, write, declaration, start };
}

async function prepare(f, binding) {
  const packet = await f.changes.review({ change: binding, phase: 'prepare' });
  const context = await f.engine.stored(packet.raw.handle, 'sol_change_review_context', 'change_review_context');
  return { packet, context };
}

function output(context) {
  const source = (path) => context.sources.find((s) => s.path === path && s.raw)?.raw.handle;
  const declaration = source('architecture.json');
  const allChecks = context.plan.rules.flatMap((r) => r.check_ids);
  return { method: 'self_review', modules: context.maintenance.affected_uids.map((uid) => {
    const m = context.architecture.tree.find((item) => item.uid === uid);
    const current = m?.source.map((s) => source(s.path)).find(Boolean) ?? declaration;
    const prior = context.before_sources.find((s) => !m && s.raw && context.maintenance.suggestions.some((p) => p.module_uid === uid && p.path === s.path))?.raw.handle;
    return { uid, disposition: m ? 'preserved' : 'removed', contract_refs: prior ? [current, prior] : [current], evidence_handles: [current],
      rationale: 'Read the captured public source contract and identified users for this version.', unresolved: [] };
  }), acceptance: context.acceptance.map((_, index) => ({ index, evidence_handles: [source('src/html.mjs') ?? declaration], check_ids: allChecks,
    rationale: 'The current source implements the registered behavior; listed checks test it.', unresolved: [] })),
    uncovered: context.maintenance.uncovered.map((item, index) => ({ index,
      evidence_handles: [source(item.path) ?? declaration, ...context.before_sources.filter((s) => s.path === item.path && s.raw).map((s) => s.raw.handle)],
      rationale: 'Reviewed this explicitly uncovered relationship using captured source and required behavioral checks.', unresolved: [] })),
    checks_not_applicable: context.checks_not_applicable_paths.map((path) => ({ path, evidence_handles: [source(path)], rationale: 'Documentation-only path; no executable behavior is introduced.' })), unresolved: [] };
}

async function submit(f, prepared, review = output(prepared.context)) {
  return f.changes.review({ change: prepared.packet.change, phase: 'submit', review_context_handle: prepared.packet.raw.handle, review });
}
async function edited(f, both = false) {
  let state = await f.changes.open(f.args);
  state = await f.write(state.change, 'src/html.mjs', escaped);
  if (both) state = await f.write(state.change, 'src/view.mjs', changedView);
  return f.declaration(state.change);
}
const fault = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test('closure reuses the valid shared-helper check and runs the missing static user check', async (t) => {
  const f = await fixture(t); const state = await edited(f);
  const prepared = await prepare(f, state.change);
  assert.equal(prepared.packet.status, 'ready');
  assert.equal(prepared.context.before_sources.find((s) => s.path === 'src/html.mjs').state, 'file');
  assert.ok(prepared.context.maintenance.suggestions.some((s) => s.kind === 'source_changed'));
  assert.deepEqual(prepared.context.plan.rules.map((r) => r.id), ['html', 'view']);
  const reviewed = await submit(f, prepared);
  assert.equal(reviewed.task_complete, false);
  const completed = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle });
  assert.equal(completed.task_complete, true, JSON.stringify(completed));
  assert.equal(completed.reused_rule_count, 1); assert.equal(completed.executed_rule_count, 1);
  assert.equal(await f.count('html'), 1); assert.equal(await f.count('view'), 1);
  assert.equal((await f.changes.status()).task_complete, true);
  const nextQuery = await f.engine.architectureQuery({ paths: ['src/html.mjs'], capability: 'escapeHtml' });
  const next = await f.changes.open({ ...f.args, task: { id: 'next-task', goal: 'Use the maintained shared helper.' }, expected_architecture_version: nextQuery.version,
    reuse: { ...f.args.reuse, query_handle: nextQuery.raw.handle } });
  assert.notEqual(next.change.id, completed.change.id); assert.equal(next.state, 'open');
});

test('scope-only adjustment clears the summary but reuses cumulative checks with zero new runner or ChangeEvent', async (t) => {
  const f = await fixture(t); let state = await edited(f, true);
  const query = await f.engine.architectureQuery({ paths: ['src/html.mjs'], capability: 'escapeHtml' });
  state = await f.changes.open({ ...f.args, change: state.change, acceptance: ['Current HTML behavior and shared view remain compatible.'], expected_architecture_version: query.version,
    reuse: { ...f.args.reuse, query_handle: query.raw.handle } });
  assert.equal(state.validation_status, null);
  const events = async () => { const metas = await Promise.all((await readdir(f.store.observationsRoot)).filter((d) => !d.startsWith('.')).map(async (d) => JSON.parse(await readFile(join(f.store.observationsRoot, d, 'meta.json'))))); return metas.filter((m) => m.tool === 'change_event').length; };
  const beforeEvents = await events();
  const reviewed = await submit(f, await prepare(f, state.change));
  const completed = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle });
  assert.equal(completed.task_complete, true, JSON.stringify(completed));
  assert.equal(completed.executed_rule_count, 0); assert.equal(completed.reused_rule_count, 2);
  assert.equal(await f.count('html'), 1); assert.equal(await f.count('view'), 1); assert.equal(await events(), beforeEvents);
});

test('default never rules execute fresh checks and completed evidence stays readable without rerunning', async (t) => {
  const f = await fixture(t, { reuse: 'never' }); const state = await edited(f);
  const reviewed = await submit(f, await prepare(f, state.change));
  const result = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle });
  assert.equal(result.task_complete, true, JSON.stringify(result)); assert.equal(result.executed_rule_count, 2);
  const htmlRuns = await f.count('html');
  assert.equal((await f.changes.status()).task_complete, true); assert.equal(await f.count('html'), htmlRuns);
});

test('watch dependencies never hide a required rule missing for another registered source', async (t) => {
  const f = await fixture(t, { ruleIds: ['html'], wideWatch: true });
  const state = await edited(f, true);
  const prepared = await prepare(f, state.change);
  assert.equal(prepared.packet.status, 'blocked');
  assert.ok(prepared.context.blockers.some((b) => b.code === 'REQUIRED_CHECK_MISSING' && b.paths.includes('src/view.mjs')));
  const reviewed = await submit(f, prepared);
  const result = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle });
  assert.equal(result.task_complete, false); assert.equal(result.completion_status, 'blocked');
});

test('many uncovered sources keep completion blockers within the status budget and retain recall access', async (t) => {
  const f = await fixture(t, { ruleIds: ['html'], wideWatch: true });
  const paths = Array.from({ length: 30 }, (_, i) => `src/uncovered-${i}-${'x'.repeat(120)}.mjs`);
  f.args.scope.push(...paths.map((path) => ({ path, module_uid: '00000003' })));
  let state = await edited(f);
  for (const path of paths) await writeFile(join(f.root, path), 'export const value = 1;\n');
  state = await f.changes.status();
  const prepared = await prepare(f, state.change);
  const reviewed = await submit(f, prepared);
  const result = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle });
  assert.equal(result.task_complete, false); assert.equal(result.completion_status, 'blocked');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
  assert.ok(result.completion_blocker_count > 1);
  assert.equal(result.review_context_handle, prepared.packet.raw.handle);
  assert.ok(result.completion_blockers.some((b) => b.code === 'UNREGISTERED_SOURCE'));
});

test('PATH-resolved check commands run but cannot publish unverifiable completed state', async (t) => {
  const f = await fixture(t, { executable: 'node', reuse: 'never' }); const state = await edited(f);
  const reviewed = await submit(f, await prepare(f, state.change));
  const result = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle });
  assert.equal(result.task_complete, false); assert.equal(result.state, 'dirty');
  assert.equal(result.completion_error.code, 'CHANGE_COMPLETION_INVALID');
  assert.equal(await f.count('view'), 1);
  assert.ok((await f.changes.validationHistory(await f.changes.read())).some((receipt) => receipt.status === 'passed'));
  assert.match(result.completion_error.message, /absolute executable path/u);
  assert.notEqual((await f.changes.read()).record.state, 'completed');
});

test('fingerprint refresh cannot complete without review; wrong coverage and unrelated source evidence are rejected', async (t) => {
  const f = await fixture(t); const state = await edited(f);
  await fault(f.changes.complete({ change: state.change, review_handle: 'a'.repeat(32) }), 'CHANGE_REVIEW_REQUIRED');
  const prepared = await prepare(f, state.change);
  const missing = output(prepared.context); missing.modules.pop();
  await fault(submit(f, prepared, missing), 'CHANGE_REVIEW_MODULES');
  const badIndex = output(prepared.context); badIndex.acceptance[0].index = 1;
  await fault(submit(f, prepared, badIndex), 'CHANGE_REVIEW_ACCEPTANCE');
  const unrelated = output(prepared.context); const html = unrelated.modules.find((m) => m.uid === '00000002');
  html.evidence_handles = [prepared.context.sources.find((s) => s.path === 'src/view.mjs').raw.handle];
  await fault(submit(f, prepared, unrelated), 'CHANGE_REVIEW_EVIDENCE');
  const unresolved = output(prepared.context); unresolved.modules[0].unresolved = ['Compatibility needs investigation.'];
  const accepted = await submit(f, prepared, unresolved);
  assert.equal(accepted.accepted, true); assert.equal(accepted.review_status, 'blocked');
  assert.equal((await f.changes.complete({ change: accepted.change, review_handle: accepted.review.handle })).task_complete, false);
});

test('metadata adjustment makes old review context stale even when source inputs stay identical', async (t) => {
  const f = await fixture(t); let state = await edited(f);
  const old = await prepare(f, state.change); const query = await f.engine.architectureQuery({ paths: ['src/html.mjs'] });
  state = await f.changes.open({ ...f.args, change: state.change, acceptance: ['A different criterion.'], expected_architecture_version: query.version, reuse: { ...f.args.reuse, query_handle: query.raw.handle } });
  await fault(f.changes.review({ change: state.change, phase: 'submit', review_context_handle: old.packet.raw.handle, review: output(old.context) }), 'CHANGE_REVIEW_STALE');
});

test('new unregistered source blocks completion until declaration maintenance makes it discoverable', async (t) => {
  const f = await fixture(t, { newSourceRule: true }); let state = await edited(f);
  state = await f.write(state.change, 'src/new.mjs', 'export const renderTag = () => "new capability";\n');
  let prepared = await prepare(f, state.change);
  assert.ok(prepared.context.blockers.some((b) => b.code === 'UNREGISTERED_SOURCE'));
  f.manifest.modules[2].source.push({ path: 'src/new.mjs' });
  f.manifest.modules[2].apis.push({ protocol: 'rpc', path: 'renderTag', description: { zh: '新能力', en: 'New capability' } });
  state = await f.declaration(state.change);
  prepared = await prepare(f, state.change);
  assert.equal(prepared.packet.status, 'ready', JSON.stringify(prepared.context.blockers));
  const reviewed = await submit(f, prepared);
  const completed = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle });
  assert.equal(completed.task_complete, true, JSON.stringify(completed));
  const query = await f.engine.architectureQuery({ paths: ['src/new.mjs'], capability: 'renderTag' });
  assert.equal(query.status, 'ready'); assert.equal(query.candidates[0].verification, 'static_export');
  assert.equal((await f.changes.status()).task_complete, true);
});

test('legacy record hash is readable but no before facts are invented', async (t) => {
  const f = await fixture(t); const state = await edited(f);
  const current = await f.changes.read(); const old = { ...current.record };
  delete old.baseline_architecture_ref; delete old.review_ref; delete old.completion_ref;
  const legacy = await f.changes.publish(old, current.raw);
  assert.equal((await f.changes.read()).record.version, legacy.record.version);
  const prepared = await prepare(f, { id: legacy.record.id, version: legacy.record.version });
  assert.ok(prepared.context.blockers.some((b) => b.code === 'BEFORE_IMPACT_UNAVAILABLE'));
  assert.equal(prepared.packet.task_complete, false); assert.equal(state.task_complete, false);
});

test('moving a shared source retains both paths, UID and old/current users through completion', async (t) => {
  const f = await fixture(t, { moveRule: true }); let state = await edited(f);
  state = (await f.changes.run(state.change, ['src/html.mjs', 'src/renamed.mjs'], (lease) => runManagedCommand(f.store, f.validator,
    { id: 'move', argv: [process.execPath, '-e', 'require("node:fs").renameSync("src/html.mjs","src/renamed.mjs")'], cwd: '.', timeout_ms: 5000 },
    { paths: ['src/html.mjs', 'src/renamed.mjs'], lease }))).change;
  state = await f.write(state.change, 'src/view.mjs', view.replace('./html.mjs', './renamed.mjs'));
  f.manifest.modules[1].source = [{ path: 'src/renamed.mjs' }];
  state = await f.declaration(state.change);
  const prepared = await prepare(f, state.change);
  assert.ok(prepared.context.paths.includes('src/html.mjs')); assert.ok(prepared.context.paths.includes('src/renamed.mjs'));
  assert.ok(prepared.context.maintenance.affected_uids.includes('00000003'));
  assert.ok(prepared.context.maintenance.suggestions.some((s) => s.kind === 'export_relocated' && s.module_uid === '00000002'));
  const reviewed = await submit(f, prepared);
  const result = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle });
  assert.equal(result.task_complete, true, JSON.stringify(result));
  const query = await f.engine.architectureQuery({ paths: ['src/renamed.mjs'], capability: 'escapeHtml' });
  assert.equal(query.owners[0].uid, '00000002'); assert.equal(query.impact[0].source.path, 'src/view.mjs');
});

test('completed source edits and damaged archived outputs invalidate completion without a runner', async (t) => {
  for (const mode of ['source', 'output', 'review_context']) await t.test(mode, async (child) => {
    const f = await fixture(child); const state = await edited(f); const reviewed = await submit(f, await prepare(f, state.change));
    const done = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle }); assert.equal(done.task_complete, true);
    const packet = await f.engine.prepare({ task: f.args.task, role: 'plan', targets: ['src/html.mjs'], change: done.change });
    assert.equal(packet.change_state.task_complete, true);
    const sessions = new ContextSessions(f.engine); const session = '01a0ffa0-eba8-7f32-9ca8-6c105a7a3c59';
    await sessions.bind(session, packet.raw); assert.equal(await sessions.remind(session), null);
    const pointer = await readFile(f.changes.pointer); const binding = await readFile(sessions.file(session));
    const runs = await f.count('view');
    if (mode === 'source') await writeFile(join(f.root, 'src/html.mjs'), original);
    else if (mode === 'review_context') {
      const review = await f.engine.stored(reviewed.review.handle, 'sol_change_review', 'change_review');
      await appendFile(join(f.store.observationsRoot, review.context_handle, 'raw'), 'damaged');
    }
    else {
      const completion = await f.engine.stored(done.completion.handle, 'sol_change_completion', 'change_completion');
      let outputRef;
      for (const ref of completion.evidence_refs) {
        const opened = await f.store.openVerified(ref.handle);
        try { if (opened.meta.channel === 'stdout') outputRef = ref; } finally { await opened.close(); }
        if (outputRef) break;
      }
      assert.ok(outputRef); await appendFile(join(f.store.observationsRoot, outputRef.handle, 'raw'), 'damaged');
    }
    const reminder = await sessions.remind(session);
    assert.equal(reminder.change_state.task_complete, false); assert.equal(reminder.change_state.state, 'dirty');
    assert.equal(reminder.change_state.completion.validity, 'stale'); assert.equal(reminder.change_state.needs_status_refresh, true);
    assert.deepEqual(reminder.change_state.change, done.change);
    assert.deepEqual(await readFile(f.changes.pointer), pointer); assert.deepEqual(await readFile(sessions.file(session)), binding);
    assert.equal(await f.count('view'), runs); assert.ok(Buffer.byteLength(JSON.stringify(reminder)) <= 4096);
    const status = await f.changes.status(); assert.equal(status.task_complete, false); assert.equal(status.state, 'dirty');
    assert.equal(await f.count('view'), runs);
  });
});

test('validation rules edited on disk require a server restart instead of completing with the old commands', async (t) => {
  const f = await fixture(t); const state = await edited(f); const reviewed = await submit(f, await prepare(f, state.change));
  const rules = JSON.parse(await readFile(join(f.root, 'rules.json'), 'utf8')); rules.rules[0].commands[0].argv.push('changed');
  await writeFile(join(f.root, 'rules.json'), JSON.stringify(rules));
  await fault(f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle }), 'CHANGE_RULES_CHANGED');
  assert.notEqual((await f.changes.read()).record.state, 'completed');
});

test('source drift during final record archive does not publish completed', async (t) => {
  const f = await fixture(t); const state = await edited(f); const reviewed = await submit(f, await prepare(f, state.change));
  const archive = f.changes.records.archive.bind(f.changes.records); let injected = false;
  f.changes.records.archive = async (value, tool, ...rest) => {
    const raw = await archive(value, tool, ...rest);
    if (!injected && tool === 'sol_change_record' && value.state === 'completed') { injected = true; await writeFile(join(f.root, 'src/html.mjs'), escaped + 'export const changedExternally = true;\n'); }
    return raw;
  };
  const result = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle });
  assert.equal(injected, true); assert.equal(result.task_complete, false); assert.notEqual(result.state, 'completed');
  assert.notEqual((await f.changes.read()).record.state, 'completed');
});

test('completion archive failure and cancellation preserve unfinished actual state and explicit recovery', async (t) => {
  for (const mode of ['storage', 'cancel']) await t.test(mode, async (child) => {
    const f = await fixture(child); const state = await edited(f); const reviewed = await submit(f, await prepare(f, state.change));
    const controller = new AbortController(); const archive = f.changes.records.archive.bind(f.changes.records);
    f.changes.records.archive = async (value, tool, ...rest) => {
      if (tool === 'sol_change_completion') {
        if (mode === 'storage') throw new Error('test archive failure');
        controller.abort();
      }
      return archive(value, tool, ...rest);
    };
    const result = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle }, { signal: controller.signal });
    assert.equal(result.task_complete, false); assert.notEqual(result.state, 'completed');
    assert.equal(await readFile(join(f.root, 'src/html.mjs'), 'utf8'), escaped);
    if (mode === 'cancel') { assert.equal(result.state, 'interrupted'); assert.equal((await f.changes.transition(result.change, 'dirty')).state, 'dirty'); }
  });
});

test('completed state detects source and external executable changes without launching a runner', { timeout: 20000 }, async (t) => {
  const binRoot = await mkdtemp(join(tmpdir(), 'sol-closure-bin-')); t.after(() => rm(binRoot, { recursive: true, force: true }));
  const executable = join(binRoot, process.platform === 'win32' ? 'node.exe' : 'node'); await copyFile(process.execPath, executable);
  const f = await fixture(t, { executable }); const state = await edited(f); const reviewed = await submit(f, await prepare(f, state.change));
  const result = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle });
  assert.equal(result.task_complete, true, JSON.stringify(result)); const runs = await f.count('view');
  const packet = await f.engine.prepare({ task: f.args.task, role: 'plan', targets: ['src/html.mjs'], change: result.change });
  const sessions = new ContextSessions(f.engine); const session = '01a0ffa0-eba8-7f32-9ca8-6c105a7a3c59';
  await sessions.bind(session, packet.raw);
  const pointer = await readFile(f.changes.pointer);
  await appendFile(executable, Buffer.from([0]));
  const reminder = await sessions.remind(session);
  assert.equal(reminder.change_state.task_complete, false); assert.equal(reminder.change_state.completion.validity, 'stale');
  assert.equal(reminder.change_state.needs_status_refresh, true); assert.deepEqual(reminder.change_state.change, result.change);
  assert.deepEqual(await readFile(f.changes.pointer), pointer); assert.equal(await f.count('view'), runs);
  const invalid = await f.changes.status(); assert.equal(invalid.task_complete, false); assert.equal(invalid.state, 'dirty'); assert.equal(await f.count('view'), runs);
});

test('real STDIO closes a registered feature and exposes the two opt-in tools', { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { reuse: 'never' }); const client = await f.start();
  const call = async (name, args = {}) => {
    const message = await client.request('tools/call', { name, arguments: args }, { timeoutMs: 15000 });
    assert.equal(message.result?.isError, false, JSON.stringify(message)); return JSON.parse(message.result.content[0].text);
  };
  const query = await call('sol_architecture_query', { paths: ['src/html.mjs'], capability: 'escapeHtml' });
  let state = await call('sol_change_open', { ...f.args, expected_architecture_version: query.version, reuse: { ...f.args.reuse, query_handle: query.raw.handle } });
  let result = await call('sol_apply_changes', { change: state.change, changes: [{ action: 'write', path: 'src/html.mjs', content: escaped }] }); state = result.change;
  f.manifest.modules[1].fingerprint = (await fingerprintOf(f.root, f.manifest.modules[1].source)).hash;
  result = await call('sol_apply_changes', { change: state.change, changes: [{ action: 'write', path: 'architecture.json', content: JSON.stringify(f.manifest) }] }); state = result.change;
  const prepared = await call('sol_change_review', { change: state.change, phase: 'prepare' });
  const selector = { kind: 'lines', start: 1, end: 1 }; let cursor; let captured = '';
  do {
    const page = await call('sol_recall', { handle: prepared.raw.handle, selector, ...(cursor ? { cursor } : {}) });
    captured += page.chunks.map((c) => c.text).join(''); cursor = page.next_cursor;
  } while (cursor);
  const context = JSON.parse(captured);
  const accepted = await call('sol_change_review', { change: prepared.change, phase: 'submit', review_context_handle: prepared.raw.handle, review: output(context) });
  const completed = await call('sol_change_complete', { change: accepted.change, review_handle: accepted.review.handle });
  assert.equal(completed.task_complete, true, JSON.stringify(completed)); assert.equal((await call('sol_change_status')).task_complete, true);
  assert.equal((await client.request('tools/list')).result.tools.length, 13);
});

test('review policy alone invalidates completion and review in read-only projections then publishes a new binding', async (t) => {
  const f = await fixture(t); const state = await edited(f);
  const prepared = await prepare(f, state.change); const reviewed = await submit(f, prepared);
  const completed = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle });
  assert.equal(completed.task_complete, true);
  const before = await readFile(f.changes.pointer); const archives = await readdir(f.store.observationsRoot);
  const counts = [await f.count('html'), await f.count('view')];
  f.changes.reviewPolicyId = 'change-review-v2-fixture';
  const inspection = await f.changes.inspectLocked({ targets: ['src/html.mjs'] });
  assert.equal(inspection.projection.task_complete, false);
  assert.equal(inspection.projection.review.validity, 'stale');
  assert.equal(inspection.projection.completion.validity, 'stale');
  assert.equal(inspection.projection.needs_status_refresh, true);
  assert.deepEqual(await readFile(f.changes.pointer), before);
  assert.deepEqual(await readdir(f.store.observationsRoot), archives);
  let current = await f.changes.status();
  assert.equal(current.state, 'dirty'); assert.equal(current.task_complete, false);
  assert.equal(current.accumulated_path_count, completed.accumulated_path_count);
  const refreshed = await f.changes.read();
  assert.equal(refreshed.record.previous_handle, completed.raw.handle);
  assert.equal(refreshed.record.review_policy_id, 'change-review-v2-fixture');
  assert.equal(refreshed.record.review_ref, null); assert.equal(refreshed.record.completion_ref, null);
  await fault(f.changes.review({ change: current.change, phase: 'submit', review_context_handle: prepared.packet.raw.handle,
    review: output(prepared.context) }), 'CHANGE_REVIEW_STALE');
  const renewed = await prepare(f, current.change);
  assert.equal(renewed.context.basis.review_policy_id, 'change-review-v2-fixture');
  assert.equal(renewed.context.sources.find((source) => source.path === 'src/html.mjs').mode, process.platform === 'win32' ? null : (await stat(join(f.root, 'src/html.mjs'))).mode & 0o777);
  current = await submit(f, renewed);
  assert.equal(current.review_status, 'ready');
  assert.deepEqual([await f.count('html'), await f.count('view')], counts);
  const historical = await f.engine.stored(completed.raw.handle, 'sol_change_record', 'change_record');
  assert.equal(historical.state, 'completed'); assert.equal(historical.review_policy_id, 'change-review-v1');
});

test('chmod alone stales current completion and captured source metadata without running checks', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t); const state = await edited(f);
  const reviewed = await submit(f, await prepare(f, state.change));
  const completed = await f.changes.complete({ change: reviewed.change, review_handle: reviewed.review.handle });
  assert.equal(completed.task_complete, true);
  const sourcePath = join(f.root, 'src/html.mjs'); const originalMode = (await stat(sourcePath)).mode & 0o777;
  const counts = [await f.count('html'), await f.count('view')]; const pointer = await readFile(f.changes.pointer);
  await chmod(sourcePath, originalMode === 0o755 ? 0o644 : 0o755);
  const inspection = await f.changes.inspectLocked({ targets: ['src/html.mjs'] });
  assert.equal(inspection.projection.task_complete, false); assert.equal(inspection.projection.needs_status_refresh, true);
  assert.deepEqual(await readFile(f.changes.pointer), pointer);
  const refreshed = await f.changes.status(); assert.equal(refreshed.state, 'dirty');
  const material = await prepare(f, refreshed.change);
  assert.equal(material.context.sources.find((source) => source.path === 'src/html.mjs').mode, originalMode === 0o755 ? 0o644 : 0o755);
  assert.deepEqual([await f.count('html'), await f.count('view')], counts);
});
