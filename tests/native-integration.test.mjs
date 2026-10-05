import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { applyManagedPatch, patchPaths } from '../src/patch.mjs';
import { recall } from '../src/recall.mjs';
import { createObservationStore } from '../src/store.mjs';
import { ValidationEngine } from '../src/validation.mjs';
import { runManagedCommand } from '../src/managed-command.mjs';

const windowsOnly = process.platform === 'win32' ? false : 'Native integration coverage is currently enabled on Windows only.';
const patchOnly = process.platform === 'win32' || (process.platform === 'linux' && process.env.CODEX_SOL_PATCH_EXECUTABLE)
  ? false : 'Configure CODEX_SOL_PATCH_EXECUTABLE to run the installed native Codex engine on Linux.';

async function makeWorkspace(t) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-sol-native-integration-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const store = await createObservationStore(workspaceRoot);
  return { workspaceRoot, store };
}

function makeValidator(store) {
  return new ValidationEngine(store, {
    schema_version: 1,
    rules: [{
      schema_version: 1,
      id: 'native-integration',
      globs: ['**/*'],
      watch_paths: ['**/*'],
      commands: [{
        id: 'accept',
        argv: [process.execPath, '-e', 'process.exit(0)'],
        cwd: '.',
        timeout_ms: 10000,
      }],
    }],
  });
}

function nativeCommand(script, timeout_ms = 10000) {
  return { argv: [process.execPath, '-e', script], cwd: '.', timeout_ms };
}

async function recallText(store, observation, literal) {
  for (const ref of observation.raw) {
    const result = await recall(store, {
      schema_version: 1,
      handle: ref.handle,
      selector: { kind: 'keyword', literal, context_lines: 0 },
    });
    const text = result.chunks.map((chunk) => chunk.text ?? '').join('');
    if (text.includes(literal)) return text;
  }
  assert.fail(`No captured observation contains ${JSON.stringify(literal)}.`);
}

async function resolvePatchExecutable() {
  const configured = process.env.CODEX_SOL_PATCH_EXECUTABLE;
  if (configured) {
    try {
      await access(configured);
      return configured;
    } catch (error) {
      throw new Error('CODEX_SOL_PATCH_EXECUTABLE does not point to an accessible Codex executable.', { cause: error });
    }
  }

  if (process.platform === 'win32') {
    const lookup = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$command = Get-Command apply_patch -ErrorAction SilentlyContinue; if ($command) { $command.Source }',
    ], { encoding: 'utf8', windowsHide: true });
    const wrapper = lookup.status === 0 ? lookup.stdout.trim() : '';
    if (wrapper && /\.(?:bat|cmd)$/iu.test(wrapper)) {
      const source = await readFile(wrapper, 'utf8');
      const match = source.match(/"([^"]*codex\.exe)"\s+--codex-run-as-apply-patch/iu);
      if (match) {
        const relative = match[1].replace(/^%~dp0/iu, `${path.win32.dirname(wrapper)}\\`);
        const candidate = path.win32.resolve(relative);
        try {
          await access(candidate);
          return candidate;
        } catch {
          // Continue to the explicit configuration error below.
        }
      }
    }
  }

  throw new Error('Could not resolve the Codex patch executable; configure CODEX_SOL_PATCH_EXECUTABLE with the installed native Codex binary path.');
}

test('patch path parsing sorts and deduplicates paths and rejects unsafe targets', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: zeta.txt',
    '+z',
    '*** Add File: alpha.txt',
    '+a',
    '*** Update File: zeta.txt',
    '@@',
    '-z',
    '+updated',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(patchPaths(patch), ['alpha.txt', 'zeta.txt']);

  const unsafePaths = [
    '/outside.txt',
    'C:/outside.txt',
    '../outside.txt',
    'folder\\outside.txt',
    '.git/config',
    '.codex/sol/observations/data',
    'folder/bad\0file.txt',
    ...(process.platform === 'win32' ? ['.GIT/config', '.CODEX/sol/observations/data', 'file.txt:stream', 'NUL.txt', 'trailing.'] : []),
  ];
  for (const unsafePath of unsafePaths) {
    const unsafePatch = `*** Begin Patch\n*** Add File: ${unsafePath}\n+bad\n*** End Patch`;
    assert.throws(() => patchPaths(unsafePatch), undefined, `should reject ${unsafePath}`);
  }

  const escapingMove = [
    '*** Begin Patch',
    '*** Update File: move-source.txt',
    '*** Move to: ../outside.txt',
    '@@',
    '-before',
    '+after',
    '*** End Patch',
  ].join('\n');
  assert.throws(() => patchPaths(escapingMove), undefined, 'should reject a Move-to path that escapes the workspace');
});

