import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { handleNativeHook, loadNativeConfig } from '../src/native-hook.mjs';
import { applyManagedPatch, patchPaths } from '../src/patch.mjs';
import { resolvePluginProject } from '../src/plugin-launcher.mjs';
import { createObservationStore } from '../src/store.mjs';
import { ValidationEngine } from '../src/validation.mjs';
import { validateWorkspacePath, workspaceFile } from '../src/workspace.mjs';

const linuxOnly = process.platform === 'linux' ? false : 'Linux filesystem and Bash integration coverage.';
const entry = fileURLToPath(new URL('../src/native-hook.mjs', import.meta.url));

async function fixture(t, { timeoutMs = 10000, loadProfile = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sol-linux-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "workspace ' 中文");
  await mkdir(root);
  const rules = join(directory, 'rules.json');
  await writeFile(rules, JSON.stringify({ schema_version: 1, rules: [] }));
  const config = { schema_version: 1, workspace: root, rules, node: process.execPath,
    shell: await realpath('/bin/bash'), load_profile: loadProfile, timeout_ms: timeoutMs, generated: [] };
  const configPath = join(directory, 'native.json');
  await writeFile(configPath, JSON.stringify(config));
  return { directory, root, config, configPath };
}

async function request(f, command) {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'linux-test',
    tool_use_id: randomUUID(), cwd: f.root, tool_input: { command } };
  const pre = await handleNativeHook(event, f.configPath);
  assert.equal(pre.hookSpecificOutput.permissionDecision, 'allow', JSON.stringify(pre));
  const spool = join(f.root, '.codex/sol/native');
  for (const file of (await readdir(spool)).filter((file) => file.endsWith('.request.json'))) {
    const value = JSON.parse(await readFile(join(spool, file), 'utf8'));
    if (value.command === command) return { event, pre, path: join(spool, file) };
  }
  assert.fail('Native request was not persisted.');
}

function run(f, path, { cwd = f.root, env = process.env } = {}) {
  const result = spawnSync(process.execPath, [entry, '--run', path], { cwd, env, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { child: result, value: result.stdout ? JSON.parse(result.stdout) : null };
}

test('Linux patch and workspace paths agree on filenames, case and protected metadata', { skip: linuxOnly }, async (t) => {
  const f = await fixture(t);
  const names = ['notes:linux?.txt', 'trailing.', '.GIT/ordinary.txt', '.CODEX/sol/ordinary.txt'];
  for (const name of names) {
    assert.equal(validateWorkspacePath(name), name);
    await mkdir(dirname(join(f.root, name)), { recursive: true });
    await writeFile(join(f.root, name), name);
    assert.equal(await workspaceFile(f.root, name), join(f.root, name));
  }
  const patch = ['*** Begin Patch', ...names.flatMap((name) => [`*** Add File: ${name}`, '+Linux filename']), '*** End Patch'].join('\n');
  assert.deepEqual(patchPaths(patch), [...names].sort());
  for (const name of ['.git/config', '.codex/sol/state.json', '../escape', 'bad\0name', 'a\\b']) {
    assert.throws(() => validateWorkspacePath(name), { code: 'PATH_ERROR' });
    assert.throws(() => patchPaths(`*** Begin Patch\n*** Add File: ${name}\n+bad\n*** End Patch`), { code: 'PATH_ERROR' });
  }
});

test('real Linux patch creates punctuation filenames and keeps filename case distinct', {
  skip: linuxOnly || (!process.env.CODEX_SOL_PATCH_EXECUTABLE && 'Configure the installed native Codex binary.'),
}, async (t) => {
  const f = await fixture(t);
  const store = await createObservationStore(f.root);
  const validator = new ValidationEngine(store, { schema_version: 1, rules: [] });
  const names = ['notes:linux?.txt', 'A.txt', 'a.txt'];
  const patch = ['*** Begin Patch', ...names.flatMap((name) => [`*** Add File: ${name}`, `+${name}`]), '*** End Patch'].join('\n');
  const result = await applyManagedPatch(store, validator, patch, { executable: process.env.CODEX_SOL_PATCH_EXECUTABLE });
  assert.equal(result.tool_status, 'ok', JSON.stringify(result));
  assert.deepEqual(result.changed_paths, [...names].sort());
  for (const name of names) assert.equal(await readFile(join(f.root, name), 'utf8'), `${name}\n`);
});

test('Linux native executable links resolve, while missing execute permission fails before launch', { skip: linuxOnly }, async (t) => {
  const f = await fixture(t);
  const nodeLink = join(f.directory, "node ' link");
  const bashLink = join(f.directory, 'bash link');
  await symlink(process.execPath, nodeLink);
  await symlink(f.config.shell, bashLink);
  await writeFile(f.configPath, JSON.stringify({ ...f.config, node: nodeLink, shell: bashLink }));
  const loaded = await loadNativeConfig(f.configPath);
  assert.equal(loaded.config.node, await realpath(process.execPath));
  assert.equal(loaded.config.shell, f.config.shell);
  const nonExecutable = join(f.directory, 'not-executable');
  await writeFile(nonExecutable, '#!/bin/sh\nexit 0\n');
  await chmod(nonExecutable, 0o600);
  await writeFile(f.configPath, JSON.stringify({ ...f.config, shell: nonExecutable }));
  await assert.rejects(loadNativeConfig(f.configPath), { code: 'CONFIG_ERROR' });
  const store = await createObservationStore(f.root);
  const validator = new ValidationEngine(store, { schema_version: 1, rules: [] });
  await assert.rejects(applyManagedPatch(store, validator, '*** Begin Patch\n*** Add File: untouched.txt\n+bad\n*** End Patch',
    { executable: nonExecutable }), { code: 'CONFIG_ERROR' });
  await assert.rejects(readFile(join(f.root, 'untouched.txt')), { code: 'ENOENT' });
});

test('Linux plugin executables accept resolved links and reject non-executable files', { skip: linuxOnly }, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, '.codex'));
  await writeFile(join(f.root, 'rules.json'), JSON.stringify({ schema_version: 1, rules: [] }));
  const link = join(f.directory, 'node-link');
  await symlink(process.execPath, link);
  const configPath = join(f.root, '.codex/sol-project.json');
  await writeFile(configPath, JSON.stringify({ schema_version: 1, validation_rules: 'rules.json', patch_executable: link, host_executable: link }));
  const project = await resolvePluginProject(f.root);
  assert.equal(project.patchExecutable, await realpath(process.execPath));
  assert.equal(project.hostExecutable, await realpath(process.execPath));
  const nonExecutable = join(f.directory, 'not-executable');
  await writeFile(nonExecutable, 'not a program', { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ schema_version: 1, validation_rules: 'rules.json', patch_executable: nonExecutable }));
  await assert.rejects(resolvePluginProject(f.root), { code: 'PLUGIN_CONFIG' });
});

