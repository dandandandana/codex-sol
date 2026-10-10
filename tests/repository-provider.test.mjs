import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalProviderDigest, createProviderPolicy, parseProviderConfig, PROVIDER_V2_PROTOCOL } from '../src/provider-policy.mjs';
import { RepositoryIndex } from '../src/repository-index.mjs';
import { createProviderServer } from '../src/provider-server.mjs';
import { startMcpServer } from './helpers/mcp-client.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(ROOT, 'src/provider-server.mjs');
const BUDGETS = { max_sources: 128, max_file_bytes: 262144, max_total_bytes: 1048576, timeout_ms: 30000 };
const TOOL_NAMES = ['sol_architecture_query', 'sol_read_file', 'sol_recall'];
const WORKSPACE_CLIENTS = new Map();

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'sol-repository-workspace-'));
  const cacheRoot = await mkdtemp(join(tmpdir(), 'sol-repository-cache-'));
  const clients = [];
  WORKSPACE_CLIENTS.set(root, clients);
  t.after(async () => {
    for (const client of clients) await client.terminateTree();
    await rm(root, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
    WORKSPACE_CLIENTS.delete(root);
  });
  return { root, cacheRoot };
}

async function makeRepositoryClient(t, root, cacheRoot, {
  roots = ['.'], files = [], budgets = BUDGETS, excluded_paths = [], excluded_sha256 = [],
} = {}) {
  const canonicalRoot = await realpath(root);
  const configPath = join(dirname(root), `sol-repository-config-${randomUUID()}.json`);
  const discoveryScope = { roots, files };
  const config = {
    protocol: PROVIDER_V2_PROTOCOL,
    mode: 'repository',
    workspace_root: canonicalRoot,
    workspace_id: createHash('sha256').update(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot).digest('hex'),
    discovery_scope: discoveryScope,
    scope_digest: canonicalProviderDigest(discoveryScope),
    budgets,
    excluded_paths,
    excluded_sha256,
  };
  await writeFile(configPath, JSON.stringify(config));
  t.after(() => rm(configPath, { force: true }));
  const client = startMcpServer({
    workspace: root,
    rulesPath: '',
    serverPath: ENTRY,
    serverArgs: ['--workspace', root, '--config', configPath, '--cache-root', cacheRoot],
  });
  WORKSPACE_CLIENTS.get(root)?.push(client);
  const initialized = await client.initialize();
  return { client, config, initialized };
}

function text(response) { return JSON.parse(response.result.content[0].text); }
function packet(response) {
  assert.equal(response.result?.isError, false, JSON.stringify(response));
  return text(response);
}

async function query(client, input = { paths: [], capability: '' }) {
  return packet(await client.request('tools/call', { name: 'sol_architecture_query', arguments: input }));
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
  const bytes = Buffer.concat(parts);
  assert.equal(bytes.length, raw.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), raw.sha256);
  return bytes;
}

test('repository v2 initializes on an unregistered empty workspace and captures a complete empty inventory', { timeout: 15000 }, async (t) => {
  const { root, cacheRoot } = await workspace(t);
  const { client, config, initialized } = await makeRepositoryClient(t, root, cacheRoot);
  const capability = initialized.result.capabilities.experimental['sol-component-discovery'];
  assert.deepEqual(capability, {
    protocol: 'sol-component-discovery/2', mode: 'repository', workspace_id: config.workspace_id,
    scope_digest: config.scope_digest,
    exclusion_digest: canonicalProviderDigest({ excluded_paths: [], excluded_sha256: [] }),
    product_write: false, observation_cache: true,
  });
  const listed = await client.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), TOOL_NAMES);

  const value = await query(client);
  assert.equal(value.kind, 'repository_query_v2');
  assert.equal(value.collection_stable, true);
  assert.equal(value.coverage.enumeration.status, 'complete');
  assert.equal(value.coverage.candidates.status, 'complete');
  assert.deepEqual(value.candidates, []);
  const raw = JSON.parse((await recallBytes(client, value.raw)).toString('utf8'));
  assert.deepEqual(Object.keys(raw), [
    'schema_version', 'kind', 'protocol', 'mode', 'workspace_id', 'scope_digest', 'exclusion_digest', 'inventory_digest',
    'path_inventory', 'path_inventory_digest', 'collection_stable', 'query', 'versions', 'sources', 'candidates',
    'coverage', 'relations', 'unresolved', 'exclusions',
  ]);
  assert.equal(raw.kind, 'repository_query_v2');
  assert.deepEqual(raw.sources, []);
  assert.deepEqual(raw.versions, []);
  assert.deepEqual(raw.path_inventory, { files: [], skipped_directories: ['.codex'] });
  assert.equal(raw.path_inventory_digest, canonicalProviderDigest(raw.path_inventory));
  assert.equal(raw.coverage.relations.status, 'complete_static');
  assert.ok((await readdir(join(cacheRoot, 'observations'))).length > 0);
});

