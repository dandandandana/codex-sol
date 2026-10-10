import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packageProvider } from '../scripts/package-provider.mjs';
import { canonicalProviderDigest, PROVIDER_V2_PROTOCOL } from '../src/provider-policy.mjs';
import { startMcpServer } from './helpers/mcp-client.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sol-provider-package-workspace-'));
  const cacheRoot = await mkdtemp(join(tmpdir(), 'sol-provider-package-cache-'));
  const out = join(tmpdir(), 'sol-provider-package-out-' + randomUUID());
  const configPath = join(dirname(root), 'sol-provider-package-config-' + randomUUID() + '.json');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/example.mjs'), 'export const example = true;\n');
  await writeFile(join(root, 'architecture.json'), JSON.stringify({
    schema_version: 1,
    modules: [{
      id: 'demo', uid: '00000001', parent: null,
      name: { zh: '演示模块', en: 'Demo module' },
      description: { zh: '演示组件职责', en: 'Demonstration component responsibility' },
      source: [{ path: 'src/example.mjs' }], revision: '0'.repeat(40),
      updated_at: '2026-10-08T00:00:00Z', fingerprint: '0'.repeat(64),
    }],
    policy: { schema_version: 1, updated_at: '2026-10-08T00:00:00Z', rules: [] },
  }));
  await writeFile(configPath, JSON.stringify({ architecture_path: 'architecture.json', discovery_scope: { roots: ['src'], files: ['architecture.json'] } }));
  const cleanup = async () => {
    await rm(root, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(configPath, { force: true });
  };
  return { root, cacheRoot, out, configPath, cleanup };
}

test('provider package is an independently executable allowlisted MCP artifact with a verifiable manifest', { timeout: 30000 }, async (t) => {
  const { root, cacheRoot, out, configPath, cleanup } = await fixture(t);
  const actual = await packageProvider({ out });
  assert.equal(await realpath(actual), await realpath(out));
  const packagedRoot = actual;
  const clients = [];
  const repositoryConfigPath = join(dirname(root), 'sol-provider-package-v2-config-' + randomUUID() + '.json');
  t.after(async () => {
    for (const client of clients) await client.terminateTree();
    await rm(repositoryConfigPath, { force: true });
    await rm(packagedRoot, { recursive: true, force: true });
    await cleanup();
  });

  const manifest = JSON.parse(await readFile(join(packagedRoot, 'provider-manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest), ['schema_revision', 'protocol', 'protocols', 'modes', 'entry', 'files']);
  assert.equal(manifest.schema_revision, 1);
  assert.equal(manifest.protocol, 'sol-component-discovery/1');
  assert.deepEqual(manifest.protocols, ['sol-component-discovery/1', 'sol-component-discovery/2']);
  assert.deepEqual(manifest.modes, ['registered', 'repository']);
  assert.equal(manifest.entry, 'src/provider-server.mjs');
  assert.equal(manifest.files.some((file) => file.path === 'provider-manifest.json'), false);
  const paths = new Set(manifest.files.map((file) => file.path));
  assert.ok(paths.has('package.json'));
  assert.ok(paths.has('package-lock.json'));
  assert.ok(paths.has('runtime.schema.json'));
  assert.ok(paths.has('src/provider-server.mjs'));
  assert.ok(paths.has('src/repository-index.mjs'));
  assert.ok(paths.has('src/workspace-read.mjs'));
  assert.ok(paths.has('vendor/normify/engine/compile.js'));
  assert.equal(paths.has('src/workspace.mjs'), false);
  assert.equal([...paths].some((path) => /(?:^|\/)(?:server|runtime|managed-write|patch|plugin-launcher|context-hook)\.mjs$/u.test(path)), false);
  assert.equal([...paths].some((path) => /(?:^|\/)(?:hooks?|skills?|\.codex-plugin)(?:\/|$)/iu.test(path)), false);

  for (const file of manifest.files) {
    const bytes = await readFile(join(packagedRoot, ...file.path.split('/')));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
  }
  const packageJson = JSON.parse(await readFile(join(packagedRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(await readFile(join(packagedRoot, 'package-lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ['@modelcontextprotocol/server', 'acorn', 'ajv', 'yaml', 'zod']);
  assert.deepEqual(Object.keys(packageLock.packages).slice(0, 1), ['']);
  assert.equal(packageLock.packages[''].name, 'codex-sol-provider');
  await assert.rejects(packageProvider({ out }), /already exists/u);

  const client = startMcpServer({
    workspace: root,
    rulesPath: '',
    serverPath: join(packagedRoot, 'src/provider-server.mjs'),
    serverArgs: ['--workspace', root, '--config', configPath, '--cache-root', cacheRoot],
  });
  clients.push(client);
  const initialized = await client.initialize();
  assert.equal(initialized.result.capabilities.experimental['sol-component-discovery'].protocol, 'sol-component-discovery/1');
  const listed = await client.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), ['sol_architecture_query', 'sol_read_file', 'sol_recall']);
  const defaultStorage = await readdir(join(root, '.codex', 'sol'));
  assert.equal(defaultStorage.includes('observations'), false);

  const canonicalRoot = await realpath(root);
  const scope = { roots: ['.'], files: [] };
  await writeFile(repositoryConfigPath, JSON.stringify({
    protocol: PROVIDER_V2_PROTOCOL,
    mode: 'repository',
    workspace_root: canonicalRoot,
    workspace_id: createHash('sha256').update(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot).digest('hex'),
    discovery_scope: scope,
    scope_digest: canonicalProviderDigest(scope),
    budgets: { max_sources: 128, max_file_bytes: 262144, max_total_bytes: 1048576, timeout_ms: 30000 },
  }));
  const repositoryClient = startMcpServer({
    workspace: root,
    rulesPath: '',
    serverPath: join(packagedRoot, 'src/provider-server.mjs'),
    serverArgs: ['--workspace', root, '--config', repositoryConfigPath, '--cache-root', cacheRoot],
  });
  clients.push(repositoryClient);
  const repositoryInit = await repositoryClient.initialize();
  const capability = repositoryInit.result.capabilities.experimental['sol-component-discovery'];
  assert.equal(capability.protocol, 'sol-component-discovery/2');
  assert.equal(capability.mode, 'repository');
  assert.equal(capability.product_write, false);
  const queryResponse = await repositoryClient.request('tools/call', {
    name: 'sol_architecture_query', arguments: { paths: [], capability: 'example' },
  });
  assert.equal(queryResponse.result.isError, false);
  const queryValue = JSON.parse(queryResponse.result.content[0].text);
  assert.equal(queryValue.kind, 'repository_query_v2');
  assert.equal(queryValue.candidates_count >= 1, true);
});
