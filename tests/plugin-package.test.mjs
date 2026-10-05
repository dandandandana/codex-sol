import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagePlugin } from '../scripts/package-plugin.mjs';
import { startMcpServer } from './helpers/mcp-client.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

function run(executable, args, { cwd, timeoutMs = 10000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Child process timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

async function closeClient(client) {
  const child = client.child;
  const closed = client.waitForClose();
  if (!child.stdin.destroyed) child.stdin.end();
  const within = async (promise, ms, fallback) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(fallback), ms);
      })]);
    } finally { clearTimeout(timer); }
  };
  const graceful = await within(closed.then(() => true), 1000, false);
  if (!graceful && child.exitCode === null && child.signalCode === null) child.kill();
  await within(closed, 3000, null);
}

test('plugin manifests use the parser-supported hooks/interface shape and matching launcher commands', async () => {
  const packageJson = await readJson(join(repoRoot, 'package.json'));
  const plugin = await readJson(join(repoRoot, 'plugin.json'));
  const mcp = await readJson(join(repoRoot, 'mcp.json'));
  const overlay = await readJson(join(repoRoot, '.codex-plugin/plugin.json'));
  const overlayMcp = await readJson(join(repoRoot, '.mcp.json'));
  const hooks = await readJson(join(repoRoot, 'hooks/hooks.json'));
  const bootstrapSource = await readFile(join(repoRoot, 'src/plugin-bootstrap.cjs'), 'utf8');

  assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(plugin.name, 'codex-sol');
  assert.equal(plugin.version, packageJson.version);
  assert.equal(plugin.extensions['com.openai'].hooks, './hooks/hooks.json');
  assert.deepEqual(plugin.extensions['com.openai'].interface, {
    displayName: 'Codex SoL',
    shortDescription: 'Local Context and an explicit, evidence-backed change workflow.',
  });
  assert.equal(Object.hasOwn(plugin, 'interface'), false);
  assert.equal(Object.hasOwn(plugin.extensions, 'com.openai.hooks'), false);

  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  const portableServer = { command: 'node', args: ['${PLUGIN_ROOT}/src/plugin-launcher.mjs', 'mcp'] };
  assert.deepEqual(mcp.mcpServers.codex_sol, { type: 'stdio', ...portableServer });
  assert.deepEqual(overlayMcp.mcpServers.codex_sol, {
    command: 'node', args: ['--input-type=commonjs', '-e', bootstrapSource, 'sol-plugin-mcp'],
  });
  assert.deepEqual(overlay, {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    hooks: './hooks/hooks.json',
    mcpServers: './.mcp.json',
    interface: plugin.extensions['com.openai'].interface,
  });

  const expectedHooks = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];
  assert.deepEqual(Object.keys(hooks.hooks), expectedHooks);
  for (const event of expectedHooks) {
    const [group] = hooks.hooks[event];
    assert.equal(hooks.hooks[event].length, 1);
    assert.equal(group.hooks.length, 1);
    assert.deepEqual(group.hooks[0], {
      type: 'command',
      command: 'node "${PLUGIN_ROOT}/src/plugin-launcher.mjs" hook',
      timeout: 30,
    });
    if (event === 'PreToolUse') assert.equal(group.matcher, '^(apply_patch|Edit|Write|mcp__.+__sol_apply_(patch|changes))$');
    else assert.equal(Object.hasOwn(group, 'matcher'), false);
  }
});

