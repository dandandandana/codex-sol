import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handlePluginHook, resolvePluginProject } from '../src/plugin-launcher.mjs';
import { SolFault } from '../src/store.mjs';

const launcher = fileURLToPath(new URL('../src/plugin-launcher.mjs', import.meta.url));
const rules = { schema_version: 1, rules: [] };

async function directory(t, prefix = 'sol-plugin-project-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeRules(root, value = rules) {
  await writeFile(join(root, 'rules.json'), JSON.stringify(value));
}

async function writeProject(root, value, { raw = false } = {}) {
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(join(root, '.codex', 'sol-project.json'), raw ? value : JSON.stringify(value));
}

function projectConfig(overrides = {}) {
  return { schema_version: 1, validation_rules: 'rules.json', ...overrides };
}

function samePath(actual, expected) {
  const normalize = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
  assert.equal(normalize(actual), normalize(expected));
}

function runLauncher(mode, cwd, input = '', env = {}) {
  return spawnSync(process.execPath, [launcher, mode], {
    cwd, input, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10000, windowsHide: true,
  });
}

test('missing opt-in ignores legacy environment hints and creates no project state', async (t) => {
  const root = await directory(t);
  const fakeWorkspace = join(root, 'env-workspace');
  const env = { CODEX_SOL_WORKSPACE: fakeWorkspace, CODEX_SOL_RULES: join(root, 'rules.json'),
    CODEX_SOL_CONTEXT_RULES: join(root, 'context.json'), CODEX_SOL_GENERATED_PATHS: '["**/*"]' };

  assert.equal(await resolvePluginProject(root), null);
  assert.deepEqual(await handlePluginHook({ hook_event_name: 'SessionStart', source: 'startup', cwd: root }), {});
  const hook = runLauncher('hook', root,
    JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: root }), env);
  assert.equal(hook.status, 0, hook.stderr);
  assert.deepEqual(JSON.parse(hook.stdout), {});
  const mcp = runLauncher('mcp', root, '', env);
  assert.equal(mcp.status, 2);
  assert.equal(mcp.stdout, '');
  assert.match(mcp.stderr, /PLUGIN_CONFIG/u);
  assert.equal(mcp.stderr.includes(root), false);
  assert.equal(mcp.stderr.includes(fakeWorkspace), false);
  await assert.rejects(stat(join(root, '.codex')), { code: 'ENOENT' });
  await assert.rejects(stat(join(fakeWorkspace, '.codex', 'sol')), { code: 'ENOENT' });
});

test('nearest Git root owns opt-in, including a regular .git worktree file', async (t) => {
  const root = await directory(t);
  await writeFile(join(root, '.git'), 'gitdir: .git/worktrees/checkout\n');
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeRules(root);
  await writeProject(root, projectConfig({ generated_paths: ['dist/**'] }));

  const resolved = await resolvePluginProject(join(root, 'src', 'nested'));
  samePath(resolved.workspace, await realpath(root));
  samePath(resolved.rulesPath, join(await realpath(root), 'rules.json'));
  assert.deepEqual(resolved.rules, rules);
  assert.deepEqual(resolved.generated, ['dist/**']);
  assert.deepEqual(await handlePluginHook({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    cwd: join(root, 'src', 'nested') }), {});
  await assert.rejects(stat(join(root, '.codex', 'sol')), { code: 'ENOENT' });
});

test('a nested Git repository without opt-in does not inherit its outer project config', async (t) => {
  const root = await directory(t);
  const nested = join(root, 'vendor', 'child');
  await mkdir(join(nested, 'src'), { recursive: true });
  await mkdir(join(root, '.git'));
  await mkdir(join(nested, '.git'));
  await writeRules(root);
  await writeProject(root, projectConfig());

  assert.equal(await resolvePluginProject(join(nested, 'src')), null);
  await assert.rejects(stat(join(nested, '.codex')), { code: 'ENOENT' });
});

test('without Git, only the exact cwd can opt in', async (t) => {
  const parent = await directory(t);
  const child = join(parent, 'child');
  await mkdir(child);
  await writeRules(parent);
  await writeProject(parent, projectConfig());

  assert.equal(await resolvePluginProject(child), null);
  await writeRules(child);
  await writeProject(child, projectConfig());
  const resolved = await resolvePluginProject(child);
  samePath(resolved.workspace, await realpath(child));
});

test('project config is strict, valid UTF-8 JSON, and limited to 32 KiB', async (t) => {
  const root = await directory(t);
  await writeRules(root);

  await writeProject(root, '{broken', { raw: true });
  await assert.rejects(resolvePluginProject(root), { code: 'PLUGIN_CONFIG' });

  await writeProject(root, Buffer.from([0x7b, 0xff, 0x7d]), { raw: true });
  await assert.rejects(resolvePluginProject(root), { code: 'PLUGIN_CONFIG' });

  await writeProject(root, projectConfig({ unexpected: true }));
  await assert.rejects(resolvePluginProject(root), { code: 'PLUGIN_CONFIG' });

  await writeProject(root, projectConfig({ generated_paths: ['dist/**', 'dist/**'] }));
  await assert.rejects(resolvePluginProject(root), { code: 'PLUGIN_CONFIG' });

  await writeProject(root, projectConfig({ generated_paths: Array.from({ length: 129 }, (_, i) => `generated-${i}/**`) }));
  await assert.rejects(resolvePluginProject(root), { code: 'PLUGIN_CONFIG' });

  await writeProject(root, `${JSON.stringify(projectConfig())}${' '.repeat(33 * 1024)}`, { raw: true });
  await assert.rejects(resolvePluginProject(root), { code: 'SOURCE_LIMIT' });
});

