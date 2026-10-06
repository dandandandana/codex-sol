import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkPluginConfiguration } from '../src/plugin-launcher.mjs';

const launcher = fileURLToPath(new URL('../src/plugin-launcher.mjs', import.meta.url));
const marker = 'DO_NOT_EXPOSE_PRIVATE_CONFIGURATION_784d';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sol-check-config-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, '.codex'));
  await writeFile(join(root, 'rules.json'), JSON.stringify({ schema_version: 1, rules: [{ schema_version: 1, id: 'checks', globs: ['**/*.js'], watch_paths: ['**/*'],
    commands: [{ id: 'must-not-run', argv: [process.execPath, '-e', "require('fs').writeFileSync('command-ran','bad')"], cwd: '.', timeout_ms: 5000 }] }] }));
  return root;
}

async function project(root, extra = {}) {
  await writeFile(join(root, '.codex', 'sol-project.json'), JSON.stringify({ schema_version: 1, validation_rules: 'rules.json', ...extra }));
}

async function snapshot(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await snapshot(root, name));
    else result.push([name, (await readFile(join(root, name))).toString('base64')]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}

test('check-config CLI is read-only and bypasses runtime re-execution', async (t) => {
  const root = await fixture(t);
  await project(root, { generated_paths: ['node_modules'] });
  const before = await snapshot(root);
  const run = spawnSync(process.execPath, [launcher, 'check-config'], { cwd: root, encoding: 'utf8', timeout: 15000,
    windowsHide: true, env: { ...process.env, PRIVATE_SENTINEL: marker } });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, 'valid');
  assert.equal(report.tool_count, 4);
  assert.equal(report.validation_rule_count, 1);
  assert.equal(report.generated_pattern_count, 1);
  assert.equal(report.capabilities.host_cancellation_configured, false);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout.includes(root), false);
  assert.equal(run.stdout.includes(marker), false);
  assert.deepEqual(await snapshot(root), before);
});

test('context diagnosis uses the actual shared role schema without creating archives', async (t) => {
  const root = await fixture(t);
  const config = JSON.parse(await readFile(new URL('../context.example.json', import.meta.url), 'utf8'));
  await writeFile(join(root, 'README.md'), 'real responsibility input');
  await writeFile(join(root, 'context.json'), JSON.stringify(config));
  await project(root, { context_rules: 'context.json' });
  const before = await snapshot(root);
  assert.equal((await checkPluginConfiguration(root)).tool_count, 6);
  config.architecture = { path: 'architecture.json' };
  await writeFile(join(root, 'architecture.json'), JSON.stringify({ description: 'declaration is checked separately by the index' }));
  await writeFile(join(root, 'context.json'), JSON.stringify(config));
  assert.equal((await checkPluginConfiguration(root)).tool_count, 13);
  assert.equal((await checkPluginConfiguration(root)).coverage.architecture_declaration, 'path_only');
  config.roles[0].output_schema.additionalProperties = true;
  await writeFile(join(root, 'context.json'), JSON.stringify(config));
  const report = await checkPluginConfiguration(root);
  assert.equal(report.status, 'invalid');
  assert.equal(report.diagnostics[0].stage, 'context_rules');
  assert.equal(report.diagnostics[0].code, 'CONFIG_ERROR');
  assert.deepEqual((await readdir(join(root, '.codex'))).sort(), ['sol-project.json']);
  assert.ok(before.length > 0);
});

test('invalid configuration has safe stage diagnostics and no execution side effects', async (t) => {
  const root = await fixture(t);
  await project(root, { validation_rules: `${marker}.json` });
  let report = await checkPluginConfiguration(root);
  assert.equal(report.status, 'invalid');
  assert.equal(report.diagnostics[0].stage, 'validation_rules');
  assert.equal(JSON.stringify(report).includes(marker), false);
  assert.equal(JSON.stringify(report).includes(root), false);
  await project(root, { patch_executable: `${marker}/not-absolute` });
  report = await checkPluginConfiguration(root);
  assert.equal(report.diagnostics[0].stage, 'patch_executable');
  const before = await snapshot(root);
  await checkPluginConfiguration(root);
  assert.deepEqual(await snapshot(root), before);
  await writeFile(join(root, 'wrong-launcher.mjs'), 'wrong project launcher');
  await project(root, { plugin_launcher: join(root, 'wrong-launcher.mjs') });
  report = await checkPluginConfiguration(root);
  assert.equal(report.diagnostics[0].stage, 'plugin_launcher');
  assert.equal(JSON.stringify(report).includes(root), false);
});

test('an unconfigured project and aborted diagnosis never claim a valid configuration', async (t) => {
  const root = await fixture(t);
  assert.equal((await checkPluginConfiguration(root)).status, 'not_enabled');
  await project(root);
  const controller = new AbortController();
  controller.abort();
  const report = await checkPluginConfiguration(root, { signal: controller.signal });
  assert.equal(report.status, 'invalid');
  assert.equal(report.diagnostics[0].code, 'INTERRUPTED');
  assert.deepEqual((await readdir(join(root, '.codex'))).sort(), ['sol-project.json']);
});

for (const kind of ['duplicate-rule', 'duplicate-command', 'colliding-combined-id', 'oversized-combined-id']) {
  test(`check-config rejects ${kind} using runtime rule constraints without writes`, async (t) => {
    const root = await fixture(t);
    await project(root);
    const rule = JSON.parse(await readFile(join(root, 'rules.json'), 'utf8')).rules[0];
    let rules;
    if (kind === 'duplicate-rule') rules = [rule, structuredClone(rule)];
    else if (kind === 'duplicate-command') rules = [{ ...rule, commands: [rule.commands[0], structuredClone(rule.commands[0])] }];
    else if (kind === 'colliding-combined-id') rules = [
      { ...rule, id: 'a/b', commands: [{ ...rule.commands[0], id: 'c' }] },
      { ...rule, id: 'a', commands: [{ ...rule.commands[0], id: 'b/c' }] },
    ];
    else rules = [{ ...rule, id: marker + 'x'.repeat(4096 - marker.length), commands: [{ ...rule.commands[0], id: 'c' }] }];
    await writeFile(join(root, 'rules.json'), JSON.stringify({ schema_version: 1, rules }));
    const before = await snapshot(root);
    const report = await checkPluginConfiguration(root);
    assert.equal(report.status, 'invalid');
    assert.equal(report.tool_count, null);
    assert.equal(report.diagnostics[0].stage, 'validation_rules');
    assert.equal(report.diagnostics[0].code, 'CONFIG_ERROR');
    assert.equal(JSON.stringify(report).includes(root), false);
    assert.equal(JSON.stringify(report).includes(marker), false);
    assert.deepEqual(await snapshot(root), before);
    assert.deepEqual(await readdir(join(root, '.codex')), ['sol-project.json']);
    await assert.rejects(readFile(join(root, 'command-ran')), { code: 'ENOENT' });
  });
}