test('repository candidates include shared JavaScript and TSX with unknown symbols; a zero keyword hit keeps the full set', { timeout: 15000 }, async (t) => {
  const { root, cacheRoot } = await workspace(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'ui'), { recursive: true });
  const shared = 'export function shared() { return "shared"; }\n';
  const consumer = 'import { shared } from "./shared.js";\nexport const value = shared();\n';
  const tsx = 'import { shared } from "../src/shared.js";\nexport function App() { return <div>{shared()}</div>; }\n';
  const commonjs = 'module.exports = { legacy: true };\n';
  await writeFile(join(root, 'src/shared.js'), shared);
  await writeFile(join(root, 'src/consumer.js'), consumer);
  await writeFile(join(root, 'src/legacy.js'), commonjs);
  await writeFile(join(root, 'ui/App.tsx'), tsx);
  const { client } = await makeRepositoryClient(t, root, cacheRoot);
  const value = await query(client, { paths: [], capability: 'keyword-with-zero-matches' });
  assert.equal(value.candidates_count, 4);
  assert.equal(value.collection_stable, true);

  const raw = JSON.parse((await recallBytes(client, value.raw)).toString('utf8'));
  const paths = new Set(raw.candidates.map((candidate) => candidate.path));
  assert.deepEqual(paths, new Set(['src/shared.js', 'src/consumer.js', 'src/legacy.js', 'ui/App.tsx']));
  assert.deepEqual(new Set(raw.sources.map((source) => source.path)), paths);
  assert.deepEqual(raw.path_inventory, {
    files: ['src/consumer.js', 'src/legacy.js', 'src/shared.js', 'ui/App.tsx'],
    skipped_directories: ['.codex'],
  });
  assert.equal(raw.path_inventory_digest, canonicalProviderDigest(raw.path_inventory));
  for (const source of raw.sources) {
    assert.equal(source.sha256, createHash('sha256').update(await readFile(join(root, source.path))).digest('hex'));
    assert.deepEqual(raw.versions.find((version) => version.path === source.path), { path: source.path, sha256: source.sha256 });
  }
  const tsxCandidate = raw.candidates.find((candidate) => candidate.path === 'ui/App.tsx');
  assert.equal(tsxCandidate.symbol_status, 'unknown');
  assert.equal(Object.hasOwn(tsxCandidate, 'symbols'), false);
  assert.equal(tsxCandidate.candidate_id, canonicalProviderDigest({ workspace_id: raw.workspace_id, path: 'ui/App.tsx' }));
  const commonjsCandidate = raw.candidates.find((candidate) => candidate.path === 'src/legacy.js');
  assert.equal(commonjsCandidate.symbol_status, 'unknown');
  assert.equal(Object.hasOwn(commonjsCandidate, 'symbols'), false);
  const relation = raw.relations.find((item) => item.source.path === 'src/consumer.js');
  assert.equal(relation.kind, 'static');
  assert.deepEqual(relation.source, {
    path: 'src/consumer.js', sha256: raw.sources.find((source) => source.path === 'src/consumer.js').sha256,
    line_start: 1, line_end: 1,
  });
  assert.equal(relation.target.path, 'src/shared.js');
  assert.equal(raw.coverage.relations.status, 'partial');

  const zeroHit = await query(client, { paths: [], capability: 'definitely-no-export-or-path-uses-this-term' });
  const zeroRaw = JSON.parse((await recallBytes(client, zeroHit.raw)).toString('utf8'));
  assert.equal(zeroRaw.candidates.length, 4);
  assert.deepEqual(new Set(zeroRaw.candidates.map((candidate) => candidate.candidate_id)), new Set(raw.candidates.map((candidate) => candidate.candidate_id)));
});

