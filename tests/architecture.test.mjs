import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchitectureIndex } from '../src/architecture/index.mjs';
import { ContextEngine } from '../src/architecture/context.mjs';
import { ContextSessions } from '../src/architecture/session.mjs';
import { createObservationStore } from '../src/store.mjs';
import { fingerprintOf } from '../vendor/normify/engine/store.js';
import { startMcpServer } from './helpers/mcp-client.mjs';
import { recall } from '../src/recall.mjs';

const sample = JSON.parse(await readFile(new URL('../context.example.json', import.meta.url)));
const task = { id: 'tags', goal: 'Add tag browsing and reuse escaping', constraints: [] };
const input = { task, role: 'plan', targets: ['src/home.mjs'], architecture_query: 'escapeHtml' };
const session = '01a10117-c021-74b1-9f76-934f5cf7097d';
async function fixture(t, beforeCleanup = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'sol-arch-')); t.after(async () => { await beforeCleanup(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'README.md'), 'Architecture test workspace.');
  await writeFile(join(root, 'src/html.mjs'), 'export function escapeHtml(text) { return String(text).replaceAll("<", "&lt;"); }\n');
  await writeFile(join(root, 'src/home.mjs'), 'import { escapeHtml } from "./html.mjs";\nexport const home = (text) => escapeHtml(text);\n');
  await writeFile(join(root, 'src/post.mjs'), 'import { escapeHtml } from "./html.mjs";\nexport const post = (text) => escapeHtml(text);\nconst lazy = () => import("./home.mjs");\n');
  const module = async (id, uid, source, symbol) => ({ id, uid, parent: id.includes('.') ? 'demo' : null, name: { zh: id, en: id }, description: { zh: '模块', en: 'Module' }, source: source ? [{ path: source }] : [], revision: '0'.repeat(40), updated_at: '2026-10-03T00:00:00Z', fingerprint: source ? (await fingerprintOf(root, [{ path: source }])).hash : 'pending', ...(symbol ? { apis: [{ protocol: 'rpc', path: symbol, description: { zh: '安全转义', en: 'Safe escaping' } }] } : {}) });
  const manifest = { schema_version: 1, modules: [await module('demo', '00000001'), await module('demo.html', '00000002', 'src/html.mjs', 'escapeHtml'), await module('demo.home', '00000003', 'src/home.mjs', 'home'), await module('demo.post', '00000004', 'src/post.mjs', 'post')], policy: { schema_version: 1, updated_at: '2026-10-03T00:00:00Z', rules: [{ id: 'no-cycles', type: 'acyclic', severity: 'error', includeCrossTree: true }] } };
  const save = () => writeFile(join(root, 'architecture.json'), JSON.stringify(manifest)); await save();
  const config = structuredClone(sample); config.architecture = { path: 'architecture.json' }; config.roles[0].architecture = true;
  await writeFile(join(root, 'context.json'), JSON.stringify(config)); await writeFile(join(root, 'rules.json'), JSON.stringify({ schema_version: 1, rules: [] }));
  const store = await createObservationStore(root); const engine = await new ContextEngine(store, 'context.json').initialize();
  return { root, manifest, save, engine, store, index: new ArchitectureIndex(root, 'architecture.json') };
}

test('pinned Normify compiles independently; JS locations prove ownership, reuse and import impact', async (t) => {
  const { index } = await fixture(t); const snapshot = await index.load();
  assert.equal(snapshot.status, 'ready'); assert.equal(snapshot.engine.compiled, true); assert.equal(snapshot.engine.commit, 'ed404e5b8db0010ff57ec8486ec8749421072545');
  const result = index.select(snapshot, { paths: ['src/html.mjs'], capability: 'escapeHtml' });
  assert.equal(result.owners[0].uid, '00000002'); assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].verification, 'static_export');
  assert.deepEqual(result.impact.map((e) => e.from).sort(), ['demo.home', 'demo.post']); assert.ok(result.impact.every((e) => e.source.line === 1));
  assert.ok(result.uncovered.some((u) => u.reason === 'dynamic_import')); assert.match(result.coverage, /no full call graph/);
});

test('module rename retains UID and reverse imports, rebuild is derived from current declarations', async (t) => {
  const { index, manifest, save } = await fixture(t); manifest.modules[1].id = 'demo.format'; await save();
  const snapshot = await index.load(); assert.equal(snapshot.status, 'ready');
  const result = index.select(snapshot, { capability: 'escapeHtml' }); assert.equal(result.candidates[0].uid, '00000002');
  assert.ok(result.impact.every((e) => e.to === 'demo.format' && e.to_uid === '00000002'));
});

test('fingerprint drift, missing exports and overlapping ownership remain blockers', async (t) => {
  const { root, index, manifest, save } = await fixture(t);
  await writeFile(join(root, 'src/html.mjs'), 'export const renamed = 1;\n');
  const drift = await index.load(); assert.equal(drift.status, 'blocked'); assert.equal(drift.engine.compiled, false);
  assert.ok(drift.diagnostics.some((d) => d.code === 'evidence/fingerprint-drift')); assert.ok(drift.diagnostics.some((d) => d.code === 'EXPORT_MISSING'));
  manifest.modules[2].source = [{ path: 'src/html.mjs' }]; await save();
  assert.ok((await index.load()).diagnostics.some((d) => d.code === 'OWNERSHIP_CONFLICT'));
});

