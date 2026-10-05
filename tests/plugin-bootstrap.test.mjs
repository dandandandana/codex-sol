import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { readPluginProjectHeader } = require('../src/plugin-bootstrap.cjs');
const manifest = JSON.parse(await readFile(new URL('../.mcp.json', import.meta.url), 'utf8'));
const manifestArgs = manifest.mcpServers.codex_sol.args;
const bootstrapSource = manifestArgs[2];
const sourceFile = await readFile(new URL('../src/plugin-bootstrap.cjs', import.meta.url), 'utf8');

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'sol-plugin-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeConfig(root, config) {
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(join(root, '.codex', 'sol-project.json'), JSON.stringify(config));
}

function runBootstrap(cwd, env = {}) {
  return spawnSync(process.execPath, ['--input-type=commonjs', '-e', bootstrapSource, 'sol-plugin-mcp'], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10000, windowsHide: true,
  });
}

async function assertNoStore(root) {
  await assert.rejects(stat(join(root, '.codex', 'sol')), { code: 'ENOENT' });
}

test('legacy MCP manifest embeds the checked-in static bootstrap source verbatim', () => {
  assert.equal(manifest.mcpServers.codex_sol.command, 'node');
  assert.deepEqual(manifestArgs.slice(0, 2), ['--input-type=commonjs', '-e']);
  assert.equal(manifestArgs[2], sourceFile);
  assert.equal(manifestArgs[3], 'sol-plugin-mcp');
});

test('bootstrap without opt-in fails safely and ignores legacy environment configuration', async (t) => {
  const root = await directory(t);
  const fakeWorkspace = join(root, 'environment-workspace');
  const secret = 'bootstrap-test-secret';
  const childEnv = { CODEX_SOL_WORKSPACE: fakeWorkspace, CODEX_SOL_RULES: secret,
    CODEX_SOL_CONTEXT_RULES: join(fakeWorkspace, 'context.json'), CODEX_SOL_GENERATED_PATHS: '["**/*"]' };

  const result = runBootstrap(root, childEnv);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /PLUGIN_CONFIG/u);
  assert.equal(result.stderr.includes(root), false);
  assert.equal(result.stderr.includes(fakeWorkspace), false);
  assert.equal(result.stderr.includes(secret), false);
  await assert.rejects(stat(join(root, '.codex')), { code: 'ENOENT' });
  await assert.rejects(stat(join(fakeWorkspace, '.codex', 'sol')), { code: 'ENOENT' });
});

test('bootstrap requires a configured absolute launcher and reports no paths', async (t) => {
  const root = await directory(t);
  const secretPath = 'secret/private/cache/plugin-launcher.mjs';
  const base = { schema_version: 1, validation_rules: 'rules.json' };

  await writeConfig(root, base);
  const missing = runBootstrap(root);
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /PLUGIN_CONFIG/u);
  assert.equal(missing.stderr.includes(root), false);
  assert.equal(missing.stderr.includes('secret'), false);
  await assertNoStore(root);

  await writeConfig(root, { ...base, plugin_launcher: secretPath });
  const relative = runBootstrap(root);
  assert.equal(relative.status, 2);
  assert.equal(relative.stdout, '');
  assert.match(relative.stderr, /PLUGIN_CONFIG/u);
  assert.equal(relative.stderr.includes(root), false);
  assert.equal(relative.stderr.includes(secretPath), false);
  assert.equal(relative.stderr.includes('secret'), false);
  await assertNoStore(root);
});

test('bootstrap header rejects a symlinked .codex parent without following it', async (t) => {
  const root = await directory(t);
  const target = join(root, 'real-codex');
  await mkdir(target);
  await writeFile(join(target, 'sol-project.json'), JSON.stringify({ schema_version: 1,
    validation_rules: 'rules.json', plugin_launcher: join(root, 'secret', 'plugin-launcher.mjs') }));
  try {
    await symlink(target, join(root, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code))
      return t.skip(`This environment cannot create a directory symlink (${error.code}).`);
    throw error;
  }

  assert.throws(() => readPluginProjectHeader(root), { code: 'PATH_ERROR' });
  const result = runBootstrap(root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /PLUGIN_CONFIG/u);
  assert.equal(result.stderr.includes(root), false);
  await assert.rejects(stat(join(target, 'sol')), { code: 'ENOENT' });
});