test('repository budgets report partial or blocked coverage instead of an empty complete inventory', { timeout: 15000 }, async (t) => {
  const { root, cacheRoot } = await workspace(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.js'), 'export const a = true;\n');
  await writeFile(join(root, 'src/b.js'), 'export const b = true;\n');
  const { client } = await makeRepositoryClient(t, root, cacheRoot, { budgets: { ...BUDGETS, max_sources: 1 } });
  const value = await query(client);
  const raw = JSON.parse((await recallBytes(client, value.raw)).toString('utf8'));
  assert.equal(raw.coverage.enumeration.status, 'complete');
  assert.equal(raw.coverage.candidates.status, 'partial');
  assert.equal(raw.coverage.candidates.count, 1);
  assert.equal(raw.collection_stable, false);
  assert.ok(raw.unresolved.some((item) => item.reason === 'max_sources'));
  assert.equal(raw.inventory_digest, canonicalProviderDigest({
    scope_digest: raw.scope_digest,
    entries: [
      ...raw.sources.map((item) => ({ kind: 'source', path: item.path, sha256: item.sha256, bytes: item.bytes })),
      ...raw.exclusions.map((item) => ({ kind: 'excluded', ...item })),
      ...raw.unresolved.filter((item) => item.kind !== 'relation').map(({ kind: unresolvedKind, ...item }) => ({
        kind: 'unresolved', unresolved_kind: unresolvedKind, ...item,
      })),
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
      || (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)),
  }));

  const other = await workspace(t);
  await mkdir(join(other.root, 'src'), { recursive: true });
  await writeFile(join(other.root, 'src/large.tsx'), 'x'.repeat(64));
  const blocked = await makeRepositoryClient(t, other.root, other.cacheRoot, { budgets: { ...BUDGETS, max_file_bytes: 32 } });
  const blockedValue = await query(blocked.client);
  const blockedRaw = JSON.parse((await recallBytes(blocked.client, blockedValue.raw)).toString('utf8'));
  assert.equal(blockedRaw.coverage.candidates.status, 'blocked');
  assert.equal(blockedRaw.coverage.candidates.count, 0);
  assert.equal(blockedRaw.collection_stable, false);
  assert.ok(blockedRaw.unresolved.some((item) => item.reason === 'max_file_bytes'));

  const total = await workspace(t);
  await mkdir(join(total.root, 'src'), { recursive: true });
  await writeFile(join(total.root, 'src/a.tsx'), 'a'.repeat(15));
  await writeFile(join(total.root, 'src/b.tsx'), 'b'.repeat(15));
  const limited = await makeRepositoryClient(t, total.root, total.cacheRoot, {
    budgets: { ...BUDGETS, max_file_bytes: 32, max_total_bytes: 20 },
  });
  const limitedValue = await query(limited.client);
  const limitedRaw = JSON.parse((await recallBytes(limited.client, limitedValue.raw)).toString('utf8'));
  assert.equal(limitedRaw.coverage.candidates.status, 'partial');
  assert.equal(limitedRaw.coverage.candidates.count, 1);
  assert.equal(limitedRaw.collection_stable, false);
  assert.ok(limitedRaw.unresolved.some((item) => item.reason === 'max_total_bytes'));
});

test('repository collection becomes unstable when a file appears between its two scans', { timeout: 15000 }, async (t) => {
  const { root } = await workspace(t);
  await writeFile(join(root, 'before.js'), 'export const before = true;\n');
  const scope = { roots: ['.'], files: [] };
  const index = new RepositoryIndex(root, {
    policy: createProviderPolicy(root, scope, { mode: 'repository' }),
    workspaceId: 'a'.repeat(64),
    scopeDigest: canonicalProviderDigest(scope),
    budgets: BUDGETS,
  });
  const collect = index.collect.bind(index);
  let collectionCount = 0;
  const collections = [];
  index.collect = async (options) => {
    const inventory = await collect(options);
    collectionCount += 1;
    collections.push(inventory);
    if (collectionCount === 1) {
      await writeFile(join(root, 'added-between-scans.js'), 'export const added = true;\n');
      await writeFile(join(root, '.env'), 'TOKEN=must-not-become-a-source');
    }
    return inventory;
  };

  const raw = await index.load({ paths: [], capability: '' });
  assert.equal(collectionCount, 2);
  assert.notEqual(collections[0].path_inventory_digest, collections[1].path_inventory_digest);
  assert.deepEqual(collections[1].path_inventory.files, ['.env', 'added-between-scans.js', 'before.js']);
  assert.equal(collections[1].coverage.enumeration.count, collections[1].path_inventory.files.length);
  assert.ok(collections[1].exclusions.some((item) => item.path === '.env' && item.reason === 'secret_file'));
  assert.equal(collections[1].sources.some((item) => item.path === '.env'), false);
  assert.equal(raw.collection_stable, false);
  assert.equal(raw.coverage.enumeration.status, 'partial');
  assert.ok(raw.unresolved.some((item) => item.kind === 'collection'
    && item.path === '.' && item.reason === 'collection_changed'));
  assert.deepEqual(raw.path_inventory, { files: ['before.js'], skipped_directories: [] });
  assert.equal(raw.path_inventory_digest, canonicalProviderDigest(raw.path_inventory));
  assert.equal(raw.path_inventory_digest, collections[0].path_inventory_digest);
});

test('repository mode excludes secrets and links and rejects out-of-scope reads before capture', { timeout: 15000 }, async (t) => {
  const { root, cacheRoot } = await workspace(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/safe.js'), 'export const safe = true;\n');
  await writeFile(join(root, 'src/invalid.tsx'), Buffer.from([0xff, 0xfe]));
  await writeFile(join(root, 'src/.env'), 'TOKEN=never-read\n');
  const outside = await mkdtemp(join(tmpdir(), 'sol-repository-link-target-'));
  await writeFile(join(outside, 'secret.js'), 'export const secret = true;\n');
  await symlink(outside, join(root, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(outside, { recursive: true, force: true }));
  const { client } = await makeRepositoryClient(t, root, cacheRoot, { roots: ['src'] });
  const value = await query(client);
  const raw = JSON.parse((await recallBytes(client, value.raw)).toString('utf8'));
  assert.ok(raw.exclusions.some((item) => item.path === 'src/.env' && item.reason === 'secret_file'));
  assert.ok(raw.path_inventory.files.includes('src/.env'));
  assert.ok(raw.path_inventory.files.includes('src/safe.js'));
  assert.equal(raw.path_inventory.files.includes('src/linked'), false);
  assert.equal(raw.coverage.enumeration.count, raw.path_inventory.files.length);
  assert.equal(raw.path_inventory_digest, canonicalProviderDigest(raw.path_inventory));
  assert.ok(raw.exclusions.some((item) => item.path === 'src/linked' && item.reason === 'symbolic_link'));
  assert.ok(raw.unresolved.some((item) => item.path === 'src/invalid.tsx' && item.reason === 'invalid_utf8'));
  assert.deepEqual(new Set(raw.candidates.map((candidate) => candidate.path)), new Set(['src/safe.js']));

  for (const [path, expected] of [
    ['outside.js', ['DISCOVERY_SCOPE_DENIED']],
    ['src/.env', ['SECURITY_DENIED']],
    ['src/linked/secret.js', ['PATH_ERROR', 'IO_ERROR']],
  ]) {
    const response = await client.request('tools/call', { name: 'sol_read_file', arguments: { path } });
    assert.equal(response.result.isError, true);
    const error = text(response);
    assert.ok(expected.includes(error.error.code), JSON.stringify(response));
  }
  const outsideQuery = await client.request('tools/call', {
    name: 'sol_architecture_query', arguments: { paths: ['outside.js'], capability: '' },
  });
  assert.equal(outsideQuery.result.isError, true);
  assert.equal(text(outsideQuery).error.code, 'DISCOVERY_SCOPE_DENIED');
});

test('repository v2 binds exact authority-document and implementation-verdict exclusions into every query', { timeout: 15000 }, async (t) => {
  const { root, cacheRoot } = await workspace(t);
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'nested'), { recursive: true });
  await mkdir(join(root, 'build'), { recursive: true });
  const authorityBytes = Buffer.from('cycle design authority, do not return');
  const verdictBytes = Buffer.from('captured implementation verdict, do not return');
  await writeFile(join(root, 'docs/authority.md'), authorityBytes);
  await writeFile(join(root, 'docs/verdict.md'), verdictBytes);
  await writeFile(join(root, 'src/feature.js'), 'export const feature = true;\n');
  await writeFile(join(root, '.git/config'), 'git credential payload must not be read');
  await writeFile(join(root, 'node_modules/nested/private.js'), 'export const privateCode = true;\n');
  await writeFile(join(root, 'build/generated.js'), 'export const generated = true;\n');
  const verdictSha = createHash('sha256').update(verdictBytes).digest('hex');
  const { client, config, initialized } = await makeRepositoryClient(t, root, cacheRoot, {
    excluded_paths: ['docs/authority.md'],
    excluded_sha256: [verdictSha],
  });
  const exclusionDigest = canonicalProviderDigest({ excluded_paths: ['docs/authority.md'], excluded_sha256: [verdictSha] });
  assert.equal(initialized.result.capabilities.experimental['sol-component-discovery'].exclusion_digest, exclusionDigest);

  const value = await query(client);
  assert.equal(value.exclusion_digest, exclusionDigest);
  const rawBytes = await recallBytes(client, value.raw);
  const rawText = rawBytes.toString('utf8');
  const raw = JSON.parse(rawText);
  assert.equal(raw.exclusion_digest, exclusionDigest);
  assert.ok(raw.exclusions.some((item) => item.path === 'docs/authority.md' && item.reason === 'authority-document'));
  assert.ok(raw.exclusions.some((item) => item.path === 'docs/verdict.md' && item.reason === 'implementation-verdict'));
  assert.deepEqual(raw.path_inventory, {
    files: ['docs/authority.md', 'docs/verdict.md', 'src/feature.js'],
    skipped_directories: ['.codex', '.git', 'build', 'node_modules'],
  });
  assert.equal(raw.coverage.enumeration.count, raw.path_inventory.files.length);
  assert.equal(raw.path_inventory_digest, canonicalProviderDigest(raw.path_inventory));
  assert.deepEqual(new Set(raw.candidates.map((item) => item.path)), new Set(['src/feature.js']));
  assert.equal(rawText.includes(authorityBytes.toString()), false);
  assert.equal(rawText.includes(verdictBytes.toString()), false);
  assert.equal(rawText.includes(verdictSha), false);
  assert.equal(rawText.includes('git credential payload must not be read'), false);

  const captureCount = (await readdir(join(cacheRoot, 'observations'))).length;
  for (const path of ['docs/authority.md', 'docs/verdict.md']) {
    const response = await client.request('tools/call', { name: 'sol_read_file', arguments: { path } });
    assert.equal(response.result.isError, true);
    assert.equal(text(response).error.code, 'SECURITY_DENIED');
  }
  assert.equal((await readdir(join(cacheRoot, 'observations'))).length, captureCount);
  assert.deepEqual(config.excluded_paths, ['docs/authority.md']);
});

test('repository workspace and scope identities are strict and v1 still rejects the repository root sentinel', async (t) => {
  const { root, cacheRoot } = await workspace(t);
  const canonicalRoot = await realpath(root);
  const scope = { roots: ['.'], files: [] };
  const config = {
    protocol: PROVIDER_V2_PROTOCOL, mode: 'repository', workspace_root: canonicalRoot,
    workspace_id: createHash('sha256').update(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot).digest('hex'),
    discovery_scope: scope, scope_digest: canonicalProviderDigest(scope), budgets: BUDGETS,
  };
  assert.doesNotThrow(() => parseProviderConfig(config));
  assert.deepEqual(parseProviderConfig(config).excluded_paths, []);
  assert.deepEqual(parseProviderConfig(config).excluded_sha256, []);
  assert.throws(() => parseProviderConfig({ ...config, excluded_paths: Array.from({ length: 65 }, (_, index) => `docs/${index}.md`) }), { code: 'CONFIG_ERROR' });
  assert.throws(() => parseProviderConfig({ ...config, excluded_paths: ['docs/I.md', 'docs/I.md'] }), { code: 'CONFIG_ERROR' });
  assert.throws(() => parseProviderConfig({ ...config, excluded_sha256: ['a'.repeat(64), 'a'.repeat(64)] }), { code: 'CONFIG_ERROR' });
  await assert.rejects(createProviderServer(root, { ...config, workspace_id: '0'.repeat(64), cache_root: cacheRoot }), { code: 'CONFIG_ERROR' });
  assert.throws(() => parseProviderConfig({ ...config, scope_digest: '0'.repeat(64) }), { code: 'CONFIG_ERROR' });
  assert.throws(() => parseProviderConfig({ architecture_path: 'architecture.json', discovery_scope: scope }), { code: 'PATH_ERROR' });

  const configPath = join(dirname(root), `sol-v1-config-${randomUUID()}.json`);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'architecture.json'), '{}');
  await writeFile(configPath, JSON.stringify({ architecture_path: 'architecture.json', discovery_scope: { roots: ['src'], files: ['architecture.json'] } }));
  const client = startMcpServer({ workspace: root, rulesPath: '', serverPath: ENTRY,
    serverArgs: ['--workspace', root, '--config', configPath, '--cache-root', cacheRoot] });
  WORKSPACE_CLIENTS.get(root)?.push(client);
  t.after(() => rm(configPath, { force: true }));
  const initialized = await client.initialize();
  const capability = initialized.result.capabilities.experimental['sol-component-discovery'];
  assert.equal(capability.protocol, 'sol-component-discovery/1');
  assert.equal(Object.hasOwn(capability, 'mode'), false);
  const listed = await client.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), TOOL_NAMES);
});