test('invalid structure, duplicate UID and declaration dependency policy use upstream diagnostics', async (t) => {
  const { index, manifest, save } = await fixture(t);
  manifest.modules[1].parent = 'missing'; await save(); await assert.rejects(index.load(), (e) => e.code === 'ARCHITECTURE_CONFIG');
  manifest.modules[1].parent = 'demo'; manifest.modules[2].uid = manifest.modules[1].uid; await save();
  assert.ok((await index.load()).diagnostics.some((d) => d.code === 'structure/uid-duplicate'));
  manifest.modules[2].uid = '00000003'; manifest.modules[2].deps = [{ kind: 'reference', to: 'demo.html' }];
  manifest.policy.rules.push({ id: 'forbid', type: 'forbid-dependency', from: ['demo.home'], to: ['demo.html'], severity: 'error' }); await save();
  assert.equal((await index.load()).status, 'blocked');
});

test('undeclared forbidden static imports and removed named exports have source evidence', async (t) => {
  const { root, index, manifest, save } = await fixture(t);
  manifest.policy.rules.push({ id: 'forbid', type: 'forbid-dependency', from: ['demo.home'], to: ['demo.html'], severity: 'error' }); await save();
  const blocked = await index.load(); assert.equal(blocked.status, 'blocked');
  const diagnostic = blocked.diagnostics.find((d) => d.code === 'policy/forbid' && d.origin === 'static_import');
  assert.equal(diagnostic.sources[0].path, 'src/home.mjs'); assert.equal(diagnostic.sources[0].line, 1);
  await writeFile(join(root, 'src/home.mjs'), 'import { removed } from "./html.mjs";\nexport const home = removed;\n');
  assert.ok((await index.load()).diagnostics.some((d) => d.code === 'IMPORT_EXPORT_MISSING' && d.symbol === 'removed'));
});

test('workspace paths, links, malformed JS and cancellation fail safely and release resources', async (t) => {
  const { root, index, manifest, save, engine } = await fixture(t);
  manifest.modules[1].source[0].path = '../outside.mjs'; await save(); await assert.rejects(index.load(), (e) => e.code === 'ARCHITECTURE_CONFIG' && e.diagnostics.length > 0);
  manifest.modules[1].source[0].path = 'src/html.mjs'; await save();
  await symlink(join(root, 'src'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  manifest.modules[1].source[0].path = 'linked/html.mjs'; await save(); await assert.rejects(index.load(), (e) => e.code === 'PATH_ERROR');
  manifest.modules[1].source[0].path = 'src/html.mjs'; await save(); await writeFile(join(root, 'src/html.mjs'), 'export broken {');
  await assert.rejects(index.load(), (e) => e.code === 'ARCHITECTURE_PARSE');
  const controller = new AbortController(); controller.abort(); await assert.rejects(engine.architectureQuery({}, { signal: controller.signal }), (e) => e.code === 'INTERRUPTED');
});

test('Context opt-in selects architecture by responsibility; source change outside targets invalidates submit and prompt', async (t) => {
  const { root, engine, store } = await fixture(t); const packet = await engine.prepare(input);
  assert.equal(packet.capabilities.architecture_index, 'ready'); assert.ok(packet.architecture.raw); assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 4096);
  const full = await engine.stored(packet.raw.handle, 'sol_context_prepare', 'context_record'); assert.equal(full.architecture.material.candidates[0].symbol, 'escapeHtml');
  const sessions = new ContextSessions(engine); await sessions.bind(session, packet.raw);
  await writeFile(join(root, 'src/post.mjs'), 'export const post = 2;\n');
  const submission = { context_handle: packet.raw.handle, task_id: task.id, role: 'plan', version: packet.version, output: { plan: 'reuse escaping', constraints: [], unresolved: [] } };
  await assert.rejects(engine.submit(submission), (e) => e.code === 'CONTEXT_STALE'); assert.equal((await sessions.remind(session)).freshness, 'stale');
  const query = await engine.architectureQuery({ capability: 'escapeHtml' }); assert.equal(query.status, 'blocked'); assert.ok(query.raw);
  const result = await recall(store, { schema_version: 1, handle: query.raw.handle, selector: { kind: 'bytes', start: 0, end: Math.min(query.raw.bytes, 100) } }); assert.ok(result);
  assert.ok((await readdir(store.observationsRoot)).length > 0);
});

test('real STDIO advertises opt-in query tool and returns compiled provenance plus bounded results', { timeout: 15000 }, async (t) => {
  let client;
  const { root } = await fixture(t, async () => { await client?.close(); }); client = startMcpServer({ workspace: root, rulesPath: join(root, 'rules.json'), env: { CODEX_SOL_CONTEXT_RULES: join(root, 'context.json'), CODEX_SOL_HOST_EXECUTABLE: '' } });
  await client.initialize(); const list = await client.request('tools/list');
  assert.deepEqual(list.result.tools.map((tool) => tool.name).sort(), ['sol_apply_changes', 'sol_apply_patch', 'sol_architecture_query', 'sol_change_abandon', 'sol_change_complete', 'sol_change_open', 'sol_change_resume', 'sol_change_review', 'sol_change_status', 'sol_context_prepare', 'sol_context_submit', 'sol_read_file', 'sol_recall']);
  const result = await client.request('tools/call', { name: 'sol_architecture_query', arguments: { paths: ['src/html.mjs'], capability: 'escapeHtml' } });
  assert.equal(result.result.isError, false, JSON.stringify(result)); const packet = JSON.parse(result.result.content[0].text); assert.equal(packet.engine.compiled, true); assert.equal(packet.status, 'ready'); assert.ok(Buffer.byteLength(result.result.content[0].text) <= 4096);
});
