import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverTestFiles } from '../scripts/ci-check.mjs';

const runner = fileURLToPath(new URL('../scripts/test-runner.mjs', import.meta.url));
function runFiles(files) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [runner, ...files], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
}

async function testDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-sol-ci-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'portable.test.mjs'), '');
  await writeFile(path.join(directory, 'native-integration.test.mjs'), '');
  await writeFile(path.join(directory, 'helper.mjs'), '');
  await mkdir(path.join(directory, 'nested.test.mjs'));
  return directory;
}

test('portable mode selects top-level test files while excluding Codex native integration', async (t) => {
  const testsDir = await testDirectory(t);
  const files = discoverTestFiles('portable', {
    testsDir,
    env: { CODEX_SOL_PATCH_EXECUTABLE: 'deliberately-not-a-native-executable' },
    platform: 'win32',
  });

  assert.deepEqual(files, [path.join(testsDir, 'portable.test.mjs')]);
});

test('native mode rejects a missing Codex executable before selecting tests', async (t) => {
  const testsDir = await testDirectory(t);

  assert.throws(
    () => discoverTestFiles('native', { testsDir, env: {}, platform: 'linux' }),
    /CODEX_SOL_PATCH_EXECUTABLE/,
  );
});

test('all mode preserves the complete file set without requiring a native path', async (t) => {
  const testsDir = await testDirectory(t);
  const all = discoverTestFiles('all', { testsDir, env: {}, platform: process.platform });
  assert.deepEqual(all, [path.join(testsDir, 'native-integration.test.mjs'), path.join(testsDir, 'portable.test.mjs')]);
  await writeFile(all[0], "import test from 'node:test'; test('native-file-selected', () => {});");
  await writeFile(all[1], "import test from 'node:test'; test('portable-file-selected', () => {});");
  await writeFile(path.join(testsDir, 'helper.mjs'), "throw new Error('unselected helper must not execute');");
  const result = runFiles(all);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /native-file-selected/);
  assert.match(result.stdout, /portable-file-selected/);
});

test('standard reporter returns nonzero for a real assertion failure and an unknown test file', async (t) => {
  const testsDir = await testDirectory(t);
  const failing = path.join(testsDir, 'portable.test.mjs');
  await writeFile(failing, "import test from 'node:test'; import assert from 'node:assert/strict'; test('intentional-failure', () => assert.equal(1, 2));");
  const failed = runFiles([failing]);
  assert.equal(failed.status, 1, failed.stderr + failed.stdout);
  assert.match(failed.stdout, /intentional-failure/);
  const missing = runFiles([path.join(testsDir, 'missing.test.mjs')]);
  assert.equal(missing.status, 1, missing.stderr + missing.stdout);
  const empty = runFiles([]);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /explicit test file list/);
});

test('programmatic scheduling never exceeds four simultaneous test files', async (t) => {
  const testsDir = await testDirectory(t);
  const events = path.join(testsDir, 'events.jsonl');
  const files = [];
  for (let i = 0; i < 8; i += 1) {
    const file = path.join(testsDir, `parallel-${i}.test.mjs`);
    files.push(file);
    await writeFile(file, `import test from 'node:test'; import { appendFileSync } from 'node:fs'; import {setTimeout} from 'node:timers/promises';
test('parallel-${i}', async () => { appendFileSync(${JSON.stringify(events)}, JSON.stringify({ phase: 'start', id: ${i} }) + '\\n');
await setTimeout(100); appendFileSync(${JSON.stringify(events)}, JSON.stringify({ phase: 'end', id: ${i} }) + '\\n'); });`);
  }
  const result = runFiles(files);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const active = new Set();
  const completed = new Set();
  for (const row of (await readFile(events, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))) {
    if (row.phase === 'start') active.add(row.id);
    else { assert.ok(active.delete(row.id)); completed.add(row.id); }
    assert.ok(active.size <= 4, `simultaneous files: ${active.size}`);
  }
  assert.equal(active.size, 0);
  assert.equal(completed.size, 8);
});

test('SIGTERM aborts the runner, exits nonzero and closes its real test child', { skip: process.platform === 'win32' && 'POSIX signal delivery; Windows CI forwards cancellation through taskkill /T.', timeout: 15000 }, async (t) => {
  const testsDir = await testDirectory(t);
  const marker = path.join(testsDir, 'child-pid');
  const waiting = path.join(testsDir, 'waiting.test.mjs');
  await writeFile(waiting, `import test from 'node:test'; import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, String(process.pid));
setInterval(() => {}, 1000); test('waiting', () => new Promise(() => {}));`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [runner, waiting], { env, detached: true, stdio: 'ignore' });
  const completion = new Promise((done, fail) => { child.once('error', fail); child.once('close', (code, signal) => done({ code, signal })); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } });
  let testPid;
  const deadline = Date.now() + 5000;
  while (!testPid) {
    try { testPid = Number(await readFile(marker, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() >= deadline) assert.fail('Test child did not become ready.');
    if (!testPid) await delay(20);
  }
  assert.equal(child.kill('SIGTERM'), true);
  assert.deepEqual(await completion, { code: 143, signal: null });
  assert.throws(() => process.kill(testPid, 0), { code: 'ESRCH' });
});