test('patch parser enforces its exact UTF-8 byte limit', () => {
  const prefix = '*** Begin Patch\n*** Add File: utf8-limit.txt\n+';
  const suffix = '\n*** End Patch';
  const payloadBytes = 24000 - Buffer.byteLength(prefix + suffix, 'utf8');
  const content = `${'中'.repeat(Math.floor(payloadBytes / 3))}${'a'.repeat(payloadBytes % 3)}`;
  const accepted = `${prefix}${content}${suffix}`;

  assert.equal(Buffer.byteLength(accepted, 'utf8'), 24000);
  assert.deepEqual(patchPaths(accepted), ['utf8-limit.txt']);

  const oversized = `${prefix}${content}a${suffix}`;
  assert.equal(Buffer.byteLength(oversized, 'utf8'), 24001);
  assert.throws(() => patchPaths(oversized), undefined, 'must reject one byte beyond the UTF-8 limit');
});

test('real Codex patch engine applies a valid patch and runs validation', { skip: patchOnly }, async (t) => {
  const { workspaceRoot, store } = await makeWorkspace(t);
  const executable = await resolvePatchExecutable();
  const patch = [
    '*** Begin Patch',
    '*** Add File: native-added.txt',
    '+created by Codex native patch engine',
    '*** End Patch',
  ].join('\n');

  const result = await applyManagedPatch(store, makeValidator(store), patch, { executable });

  assert.equal(result.tool_status, 'ok');
  assert.deepEqual(result.changed_paths, ['native-added.txt']);
  assert.equal(await readFile(path.join(workspaceRoot, 'native-added.txt'), 'utf8'), 'created by Codex native patch engine\n');
  assert.equal(result.validation?.status, 'passed', 'a real workspace change must pass its configured acceptance check');
  assert.ok(result.observation.raw.length > 0);
});

test('real Codex patch engine reports a context failure without changing the workspace', { skip: patchOnly }, async (t) => {
  const { workspaceRoot, store } = await makeWorkspace(t);
  const executable = await resolvePatchExecutable();
  await writeFile(path.join(workspaceRoot, 'context.txt'), 'the actual source line\n');
  const patch = [
    '*** Begin Patch',
    '*** Update File: context.txt',
    '@@',
    '-a context line that is not present',
    '+replacement',
    '*** End Patch',
  ].join('\n');

  const result = await applyManagedPatch(store, makeValidator(store), patch, { executable });

  assert.equal(result.tool_status, 'error');
  assert.equal(result.execution.status, 'failed');
  assert.notEqual(result.execution.exit_code, 0);
  assert.deepEqual(result.changed_paths, []);
  assert.equal(result.validation, null);
  assert.equal(await readFile(path.join(workspaceRoot, 'context.txt'), 'utf8'), 'the actual source line\n');
});

test('managed patch refuses to write through a directory link', { skip: patchOnly }, async (t) => {
  const { workspaceRoot, store } = await makeWorkspace(t);
  const executable = await resolvePatchExecutable();
  const realDirectory = path.join(workspaceRoot, 'real-directory');
  const junction = path.join(workspaceRoot, 'linked-directory');
  await mkdir(realDirectory);
  try {
    await symlink(realDirectory, junction, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOTSUP', 'ENOSYS'].includes(error?.code)) {
      t.skip(`Windows directory junctions are unavailable here (${error.code}).`);
      return;
    }
    throw error;
  }
  t.after(async () => {
    if ((await lstat(junction).catch(() => null))?.isSymbolicLink()) await rm(junction, { force: true });
  });
  const patch = [
    '*** Begin Patch',
    '*** Add File: linked-directory/escaped.txt',
    '+must not be written through the junction',
    '*** End Patch',
  ].join('\n');

  await assert.rejects(applyManagedPatch(store, makeValidator(store), patch, { executable }));
  assert.equal(await readFile(path.join(realDirectory, 'escaped.txt'), 'utf8').catch((error) => error.code), 'ENOENT');
});

