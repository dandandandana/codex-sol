import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchitectureIndex } from '../src/architecture/index.mjs';
import { fingerprintOf } from '../vendor/normify/engine/store.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sol-architecture-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  const files = {
    'src/library.mjs': 'export const shared = 1;\nexport const internal = 2;\n',
    'src/view.mjs': 'import { shared } from "./library.mjs";\nimport { join } from "node:path";\nexport const view = () => shared;\n',
    'src/controller.mjs': 'import { view } from "./view.mjs";\nexport const controller = view;\n',
    'src/unused.mjs': 'import { basename } from "node:path";\nexport const unused = () => import("./library.mjs");\n',
    'README.md': 'Synthetic architecture maintenance workspace.\n',
  };
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  const module = (id, uid, path, symbol) => ({ id, uid, parent: id === 'demo' ? null : 'demo',
    name: { zh: id, en: id }, description: { zh: '测试职责', en: 'Test responsibility' },
    source: path ? [{ path }] : [], revision: '0'.repeat(40), updated_at: '2026-10-04T00:00:00Z',
    fingerprint: 'pending', ...(symbol ? { apis: [{ protocol: 'rpc', path: symbol, description: { zh: '测试接口', en: 'Test interface' } }] } : {}),
  });
  const manifest = { schema_version: 1, modules: [module('demo', '00000001'),
    module('demo.library', '00000002', 'src/library.mjs', 'shared'), module('demo.view', '00000003', 'src/view.mjs', 'view'),
    module('demo.controller', '00000004', 'src/controller.mjs', 'controller'), module('demo.unused', '00000005', 'src/unused.mjs', 'unused')],
    policy: { schema_version: 1, updated_at: '2026-10-04T00:00:00Z', rules: [{ id: 'no-cycles', type: 'acyclic', severity: 'error', includeCrossTree: true }] } };
  const save = async (refresh = false) => {
    if (refresh) for (const entry of manifest.modules) entry.fingerprint = (await fingerprintOf(root, entry.source)).hash;
    await writeFile(join(root, 'architecture.json'), JSON.stringify(manifest));
  };
  await save(true);
  return { root, manifest, save, index: new ArchitectureIndex(root, 'architecture.json') };
}

test('captured facts retain undeclared exports without expanding query output; analysis is synchronous and pure', async (t) => {
  const { root, index } = await fixture(t); const before = await index.load();
  const library = before.source_facts.find((source) => source.path === 'src/library.mjs');
  assert.deepEqual(library.exports.map((entry) => entry.name), ['shared', 'internal']);
  assert.equal(library.exports[1].line, 2); assert.equal(library.exports[1].owners[0].uid, '00000002');
  const query = index.select(before, { capability: 'shared' });
  assert.equal(query.source_facts, undefined); assert.equal(query.declaration_facts, undefined);
  assert.deepEqual(query.candidates.map((entry) => entry.symbol), ['shared']);
  const serialized = JSON.stringify(before); const declaration = await readFile(join(root, 'architecture.json'), 'utf8');
  const result = index.maintenance(before, before, { paths: ['src/library.mjs'], scope: [{ path: 'src/library.mjs', module_uid: '00000002' }] });
  assert.equal(result instanceof Promise, false);
  assert.deepEqual(Object.keys(result).sort(), ['affected_uids', 'blockers', 'impact_paths', 'suggestions', 'uncovered']);
  assert.equal(JSON.stringify(before), serialized); assert.equal(await readFile(join(root, 'architecture.json'), 'utf8'), declaration);
  assert.deepEqual(result.affected_uids, ['00000002', '00000003', '00000004']);
  assert.deepEqual(result.impact_paths, ['src/controller.mjs', 'src/library.mjs', 'src/view.mjs']);
  assert.ok(result.uncovered.some((entry) => entry.reason === 'external_import' && entry.path === 'src/view.mjs'));
  assert.ok(result.uncovered.some((entry) => entry.reason === 'static_analysis_boundary'));
  assert.ok(!result.uncovered.some((entry) => entry.path === 'src/unused.mjs'));
  assert.equal(result.blockers.length, 0);
});

