import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArchitectureIndex } from '../src/architecture/index.mjs';
import { createProviderServer } from '../src/provider-server.mjs';
import { createObservationStore, ObservationStore } from '../src/store.mjs';
import { readObservation } from '../src/read.mjs';
import { withWorkspaceLock } from '../src/workspace-lock.mjs';
import { fingerprintOf } from '../vendor/normify/engine/store.js';
import { startMcpServer } from './helpers/mcp-client.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(ROOT, 'src/provider-server.mjs');

async function workspace(t, { cache = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sol-provider-workspace-'));
  const cacheRoot = cache ? await mkdtemp(join(tmpdir(), 'sol-provider-cache-')) : undefined;
  await mkdir(join(root, 'src'));
  const cleanup = async () => {
    await rm(root, { recursive: true, force: true });
    if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true });
  };
  return { root, cacheRoot, cleanup };
}

async function writeDeclaration(root, sources) {
  const module = {
    id: 'demo',
    uid: '00000001',
    parent: null,
    name: { zh: '演示模块', en: 'Demo module' },
    description: { zh: '演示组件职责', en: 'Demonstration component responsibility' },
    source: sources.map((path) => ({ path })),
    revision: '0'.repeat(40),
    updated_at: '2026-10-08T00:00:00Z',
    fingerprint: '0'.repeat(64),
    apis: [{ protocol: 'rpc', path: 'escapeHtml', description: { zh: '转义 HTML', en: 'Escape HTML' } }],
  };
  const declaration = {
    schema_version: 1,
    modules: [module],
    policy: { schema_version: 1, updated_at: '2026-10-08T00:00:00Z', rules: [] },
  };
  await writeFile(join(root, 'architecture.json'), JSON.stringify(declaration));
  return declaration;
}

async function makeProviderClient(t, root, cacheRoot, { roots = ['src'], files = ['architecture.json'] } = {}) {
  const configPath = join(dirname(root), 'sol-provider-config-' + randomUUID() + '.json');
  await writeFile(configPath, JSON.stringify({
    architecture_path: 'architecture.json',
    discovery_scope: { roots, files },
  }));
  t.after(() => rm(configPath, { force: true }));
  const client = startMcpServer({
    workspace: root,
    rulesPath: '',
    serverPath: ENTRY,
    serverArgs: ['--workspace', root, '--config', configPath, '--cache-root', cacheRoot],
  });
  t.after(() => client.terminateTree());
  return client;
}

function packet(response) {
  assert.equal(response.result?.isError, false, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}

async function recallBytes(client, raw) {
  const parts = [];
  let cursor;
  do {
    const response = await client.request('tools/call', {
      name: 'sol_recall',
      arguments: { handle: raw.handle, selector: { kind: 'bytes', start: 0, end: raw.bytes }, ...(cursor ? { cursor } : {}) },
    });
    const value = packet(response);
    assert.equal(value.sha256, raw.sha256);
    for (const chunk of value.chunks) parts.push(Buffer.from(chunk.base64, 'base64'));
    cursor = value.next_cursor;
  } while (cursor);
  return Buffer.concat(parts);
}

test('createProviderServer returns the documented server, store, and read policy', async (t) => {
  const { root, cacheRoot, cleanup } = await workspace(t);
  await writeFile(join(root, 'src/safe.mjs'), 'export const safe = true;\n');
  await writeDeclaration(root, ['src/safe.mjs']);
  const provider = await createProviderServer(root, {
    architecture_path: 'architecture.json',
    discovery_scope: { roots: ['src'], files: ['architecture.json'] },
    cache_root: cacheRoot,
  });
  t.after(async () => {
    await provider.server.close();
    await cleanup();
  });
  assert.ok(provider.server);
  assert.equal(provider.store.observationsRoot, join(await realpath(cacheRoot), 'observations'));
  assert.equal(provider.policy.assertScoped('src/safe.mjs'), 'src/safe.mjs');
  assert.throws(() => provider.policy.assertScoped('outside.mjs'), { code: 'DISCOVERY_SCOPE_DENIED' });
});

test('provider initialize advertises the fixed protocol and exposes exactly three tools', { timeout: 15000 }, async (t) => {
  const { root, cacheRoot, cleanup } = await workspace(t);
  await writeFile(join(root, 'src/safe.mjs'), 'export function escapeHtml(value) { return String(value); }\n');
  await writeDeclaration(root, ['src/safe.mjs']);
  const client = await makeProviderClient(t, root, cacheRoot);
  t.after(cleanup);
  const initialized = await client.initialize();
  const capability = initialized.result.capabilities.experimental['sol-component-discovery'];
  assert.deepEqual(capability, {
    protocol: 'sol-component-discovery/1',
    workspace_id: createHash('sha256').update(process.platform === 'win32' ? (await realpath(root)).toLowerCase() : await realpath(root)).digest('hex'),
    declaration: { path: 'architecture.json', sha256: createHash('sha256').update(await readFile(join(root, 'architecture.json'))).digest('hex') },
    product_write: false,
    observation_cache: true,
  });
  const listed = await client.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), ['sol_architecture_query', 'sol_read_file', 'sol_recall']);
  assert.equal((await readdir(join(root, '.codex', 'sol'))).includes('observations'), false);
});