test('config source paths reject traversal and symlink parents', async (t) => {
  const root = await directory(t);
  await writeRules(root);
  for (const [validationRules, code] of [
    ['../plugin-outside-rules.json', 'PLUGIN_CONFIG'],
    [join(root, 'rules.json'), 'PLUGIN_CONFIG'],
    ['.git/config', 'PATH_ERROR'],
    ['.codex/sol/state.json', 'PATH_ERROR'],
  ]) {
    await writeProject(root, projectConfig({ validation_rules: validationRules }));
    await assert.rejects(resolvePluginProject(root), { code });
  }

  const target = join(root, 'target');
  await mkdir(target);
  await writeFile(join(target, 'rules.json'), JSON.stringify(rules));
  try {
    await symlink(target, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) {
      return t.skip(`This Windows environment cannot create a directory symlink (${error.code}).`);
    }
    throw error;
  }
  await writeProject(root, projectConfig({ validation_rules: 'linked/rules.json' }));
  await assert.rejects(resolvePluginProject(root), { code: 'PATH_ERROR' });
});

test('required rules must exist and optional executables must be absolute regular files', async (t) => {
  const root = await directory(t);
  await writeProject(root, projectConfig());
  await assert.rejects(resolvePluginProject(root), { code: 'ENOENT' });

  await writeRules(root);
  const runner = join(root, 'runner.cmd');
  await writeFile(runner, 'exit /b 0\n');
  await writeProject(root, projectConfig({ patch_executable: runner, host_executable: runner }));
  const resolved = await resolvePluginProject(root);
  assert.equal(resolved.patchExecutable, runner);
  assert.equal(resolved.hostExecutable, runner);

  await writeProject(root, projectConfig({ patch_executable: 'runner.cmd' }));
  await assert.rejects(resolvePluginProject(root), { code: 'PLUGIN_CONFIG' });
  await writeProject(root, projectConfig({ patch_executable: join(root, 'missing-runner.cmd') }));
  await assert.rejects(resolvePluginProject(root), { code: 'ENOENT' });
});

test('runtime rejects a project bound to a different launcher path', async (t) => {
  const root = await directory(t);
  const alternate = join(root, 'other-cache', 'plugin-launcher.mjs');
  await mkdir(join(root, 'other-cache'));
  await writeFile(alternate, 'export {};\n');
  await writeRules(root);
  await writeProject(root, projectConfig({ plugin_launcher: alternate }));

  await assert.rejects(resolvePluginProject(root), { code: 'PLUGIN_CONFIG' });
  const hook = runLauncher('hook', root, JSON.stringify({ hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch', cwd: root, session_id: 'test-session' }));
  assert.equal(hook.status, 0, hook.stderr);
  const response = JSON.parse(hook.stdout);
  assert.equal(response.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(response.hookSpecificOutput.permissionDecisionReason, /^PLUGIN_CONFIG:/u);
  assert.equal(hook.stdout.includes(root), false);
  await assert.rejects(stat(join(root, '.codex', 'sol')), { code: 'ENOENT' });
});

test('configuration cancellation preserves interruption state and does not write project files', async (t) => {
  const root = await directory(t);
  const controller = new AbortController();
  const hostState = new SolFault('HOST_STATE_ERROR', 'Host state unavailable.');
  controller.abort(hostState);

  await assert.rejects(resolvePluginProject(root, { signal: controller.signal }), (error) => error === hostState);
  await assert.rejects(stat(join(root, '.codex')), { code: 'ENOENT' });
});

test('CLI maps invalid project config safely for PreToolUse and Stop', async (t) => {
  const root = await directory(t);
  await writeProject(root, '{malformed', { raw: true });

  const preTool = runLauncher('hook', root, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    cwd: root, session_id: 'test-session' }));
  assert.equal(preTool.status, 0, preTool.stderr);
  const denied = JSON.parse(preTool.stdout);
  assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /^PLUGIN_CONFIG:/u);
  assert.equal(preTool.stdout.includes(root), false);

  const stop = runLauncher('hook', root, JSON.stringify({ hook_event_name: 'Stop', cwd: root, session_id: 'test-session' }));
  assert.equal(stop.status, 0, stop.stderr);
  const message = JSON.parse(stop.stdout).systemMessage;
  assert.match(message, /Task completion has not been verified/u);
  assert.doesNotMatch(message, /task is complete|completed successfully/iu);
  assert.equal(stop.stdout.includes(root), false);
});