test('changed source, added and removed real exports and fingerprint drift carry before/current locations and versions', async (t) => {
  const { root, index } = await fixture(t); const before = await index.load();
  await writeFile(join(root, 'src/library.mjs'), 'export const shared = 1;\nexport const added = 3;\n');
  const current = await index.load();
  const result = index.maintenance(before, current, { paths: ['src/library.mjs'] });
  const added = result.suggestions.find((entry) => entry.kind === 'export_added' && entry.symbol === 'added');
  const removed = result.suggestions.find((entry) => entry.kind === 'export_removed' && entry.symbol === 'internal');
  assert.equal(added.module_uid, '00000002'); assert.equal(added.path, 'src/library.mjs');
  assert.equal(added.evidence.before_version, before.version); assert.equal(added.evidence.current_version, current.version);
  assert.equal(added.evidence.current.locations[0].line, 2);
  assert.equal(removed.evidence.before.locations[0].line, 2);
  assert.equal(removed.evidence.before.locations[0].sha256, before.source_facts.find((entry) => entry.path === 'src/library.mjs').sha256);
  assert.ok(result.suggestions.some((entry) => entry.kind === 'source_changed'));
  const refresh = result.suggestions.find((entry) => entry.kind === 'refresh_fingerprint');
  assert.equal(refresh.evidence.actual, (await fingerprintOf(root, [{ path: 'src/library.mjs' }])).hash);
  assert.match(refresh.evidence.note, /separate contract review/u);
  assert.ok(result.blockers.some((entry) => entry.code === 'evidence/fingerprint-drift'));
});

test('new cumulative formal JS source stays unregistered even when scope assigns a valid module and load is ready', async (t) => {
  const { root, index } = await fixture(t); const before = await index.load();
  await writeFile(join(root, 'src/new.mjs'), 'export const fresh = 1;\n');
  const current = await index.load(); assert.equal(current.status, 'ready');
  const result = index.maintenance(before, current, { paths: ['src/new.mjs'], scope: [{ path: 'src/new.mjs', module_uid: '00000002' }] });
  assert.ok(result.blockers.some((entry) => entry.code === 'UNREGISTERED_SOURCE' && entry.path === 'src/new.mjs'));
  assert.ok(result.suggestions.some((entry) => entry.kind === 'register_source' && entry.assigned_uids.includes('00000002')));
  assert.ok(!result.suggestions.some((entry) => entry.kind === 'export_added' && entry.symbol === 'fresh'));
  assert.ok(result.impact_paths.includes('src/new.mjs'));
});

test('removing a registered module and source retains deleted exports and its old transitive users', async (t) => {
  const { root, index, manifest, save } = await fixture(t); const before = await index.load();
  await rm(join(root, 'src/library.mjs')); manifest.modules.splice(1, 1); await save();
  const current = await index.load();
  const result = index.maintenance(before, current, { paths: ['src/library.mjs'], scope: [{ path: 'src/library.mjs', module_uid: '00000002' }] });
  assert.deepEqual(result.affected_uids, ['00000001', '00000002', '00000003', '00000004', '00000005']);
  assert.ok(result.impact_paths.includes('src/library.mjs')); assert.ok(result.impact_paths.includes('src/controller.mjs'));
  const removed = result.suggestions.find((entry) => entry.kind === 'export_removed' && entry.symbol === 'shared');
  assert.equal(removed.evidence.before.locations[0].path, 'src/library.mjs');
  assert.ok(result.suggestions.some((entry) => entry.kind === 'capability_removed' && entry.symbol === 'shared'));
  assert.ok(result.suggestions.some((entry) => entry.kind === 'static_relation_removed' && entry.evidence.before.source.path === 'src/view.mjs'));
  assert.ok(result.uncovered.some((entry) => entry.reason === 'unregistered_import_target' && entry.target === 'src/library.mjs'));
});

test('deleting an export with declarations retained exposes missing named imports and old consumers', async (t) => {
  const { root, index } = await fixture(t); const before = await index.load();
  await writeFile(join(root, 'src/library.mjs'), 'export const internal = 2;\n');
  const current = await index.load();
  const result = index.maintenance(before, current, { paths: ['src/library.mjs'] });
  assert.ok(result.blockers.some((entry) => entry.code === 'EXPORT_MISSING'));
  assert.ok(result.blockers.some((entry) => entry.code === 'IMPORT_EXPORT_MISSING' && entry.path === 'src/view.mjs'));
  assert.ok(result.impact_paths.includes('src/controller.mjs'));
  assert.ok(result.suggestions.some((entry) => entry.kind === 'export_removed' && entry.symbol === 'shared'));
});

test('declared missing sources reuse upstream blockers rather than inventing a valid deletion', async (t) => {
  const { root, index } = await fixture(t); const before = await index.load();
  await rm(join(root, 'src/library.mjs'));
  const current = await index.load();
  const result = index.maintenance(before, current, { paths: ['src/library.mjs'] });
  assert.ok(result.blockers.some((entry) => entry.code === 'evidence/source-missing'));
  assert.equal(current.source_facts.find((entry) => entry.path === 'src/library.mjs').sha256, null);
  assert.ok(result.impact_paths.includes('src/library.mjs'));
});

