import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { handleNativeHook, runNativeRequest } from '../src/native-hook.mjs';
import { recall } from '../src/recall.mjs';
import { createObservationStore } from '../src/store.mjs';

const nativeEntry = fileURLToPath(new URL('../src/native-hook.mjs', import.meta.url));
const windowsOnly = process.platform === 'win32' ? false : 'Native hook integration requires Windows PowerShell.';

function powershellPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.ok(systemRoot, 'Windows must provide SystemRoot for the configured native shell.');
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function makeFixture(t) {
  const outerRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-sol-native-hook-'));
  t.after(() => rm(outerRoot, { recursive: true, force: true }));

  // Keep configuration and rules outside the actual workspace so they cannot
  // appear as changed workspace inputs during a native command.
  const workspaceRoot = path.join(outerRoot, "workspace ' & ; #");
  await mkdir(workspaceRoot);
  const rulesPath = path.join(outerRoot, 'rules.json');
  const configPath = path.join(outerRoot, 'native.json');
  await writeFile(rulesPath, JSON.stringify({
    schema_version: 1,
    rules: [{
      schema_version: 1,
      id: 'native-hook-test',
      globs: ['**/*'],
      watch_paths: ['**/*'],
      commands: [{
        id: 'changed-file-exists',
        argv: [process.execPath, '-e', "process.exit(require('node:fs').existsSync('effect.txt') ? 0 : 1)"],
        cwd: '.',
        timeout_ms: 10000,
      }],
    }],
  }));

  const config = {
    schema_version: 1,
    workspace: workspaceRoot,
    rules: rulesPath,
    node: process.execPath,
    shell: powershellPath(),
    load_profile: false,
    timeout_ms: 10000,
    generated: [],
  };
  await writeFile(configPath, JSON.stringify(config));
  return { outerRoot, workspaceRoot, rulesPath, configPath, config };
}

function nativeEvent(fixture, command, toolUseId = 'native-hook-test-call') {
  return {
    session_id: 'native-hook-test-session',
    tool_use_id: toolUseId,
    cwd: fixture.workspaceRoot,
    tool_name: 'Bash',
    hook_event_name: 'PreToolUse',
    tool_input: { command },
  };
}

async function createRequest(fixture, command, toolUseId = 'native-hook-test-call') {
  const event = nativeEvent(fixture, command, toolUseId);
  const pre = await handleNativeHook(event, fixture.configPath);
  const workspaceRoot = await realpath(fixture.workspaceRoot);
  const spool = path.join(workspaceRoot, '.codex', 'sol', 'native');
  const requests = (await readdir(spool)).filter((name) => name.endsWith('.request.json'));
  assert.equal(requests.length, 1, 'PreToolUse should create one request in the native spool.');
  return {
    event,
    pre,
    requestPath: path.join(spool, requests[0]),
    request: JSON.parse(await readFile(path.join(spool, requests[0]), 'utf8')),
  };
}

function parseRunnerOutput(stdout) {
  const lines = stdout.trim().split(/\r?\n/u);
  assert.equal(lines.length, 1, 'The wrapper must not execute injected outer-shell text.');
  return JSON.parse(lines[0]);
}