test('packaging selects host format safely, copies the allowlist, and launches from a project opt-in', { timeout: 180000 }, async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'codex-sol-plugin-package-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const existing = join(tempRoot, 'already-exists');
  await mkdir(existing);
  await writeFile(join(existing, 'sentinel.txt'), 'keep me');
  await assert.rejects(packagePlugin({ out: existing }), /already exists/);
  assert.equal(await readFile(join(existing, 'sentinel.txt'), 'utf8'), 'keep me');
  assert.deepEqual(await readdir(existing), ['sentinel.txt']);

  for (const unsafe of [repoRoot, dirname(repoRoot), join(repoRoot, 'src', 'plugin-package-output'),
    join(repoRoot, 'vendor', 'normify', 'plugin-package-output'), join(repoRoot, 'node_modules', 'plugin-package-output')]) {
    await assert.rejects(packagePlugin({ out: unsafe }));
  }

  const invalidOutput = join(tempRoot, 'invalid-format');
  await assert.rejects(packagePlugin({ out: invalidOutput, format: 'legacy' }), /format must be codex or portable/);
  assert.equal((await readdir(tempRoot)).includes('invalid-format'), false);
  const scriptPath = join(repoRoot, 'scripts/package-plugin.mjs');
  const rejectedCli = await run(process.execPath, [scriptPath, '--out', join(tempRoot, 'invalid-cli'), '--format', 'legacy'], { cwd: repoRoot });
  assert.equal(rejectedCli.code, 1, rejectedCli.stderr);
  assert.match(rejectedCli.stderr, /Usage:.*--format codex\|portable/);
  assert.equal((await readdir(tempRoot)).includes('invalid-cli'), false);
  for (const [name, args] of [
    ['missing-format', ['--out', join(tempRoot, 'missing-format'), '--format']],
    ['repeated-format', ['--out', join(tempRoot, 'repeated-format'), '--format', 'codex', '--format', 'portable']],
    ['repeated-out', ['--out', join(tempRoot, 'repeated-out'), '--out', join(tempRoot, 'other-output')]],
  ]) {
    const malformed = await run(process.execPath, [scriptPath, ...args], { cwd: repoRoot });
    assert.equal(malformed.code, 1, malformed.stderr);
    assert.match(malformed.stderr, /Usage:/);
    assert.equal((await readdir(tempRoot)).includes(name), false);
  }

  const output = join(tempRoot, 'codex');
  const packed = await packagePlugin({ out: output });
  const pluginRoot = join(output, 'codex-sol');
  const pluginEntries = (await readdir(pluginRoot)).sort();
  assert.deepEqual(pluginEntries, [
    '.codex-plugin', '.mcp.json', 'README.md', 'context.example.json', 'hooks',
    'native.linux.example.json', 'node_modules', 'package-lock.json', 'package.json', 'runtime.schema.json',
    'rules.example.json', 'sol-project.example.json', 'src', 'vendor',
  ].sort());
  assert.equal(packed.format, 'codex');
  assert.deepEqual(await readFile(join(pluginRoot, 'README.md')), await readFile(join(repoRoot, 'PLUGIN.md')));
  assert.deepEqual(await readFile(join(pluginRoot, 'native.linux.example.json')), await readFile(join(repoRoot, 'native.linux.example.json')));
  for (const forbidden of ['.env', '.codex', '.git', 'fixtures', 'logs', 'slop', 'tests']) {
    assert.equal(pluginEntries.includes(forbidden), false, `unexpected project data in package: ${forbidden}`);
  }
  assert.equal((await readdir(join(pluginRoot, 'node_modules'))).includes('.bin'), false);

  const marketplace = await readJson(join(output, '.agents/plugins/marketplace.json'));
  assert.deepEqual(marketplace, {
    name: 'sol-local',
    interface: { displayName: 'SoL Local' },
    plugins: [{ name: 'codex-sol', source: { source: 'local', path: './codex-sol' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
  });
  const inventoryText = await readFile(join(output, 'package-inventory.json'), 'utf8');
  const inventory = JSON.parse(inventoryText);
  assert.equal(inventory.format, 'codex');
  assert.equal(inventory.version, (await readJson(join(pluginRoot, 'package.json'))).version);
  assert.equal(inventoryText.includes(repoRoot), false, 'inventory must not embed the local checkout path');
  assert.deepEqual(inventory.commands.mcp, { command: 'node', args: ['--input-type=commonjs', '-e',
    '<contents of codex-sol/src/plugin-bootstrap.cjs>', 'sol-plugin-mcp'], source: 'codex-sol/src/plugin-bootstrap.cjs' });
  const bootstrapSource = await readFile(join(pluginRoot, 'src/plugin-bootstrap.cjs'), 'utf8');
  const packagedMcp = await readJson(join(pluginRoot, '.mcp.json'));
  assert.deepEqual(packagedMcp.mcpServers.codex_sol, {
    command: 'node', args: ['--input-type=commonjs', '-e', bootstrapSource, 'sol-plugin-mcp'],
  });
  assert.deepEqual(packagedMcp, await readJson(join(repoRoot, '.mcp.json')));
  for (const relativePath of ['codex-sol/.codex-plugin/plugin.json', 'codex-sol/.mcp.json',
    'codex-sol/src/plugin-launcher.mjs', '.agents/plugins/marketplace.json']) {
    const file = join(output, ...relativePath.split('/'));
    const bytes = await readFile(file);
    const entry = inventory.files.find((candidate) => candidate.path === relativePath);
    assert.ok(entry, `missing inventory entry for ${relativePath}`);
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(packed.fileCount, inventory.files.length);

  const emptyProject = join(tempRoot, 'empty-project');
  await mkdir(emptyProject);
  const startup = await run(process.execPath, [join(pluginRoot, 'src/plugin-launcher.mjs'), 'mcp'], { cwd: emptyProject });
  assert.equal(startup.code, 2, startup.stderr);
  assert.match(startup.stderr, /PLUGIN_CONFIG/);
  assert.match(startup.stderr, /local project configuration|\.codex[/\\]sol-project\.json/i);
  assert.doesNotMatch(startup.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);

  const project = join(tempRoot, 'opted-in-project');
  await mkdir(join(project, '.codex'), { recursive: true });
  await writeFile(join(project, 'rules.json'), await readFile(join(pluginRoot, 'rules.example.json')));
  await writeFile(join(project, 'context.json'), await readFile(join(pluginRoot, 'context.example.json')));
  await writeFile(join(project, 'README.md'), 'Portable plugin smoke-test workspace.\n');
  await writeFile(join(project, '.codex/sol-project.json'), JSON.stringify({ schema_version: 1,
    validation_rules: 'rules.json', context_rules: 'context.json',
    plugin_launcher: join(pluginRoot, 'src/plugin-launcher.mjs') }));

  const legacyServer = packagedMcp.mcpServers.codex_sol;
  assert.equal(legacyServer.command, 'node');
  assert.deepEqual(legacyServer.args, ['--input-type=commonjs', '-e', bootstrapSource, 'sol-plugin-mcp']);
  const client = startMcpServer({ workspace: project, serverPath: legacyServer.args[0], serverArgs: legacyServer.args.slice(1) });
  try {
    await client.initialize();
    const listed = await client.request('tools/list');
    const toolNames = listed.result.tools.map((tool) => tool.name).sort();
    assert.ok(toolNames.includes('sol_context_prepare'), JSON.stringify(listed));
    assert.ok(toolNames.includes('sol_context_submit'), JSON.stringify(listed));
  } finally {
    await closeClient(client);
  }

  const portableOutput = join(tempRoot, 'portable');
  const portableCli = await run(process.execPath, [scriptPath, '--out', portableOutput, '--format', 'portable'],
    { cwd: repoRoot, timeoutMs: 120000 });
  assert.equal(portableCli.code, 0, portableCli.stderr);
  const cliResult = JSON.parse(portableCli.stdout);
  assert.equal(cliResult.format, 'portable');
  const portableRoot = join(portableOutput, 'codex-sol');
  assert.ok((await readdir(portableRoot)).includes('plugin.json'));
  assert.ok((await readdir(portableRoot)).includes('mcp.json'));
  const portableManifest = await readJson(join(portableRoot, 'plugin.json'));
  assert.equal(portableManifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(portableManifest.extensions['com.openai'].hooks, './hooks/hooks.json');
  assert.deepEqual(portableManifest.extensions['com.openai'].interface, {
    displayName: 'Codex SoL',
    shortDescription: 'Local Context and an explicit, evidence-backed change workflow.',
  });
  assert.equal((await readJson(join(portableOutput, 'package-inventory.json'))).format, 'portable');
  assert.deepEqual(await readJson(join(portableRoot, '.mcp.json')), await readJson(join(repoRoot, '.mcp.json')));
});