test('UID-stable module and source renaming retains old/new paths, relocated exports and users', async (t) => {
  const { root, index, manifest, save } = await fixture(t); const before = await index.load();
  await rename(join(root, 'src/library.mjs'), join(root, 'src/amounts.mjs'));
  manifest.modules[1].id = 'demo.amounts'; manifest.modules[1].source = [{ path: 'src/amounts.mjs' }];
  await writeFile(join(root, 'src/view.mjs'), 'import { shared } from "./amounts.mjs";\nimport { join } from "node:path";\nexport const view = () => shared;\n');
  await save(true); const current = await index.load(); assert.equal(current.status, 'ready');
  const result = index.maintenance(before, current, { paths: ['src/library.mjs', 'src/amounts.mjs', 'src/view.mjs'] });
  const renamed = result.suggestions.find((entry) => entry.kind === 'module_renamed');
  assert.equal(renamed.module_uid, '00000002'); assert.equal(renamed.evidence.current, 'demo.amounts');
  assert.deepEqual(renamed.evidence.declaration_location, { path: 'architecture.json', module_uid: '00000002' });
  assert.ok(!result.suggestions.some((entry) => entry.kind === 'module_added' || entry.kind === 'module_removed'));
  const relocated = result.suggestions.find((entry) => entry.kind === 'export_relocated' && entry.symbol === 'shared');
  assert.equal(relocated.evidence.before.locations[0].path, 'src/library.mjs');
  assert.equal(relocated.evidence.current.locations[0].path, 'src/amounts.mjs');
  assert.deepEqual(result.impact_paths, ['src/amounts.mjs', 'src/controller.mjs', 'src/library.mjs', 'src/unused.mjs', 'src/view.mjs']);
  assert.ok(!result.blockers.some((entry) => entry.code === 'UNREGISTERED_SOURCE'));
});

test('scope attribution for documents stays a review fact without requiring source registration', async (t) => {
  const { index } = await fixture(t); const current = await index.load();
  const result = index.maintenance(current, current, { paths: ['README.md'], scope: [{ path: 'README.md', module_uid: '00000002' }] });
  assert.ok(result.suggestions.some((entry) => entry.kind === 'scope_ownership_review' && entry.path === 'README.md'));
  assert.ok(!result.blockers.some((entry) => entry.code === 'UNREGISTERED_SOURCE'));
  const mismatch = index.maintenance(current, current, { paths: ['src/library.mjs'], scope: [{ path: 'src/library.mjs', module_uid: '00000003' }] });
  assert.ok(mismatch.blockers.some((entry) => entry.code === 'SCOPE_OWNERSHIP_MISMATCH'));
  const unknown = index.maintenance(current, current, { paths: ['README.md'], scope: [{ path: 'README.md', module_uid: 'ffffffff' }] });
  assert.ok(unknown.blockers.some((entry) => entry.code === 'SCOPE_MODULE_UNAVAILABLE'));
});

test('legacy without archived before facts reports a gap without guessing historical export removal', async (t) => {
  const { index } = await fixture(t); const current = await index.load();
  const result = index.maintenance(null, current, { paths: ['src/library.mjs'] });
  assert.ok(result.blockers.some((entry) => entry.code === 'BEFORE_IMPACT_UNAVAILABLE'));
  assert.ok(!result.suggestions.some((entry) => entry.kind === 'export_removed' || entry.kind === 'static_relation_removed'));
  assert.ok(result.impact_paths.includes('src/controller.mjs'));
  const olderSnapshot = structuredClone(current); delete olderSnapshot.source_facts;
  assert.ok(index.maintenance(olderSnapshot, current, { paths: [] }).blockers.some((entry) => entry.code === 'BEFORE_SOURCE_FACTS_UNAVAILABLE'));
  delete olderSnapshot.declaration_facts;
  const incomplete = index.maintenance(olderSnapshot, current, { paths: [] });
  assert.ok(incomplete.blockers.some((entry) => entry.code === 'BEFORE_DECLARATION_FACTS_UNAVAILABLE'));
  assert.ok(!incomplete.suggestions.some((entry) => entry.kind.startsWith('declared_relation_')));
});