test('managed command captures large stdout for recall and preserves nonzero-exit stderr plus acceptance', async (t) => {
  const { workspaceRoot, store } = await makeWorkspace(t);
  const validator = makeValidator(store);
  const anchor = 'NATIVE_RECALL_ANCHOR_7f50bd';
  const large = await runManagedCommand(store, validator, nativeCommand(
    `process.stdout.write('x'.repeat(40 * 1024) + '\\n' + ${JSON.stringify(anchor)} + '\\n')`,
  ));

  assert.equal(large.tool_status, 'ok');
  assert.ok(large.observation.raw.some((ref) => ref.bytes > 32 * 1024));
  assert.match(await recallText(store, large.observation, anchor), new RegExp(anchor));
  assert.deepEqual(large.changed_paths, []);
  assert.equal(large.validation, null);

  const createdPath = 'written-before-exit.txt';
  const stderrMarker = 'NATIVE_STDERR_BEFORE_EXIT_7';
  const failure = await runManagedCommand(store, validator, nativeCommand([
    `require('node:fs').writeFileSync(${JSON.stringify(createdPath)}, 'persisted before nonzero exit\\n')`,
    `process.stderr.write(${JSON.stringify(stderrMarker)} + '\\n')`,
    'process.exit(7)',
  ].join(';')));

  assert.equal(failure.tool_status, 'error');
  assert.equal(failure.execution.status, 'failed');
  assert.equal(failure.execution.exit_code, 7);
  assert.deepEqual(failure.changed_paths, [createdPath]);
  assert.equal(failure.validation?.status, 'passed', 'changed files need a passing acceptance receipt even when the tool exits nonzero');
  assert.match(await recallText(store, failure.observation, stderrMarker), new RegExp(stderrMarker));
  assert.equal(await readFile(path.join(workspaceRoot, createdPath), 'utf8'), 'persisted before nonzero exit\n');
});

test('a no-op managed command does not create a validation receipt', async (t) => {
  const { store } = await makeWorkspace(t);
  const result = await runManagedCommand(store, makeValidator(store), nativeCommand('process.exit(0)'));

  assert.equal(result.tool_status, 'ok');
  assert.deepEqual(result.changed_paths, []);
  assert.equal(result.validation, null);
});

test('store archives under uppercase .CODEX are excluded from managed change detection on Windows', { skip: windowsOnly }, async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-sol-native-uppercase-store-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await mkdir(path.join(workspaceRoot, '.CODEX'));
  const store = await createObservationStore(workspaceRoot);

  assert.ok((await readdir(workspaceRoot)).includes('.CODEX'), 'the fixture must retain the uppercase directory spelling');
  const result = await runManagedCommand(store, makeValidator(store), nativeCommand('process.exit(0)'));

  assert.equal(result.tool_status, 'ok');
  assert.deepEqual(result.changed_paths, []);
  assert.equal(result.validation, null);
});

test('timeout marks captured streams incomplete, kills the runner, and permits a later command', async (t) => {
  const { workspaceRoot, store } = await makeWorkspace(t);
  const marker = 'timeout-child-survived.txt';
  const script = [
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 700)`,
    "setInterval(() => process.stdout.write('timeout tick\\n'), 40)",
  ].join(';');
  const validator = makeValidator(store);
  const timed = await runManagedCommand(store, validator, nativeCommand(script, 150));

  assert.equal(timed.tool_status, 'timeout');
  assert.equal(timed.execution.status, 'timeout');
  assert.ok(timed.observation.raw.some((ref) => ref.complete === false));
  await delay(800);
  assert.equal(await readFile(path.join(workspaceRoot, marker), 'utf8').catch((error) => error.code), 'ENOENT');

  const afterTimeout = await runManagedCommand(store, validator, nativeCommand('process.exit(0)'));
  assert.equal(afterTimeout.tool_status, 'ok');
});

test('cancellation ends the runner with incomplete evidence and leaves the next call usable', async (t) => {
  const { workspaceRoot, store } = await makeWorkspace(t);
  const marker = 'cancelled-child-survived.txt';
  const script = [
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 700)`,
    "setInterval(() => process.stdout.write('cancel tick\\n'), 40)",
  ].join(';');
  const validator = makeValidator(store);
  const controller = new AbortController();
  const pending = runManagedCommand(store, validator, nativeCommand(script), { signal: controller.signal });
  const abortTimer = setTimeout(() => controller.abort(), 150);
  const cancelled = await pending;
  clearTimeout(abortTimer);

  assert.equal(cancelled.tool_status, 'error');
  assert.equal(cancelled.execution.reason, 'interrupted');
  assert.ok(cancelled.observation.raw.some((ref) => ref.complete === false));
  await delay(800);
  assert.equal(await readFile(path.join(workspaceRoot, marker), 'utf8').catch((error) => error.code), 'ENOENT');

  const afterCancel = await runManagedCommand(store, validator, nativeCommand('process.exit(0)'));
  assert.equal(afterCancel.tool_status, 'ok');
});