function runRewrittenCommand(fixture, command) {
  const completed = spawnSync(fixture.config.shell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
  ], {
    cwd: fixture.workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(completed.error);
  assert.equal(completed.signal, null);
  return completed;
}

async function recallText(store, observation, literal) {
  for (const ref of observation.raw) {
    const value = await recall(store, {
      schema_version: 1,
      handle: ref.handle,
      selector: { kind: 'keyword', literal, context_lines: 0 },
    });
    const text = value.chunks.map((chunk) => chunk.text ?? '').join('');
    if (text.includes(literal)) return text;
  }
  assert.fail(`No captured observation contains ${JSON.stringify(literal)}.`);
}

test('native PreToolUse safely wraps a command, commits the full failure, and reuses it without replay', { skip: windowsOnly }, async (t) => {
  const fixture = await makeFixture(t);
  const effectPath = path.join(fixture.workspaceRoot, 'effect.txt');
  const literal = "literal ' quote ; & Write-Output INJECTED $(this stays data)";
  const stderrAnchor = 'NATIVE_HOOK_STDERR_RECALL_39';
  const psLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
  const originalCommand = [
    `$value = ${psLiteral(literal)}`,
    `[System.IO.File]::AppendAllText(${psLiteral(effectPath)}, $value + [Environment]::NewLine)`,
    `[Console]::Error.WriteLine(${psLiteral(stderrAnchor)})`,
    'exit 7',
  ].join('; ');

  const { event, pre, requestPath, request } = await createRequest(fixture, originalCommand);
  assert.equal(pre.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(request.command, originalCommand, 'PreToolUse must preserve the original Shell text in the request.');
  assert.match(pre.hookSpecificOutput.updatedInput.command, /''/u, 'The workspace path apostrophe must be doubled in the PowerShell wrapper.');
  assert.ok(pre.hookSpecificOutput.updatedInput.command.includes(`'${requestPath.replaceAll("'", "''")}'`));

  const firstRun = runRewrittenCommand(fixture, pre.hookSpecificOutput.updatedInput.command);
  const result = parseRunnerOutput(firstRun.stdout);
  assert.equal(result.tool_status, 'error');
  assert.equal(result.execution.status, 'failed');
  assert.equal(result.execution.exit_code, 7, 'The runner result must preserve the Shell exit code.');
  assert.deepEqual(result.changed_paths, ['effect.txt']);
  assert.equal(result.validation.status, 'passed');
  assert.equal(result.validation.reason, 'all_checks_passed', 'Rules outside the workspace must not make the native result stale.');
  assert.ok(result.observation.raw.length > 0);
  assert.equal(await readFile(effectPath, 'utf8'), literal + os.EOL, 'The original shell command must execute exactly once.');

  const secondRun = runRewrittenCommand(fixture, pre.hookSpecificOutput.updatedInput.command);
  assert.deepEqual(parseRunnerOutput(secondRun.stdout), result, 'A committed result must be returned without launching the command again.');
  assert.equal(await readFile(effectPath, 'utf8'), literal + os.EOL, 'Re-reading a committed result must not repeat its side effect.');

  const post = await handleNativeHook({
    ...event,
    hook_event_name: 'PostToolUse',
    tool_response: { exit_code: 0, stdout: 'deliberately unrelated host response' },
  }, fixture.configPath);
  assert.deepEqual(post, { decision: 'block', reason: JSON.stringify(result) }, 'PostToolUse must return the complete persisted failure.');

  const store = await createObservationStore(fixture.workspaceRoot);
  assert.match(await recallText(store, result.observation, stderrAnchor), new RegExp(stderrAnchor));
});

test('a successful native result produces an unblocked PostToolUse response', { skip: windowsOnly }, async (t) => {
  const fixture = await makeFixture(t);
  const { event, pre, requestPath } = await createRequest(fixture, "Write-Output 'native success'", 'native-success-call');
  assert.equal(pre.hookSpecificOutput.permissionDecision, 'allow');

  const completed = spawnSync(process.execPath, [nativeEntry, '--run', requestPath], {
    cwd: fixture.workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(completed.error);
  assert.equal(completed.status, 0);
  assert.equal(parseRunnerOutput(completed.stdout).tool_status, 'ok');

  assert.deepEqual(await handleNativeHook({ ...event, hook_event_name: 'PostToolUse' }, fixture.configPath), {});
});

test('an existing running marker without a result requires recovery and PostToolUse reports interruption', { skip: windowsOnly }, async (t) => {
  const fixture = await makeFixture(t);
  const effectPath = path.join(fixture.workspaceRoot, 'must-not-run.txt');
  const command = `[System.IO.File]::WriteAllText('${effectPath.replaceAll("'", "''")}', 'ran')`;
  const { event, requestPath, request } = await createRequest(fixture, command, 'native-interrupted-call');
  const runningPath = path.join(path.dirname(requestPath), `${request.call_id}.running`);
  await writeFile(runningPath, JSON.stringify({ pid: 1, started_at: new Date().toISOString() }));

  await assert.rejects(runNativeRequest(requestPath), (error) => error.code === 'RECOVERY_REQUIRED');
  assert.equal(await readFile(effectPath, 'utf8').catch((error) => error.code), 'ENOENT');

  const post = await handleNativeHook({ ...event, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } }, fixture.configPath);
  assert.equal(post.decision, 'block');
  assert.equal(JSON.parse(post.reason).error.code, 'INTERRUPTED');
  assert.equal(JSON.parse(post.reason).error.retryable, false);
});

test('missing configuration and invalid or native patch inputs are denied; SessionStart provides routing context', { skip: windowsOnly }, async (t) => {
  const fixture = await makeFixture(t);
  const missing = await handleNativeHook(nativeEvent(fixture, 'Write-Output unreachable'), path.join(fixture.outerRoot, 'missing.json'));
  assert.equal(missing.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(missing.hookSpecificOutput.permissionDecisionReason, /middleware is unavailable/u);

  const invalid = await handleNativeHook(nativeEvent(fixture, ''), fixture.configPath);
  assert.equal(invalid.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(invalid.hookSpecificOutput.permissionDecisionReason, /1–8000 characters/u);

  const patch = await handleNativeHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { patch: '*** Begin Patch\n*** End Patch' },
  }, fixture.configPath);
  assert.equal(patch.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(patch.hookSpecificOutput.permissionDecisionReason, /codex_sol\.sol_apply_patch/u);

  const session = await handleNativeHook({ hook_event_name: 'SessionStart' }, fixture.configPath);
  assert.match(session.hookSpecificOutput.additionalContext, /codex_sol\.sol_apply_patch/u);
  assert.match(session.hookSpecificOutput.additionalContext, /never describe failed, stale, timeout or interrupted receipts as passed/u);
});

test('NativeConfig rejects unknown fields and relative filesystem paths', { skip: windowsOnly }, async (t) => {
  const fixture = await makeFixture(t);
  const event = nativeEvent(fixture, 'Write-Output unreachable');
  const unknownConfigPath = path.join(fixture.outerRoot, 'unknown-field.json');
  await writeFile(unknownConfigPath, JSON.stringify({ ...fixture.config, unexpected: true }));
  const unknown = await handleNativeHook(event, unknownConfigPath);
  assert.equal(unknown.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(unknown.hookSpecificOutput.permissionDecisionReason, /NativeConfig contract invalid/u);

  const relativeConfigPath = path.join(fixture.outerRoot, 'relative-path.json');
  await writeFile(relativeConfigPath, JSON.stringify({ ...fixture.config, workspace: 'workspace' }));
  const relativePath = await handleNativeHook(event, relativeConfigPath);
  assert.equal(relativePath.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(relativePath.hookSpecificOutput.permissionDecisionReason, /workspace must be an absolute path/u);
});