test('declared reference deltas remain distinct from static relations; unrelated uncovered facts are excluded', async (t) => {
  const { index, manifest, save } = await fixture(t); const before = await index.load();
  const unchanged = index.maintenance(before, before, { paths: [] });
  assert.deepEqual(unchanged.affected_uids, []); assert.deepEqual(unchanged.uncovered, []);
  manifest.modules[2].deps = [{ kind: 'reference', to: 'demo.unused' }]; await save();
  const current = await index.load(); assert.equal(current.status, 'ready');
  const result = index.maintenance(before, current, { paths: ['architecture.json'], scope: [{ path: 'architecture.json', module_uid: '00000001' }] });
  const relation = result.suggestions.find((entry) => entry.kind === 'declared_relation_added');
  assert.equal(relation.evidence.current.kind, 'reference'); assert.equal(relation.evidence.current.to_uid, '00000005');
  assert.ok(!result.suggestions.some((entry) => entry.kind.startsWith('static_relation_')));
  assert.equal(result.blockers.length, 0);
  assert.ok(result.uncovered.some((entry) => entry.reason === 'dynamic_import' && entry.path === 'src/unused.mjs'));
});

test('actual source ownership transfer is visible even when public names and source bytes stay the same', async (t) => {
  const { index, manifest, save } = await fixture(t); const before = await index.load();
  manifest.modules[1].source = []; manifest.modules[1].apis = [];
  manifest.modules[4].source.push({ path: 'src/library.mjs' }); await save(true);
  const current = await index.load();
  const result = index.maintenance(before, current, { paths: ['architecture.json'] });
  assert.ok(result.suggestions.some((entry) => entry.kind === 'source_registration_removed' && entry.module_uid === '00000002' && entry.path === 'src/library.mjs'));
  assert.ok(result.suggestions.some((entry) => entry.kind === 'source_registration_added' && entry.module_uid === '00000005' && entry.path === 'src/library.mjs'));
  assert.ok(result.suggestions.some((entry) => entry.kind === 'export_added' && entry.module_uid === '00000005' && entry.symbol === 'shared'));
  assert.ok(result.affected_uids.includes('00000002')); assert.ok(result.affected_uids.includes('00000005'));
  assert.ok(result.impact_paths.includes('src/controller.mjs'));
});

test('policy-only or declaration-path changes conservatively include every before/current source and UID', async (t) => {
  const { index, manifest, save } = await fixture(t); const before = await index.load();
  manifest.policy.rules.push({ id: 'forbid', type: 'forbid-dependency', from: ['demo.controller'], to: ['demo.view'], severity: 'error' });
  await save(); const current = await index.load();
  const result = index.maintenance(before, current, { paths: ['architecture.json'], scope: [{ path: 'architecture.json', module_uid: '00000001' }] });
  assert.deepEqual(result.affected_uids, ['00000001', '00000002', '00000003', '00000004', '00000005']);
  assert.deepEqual(result.impact_paths, ['architecture.json', 'src/controller.mjs', 'src/library.mjs', 'src/unused.mjs', 'src/view.mjs']);
  assert.ok(result.suggestions.some((entry) => entry.kind === 'declaration_input_review'));
  assert.ok(result.blockers.some((entry) => entry.code === 'policy/forbid'));
  assert.deepEqual(index.maintenance(before, before, { paths: ['architecture.json'] }).affected_uids, result.affected_uids);
});

test('declared relation label changes require review without treating them as static import changes', async (t) => {
  const { index, manifest, save } = await fixture(t);
  manifest.modules[2].deps = [{ kind: 'reference', to: 'demo.unused', label: { zh: '旧理由', en: 'Old reason' } }]; await save();
  const before = await index.load();
  manifest.modules[2].deps[0].label = { zh: '新理由', en: 'New reason' }; await save();
  const current = await index.load();
  const result = index.maintenance(before, current, { paths: ['architecture.json'] });
  assert.ok(result.suggestions.some((entry) => entry.kind === 'declared_relation_changed' && entry.evidence.current.label.en === 'New reason'));
  assert.ok(!result.suggestions.some((entry) => entry.kind.startsWith('static_relation_')));
});

test('exports outside declared source segments are explicitly uncovered in affected files', async (t) => {
  const { index, manifest, save } = await fixture(t);
  manifest.modules[1].source[0] = { path: 'src/library.mjs', line: 1, end_line: 1 }; await save();
  const current = await index.load();
  const result = index.maintenance(current, current, { paths: ['src/library.mjs'] });
  assert.ok(result.uncovered.some((entry) => entry.reason === 'unowned_export' && entry.symbol === 'internal' && entry.line === 2));
});