test('Linux native runner preserves a subdirectory cwd and refuses execution outside its workspace', { skip: linuxOnly }, async (t) => {
  const f = await fixture(t);
  const nested = join(f.root, 'nested');
  await mkdir(nested);
  const pending = await request(f, 'printf nested > effect.txt');
  const { child, value } = run(f, pending.path, { cwd: nested });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(value.tool_status, 'ok');
  assert.deepEqual(value.changed_paths, ['nested/effect.txt']);
  assert.equal(await readFile(join(nested, 'effect.txt'), 'utf8'), 'nested');
  const outside = await request(f, 'printf escaped > must-not-exist.txt');
  const refused = run(f, outside.path, { cwd: f.directory });
  assert.equal(refused.child.status, 1);
  assert.equal(JSON.parse(refused.child.stderr).code, 'PATH_ERROR');
  await assert.rejects(readFile(join(f.directory, 'must-not-exist.txt')), { code: 'ENOENT' });
});

test('Linux load_profile controls Bash login profiles without touching the real user profile', { skip: linuxOnly }, async (t) => {
  const f = await fixture(t);
  const fakeHome = join(f.directory, 'fake-home');
  await mkdir(fakeHome);
  await writeFile(join(fakeHome, '.bash_profile'), 'export SOL_LINUX_PROFILE_VALUE=loaded\n');
  const env = { ...process.env, HOME: fakeHome };
  delete env.SOL_LINUX_PROFILE_VALUE;
  delete env.BASH_ENV;
  const first = await request(f, 'printf "%s" "${SOL_LINUX_PROFILE_VALUE:-absent}" > first.txt');
  assert.equal(run(f, first.path, { env }).child.status, 0);
  assert.equal(await readFile(join(f.root, 'first.txt'), 'utf8'), 'absent');
  await writeFile(f.configPath, JSON.stringify({ ...f.config, load_profile: true }));
  const second = await request(f, 'printf "%s" "${SOL_LINUX_PROFILE_VALUE:-absent}" > second.txt');
  assert.equal(run(f, second.path, { env }).child.status, 0);
  assert.equal(await readFile(join(f.root, 'second.txt'), 'utf8'), 'loaded');
});

test('Linux native timeout kills Bash descendants and releases the lock for the next request', { skip: linuxOnly }, async (t) => {
  const f = await fixture(t, { timeoutMs: 150 });
  const pending = await request(f, 'printf timeout-start; (sleep 1; printf survived > late.txt) & wait');
  const { value } = run(f, pending.path);
  assert.equal(value.tool_status, 'timeout');
  assert.equal(value.execution.status, 'timeout');
  assert.ok(value.observation.raw.some((ref) => !ref.complete));
  await delay(1100);
  await assert.rejects(readFile(join(f.root, 'late.txt')), { code: 'ENOENT' });
  const next = await request(f, 'printf recovered > recovered.txt');
  assert.equal(run(f, next.path).value.tool_status, 'ok');
  assert.equal(await readFile(join(f.root, 'recovered.txt'), 'utf8'), 'recovered');
});

test('Linux SIGTERM interrupts the native runner, retains partial output and leaves the next request usable', { skip: linuxOnly }, async (t) => {
  const f = await fixture(t);
  const pending = await request(f, 'printf ready; (sleep 1; printf survived > late.txt) & wait');
  const child = spawn(process.execPath, [entry, '--run', pending.path], { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let error = '';
  child.stdout.on('data', (bytes) => { output += bytes; });
  child.stderr.on('data', (bytes) => { error += bytes; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const owner = join(f.root, '.codex/sol/managed-modification.owner.json');
  const deadline = Date.now() + 5000;
  for (;;) {
    const state = await readFile(owner, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (state?.runner.state === 'running') break;
    assert.ok(Date.now() < deadline, 'Native shell did not start.');
    await delay(10);
  }
  await delay(50);
  child.kill('SIGTERM');
  assert.equal(await closed, 1, error);
  const value = JSON.parse(output);
  assert.equal(value.execution.reason, 'interrupted');
  assert.ok(value.observation.raw.some((ref) => !ref.complete));
  await delay(1100);
  await assert.rejects(readFile(join(f.root, 'late.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(owner), { code: 'ENOENT' });
  const next = await request(f, 'printf after-cancel > recovered.txt');
  assert.equal(run(f, next.path).value.tool_status, 'ok');
});