test('query archives complete versions and selected view for byte-exact SHA-verified recall', { timeout: 15000 }, async (t) => {
  const { root, cacheRoot, cleanup } = await workspace(t);
  const source = 'export function escapeHtml(value) { return String(value).replaceAll("<", "&lt;"); }\n';
  await writeFile(join(root, 'src/safe.mjs'), source);
  const declaration = await writeDeclaration(root, ['src/safe.mjs']);
  declaration.modules[0].fingerprint = (await fingerprintOf(root, [{ path: 'src/safe.mjs' }])).hash;
  await writeFile(join(root, 'architecture.json'), JSON.stringify(declaration));
  const client = await makeProviderClient(t, root, cacheRoot);
  t.after(cleanup);
  await client.initialize();
  const value = packet(await client.request('tools/call', {
    name: 'sol_architecture_query', arguments: { paths: ['src/safe.mjs'], capability: 'escapeHtml' },
  }));
  assert.equal(value.protocol, 'sol-component-discovery/1');
  assert.equal(value.declaration.path, 'architecture.json');
  assert.ok(value.raw.handle);
  assert.ok(Number.isSafeInteger(value.raw.bytes));
  assert.match(value.raw.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(value.candidates[0].symbol, 'escapeHtml');
  const rawBytes = await recallBytes(client, value.raw);
  assert.equal(rawBytes.length, value.raw.bytes);
  assert.equal(createHash('sha256').update(rawBytes).digest('hex'), value.raw.sha256);
  const raw = JSON.parse(rawBytes.toString('utf8'));
  assert.deepEqual(raw.declaration, value.declaration);
  assert.deepEqual(raw.query, { paths: ['src/safe.mjs'], capability: 'escapeHtml' });
  assert.deepEqual(raw.versions, [
    { path: 'architecture.json', sha256: createHash('sha256').update(await readFile(join(root, 'architecture.json'))).digest('hex') },
    { path: 'src/safe.mjs', sha256: createHash('sha256').update(source).digest('hex') },
  ]);
  const selectedKeys = ['schema_version', 'kind', 'version', 'status', 'engine', 'owners', 'candidates', 'impact', 'declared_impact', 'diagnostics', 'uncovered', 'coverage'];
  assert.deepEqual(Object.fromEntries(selectedKeys.map((key) => [key, value[key]])), raw.selected);
  assert.ok((await readdir(join(cacheRoot, 'observations'))).length > 0);
});

test('all indexed source paths are scope-checked before reading any source bytes', { timeout: 15000 }, async (t) => {
  const { root, cacheRoot, cleanup } = await workspace(t);
  await writeFile(join(root, 'src/too-large.mjs'), Buffer.alloc(1024 * 1024 + 1, 0x20));
  await writeFile(join(root, 'outside.mjs'), 'export const hidden = true;\n');
  await writeDeclaration(root, ['src/too-large.mjs', 'outside.mjs']);
  const client = await makeProviderClient(t, root, cacheRoot);
  t.after(cleanup);
  await client.initialize();
  const response = await client.request('tools/call', {
    name: 'sol_architecture_query', arguments: { paths: ['src/too-large.mjs'], capability: '' },
  });
  assert.equal(response.result.isError, true);
  const error = JSON.parse(response.result.content[0].text);
  assert.equal(error.error.code, 'DISCOVERY_SCOPE_DENIED');
  assert.deepEqual(await readdir(join(cacheRoot, 'observations')), []);
});

test('scoped reads reject credential paths and linked paths before observation capture', { timeout: 15000 }, async (t) => {
  const { root, cacheRoot, cleanup } = await workspace(t);
  await writeFile(join(root, 'src/safe.mjs'), 'export const safe = true;\n');
  await writeFile(join(root, 'src/.env'), 'API_TOKEN=do-not-read\n');
  const outside = await mkdtemp(join(tmpdir(), 'sol-provider-link-target-'));
  await writeFile(join(outside, 'secret.mjs'), 'export const token = "private";\n');
  await symlink(outside, join(root, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeDeclaration(root, ['src/safe.mjs']);
  const client = await makeProviderClient(t, root, cacheRoot);
  t.after(cleanup);
  await client.initialize();

  const secret = await client.request('tools/call', { name: 'sol_read_file', arguments: { path: 'src/.env' } });
  assert.equal(secret.result.isError, true);
  assert.equal(JSON.parse(secret.result.content[0].text).error.code, 'SECURITY_DENIED');

  const linked = await client.request('tools/call', { name: 'sol_read_file', arguments: { path: 'src/linked/secret.mjs' } });
  assert.equal(linked.result.isError, true);
  assert.equal(JSON.parse(linked.result.content[0].text).error.code, 'PATH_ERROR');
  assert.deepEqual(await readdir(join(cacheRoot, 'observations')), []);
});

test('default store and index behavior remain compatible; explicit cache is separate and cancellation cleans temporary files', async (t) => {
  const { root, cacheRoot, cleanup } = await workspace(t);
  t.after(cleanup);
  await writeFile(join(root, 'src/safe.mjs'), 'export const safe = true;\n');
  await writeDeclaration(root, ['src/safe.mjs']);
  await assert.rejects(createObservationStore(root, { cacheRoot: join(root, 'inside-cache') }), { code: 'STORAGE_ERROR' });
  assert.equal((await readdir(root)).includes('.codex'), false);
  const operationId = randomUUID();
  const operationCacheRoot = join(root, '.codex', 'engineering-cycle', 'provider-cache', operationId, 'observations');
  const operationCache = await createObservationStore(root, { cacheRoot: operationCacheRoot });
  assert.equal(operationCache.observationsRoot, join(await realpath(operationCacheRoot), 'observations'));
  const aliasedCaches = [
    join(root, '.codex', 'sol', 'provider-cache', randomUUID(), 'observations'),
    join(root, 'src', '.codex', 'sol', 'provider-cache', randomUUID(), 'observations'),
  ];
  for (const alias of aliasedCaches) await assert.rejects(createObservationStore(root, { cacheRoot: alias }), { code: 'STORAGE_ERROR' });

  const linkedOperation = join(root, '.codex', 'engineering-cycle', 'provider-cache', randomUUID());
  await mkdir(join(root, '.codex', 'engineering-cycle', 'provider-cache'), { recursive: true });
  await symlink(cacheRoot, linkedOperation, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(linkedOperation, { recursive: true, force: true }));
  await assert.rejects(createObservationStore(root, { cacheRoot: join(linkedOperation, 'observations') }), { code: 'STORAGE_ERROR' });

  const linkedCache = join(dirname(cacheRoot), 'sol-provider-cache-link-' + randomUUID());
  await symlink(cacheRoot, linkedCache, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(linkedCache, { force: true }));
  await assert.rejects(new ObservationStore(root, { cacheRoot: linkedCache }).initialize(), { code: 'STORAGE_ERROR' });

  const defaultStore = await createObservationStore(root);
  assert.equal(defaultStore.observationsRoot, join(defaultStore.solRoot, 'observations'));
  const index = new ArchitectureIndex(root, 'architecture.json');
  assert.equal((await index.load()).kind, 'architecture_snapshot');

  const store = await createObservationStore(root, { cacheRoot });
  assert.equal(store.observationsRoot, join(await realpath(cacheRoot), 'observations'));
  const controller = new AbortController();
  let firstChunkProcessed;
  const firstChunk = new Promise((resolve) => { firstChunkProcessed = resolve; });
  const captured = withWorkspaceLock(store, async () => readObservation(store, {
    schema_version: 1,
    workspace_id: store.workspaceId,
    call_id: randomUUID(),
    tool: 'sol_read_file',
    captured_at: new Date().toISOString(),
    media_type: 'text/plain; charset=utf-8',
    encoding: 'utf-8',
    source_form: 'stream_bytes',
    channel: 'response',
  }, async () => (async function* source() {
    yield Buffer.alloc(32 * 1024, 0x61);
    firstChunkProcessed();
    await new Promise((resolve) => setTimeout(resolve, 20));
    yield Buffer.alloc(32 * 1024, 0x62);
  }()), { signal: controller.signal }), { signal: controller.signal });
  await firstChunk;
  controller.abort();
  const result = await captured;
  assert.equal(result.isError, true);
  const entries = await readdir(store.observationsRoot);
  assert.equal(entries.some((name) => name.endsWith('.tmp')), false);
  await withWorkspaceLock(store, async () => 'reacquired');
  const metas = await Promise.all(entries.map((handle) => store.verify(handle)));
  assert.ok(metas.every(({ meta }) => meta.complete === false));
});
