import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createObservationStore } from '../src/store.mjs';
import { withWorkspaceLock } from '../src/workspace-lock.mjs';
import { runCapturedCommand } from '../src/process.mjs';
import { startMcpServer } from './helpers/mcp-client.mjs';

async function directory(t, { beforeCleanup } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sol-lease-failure-'));
  t.after(async () => { await beforeCleanup?.(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('failed starting metadata retains the proven idle owner and allows the next lease', async (t) => {
  const root = await directory(t);
  const store = await createObservationStore(root);
  const owner = join(store.solRoot, 'managed-modification.owner.json');
  const rename = fs.promises.rename;
  let ownerWrites = 0;
  fs.promises.rename = async (from, to) => {
    if (String(to) === owner && ++ownerWrites === 2) throw Object.assign(new Error('Injected atomic owner publication failure.'), { code: 'EIO' });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    const result = await withWorkspaceLock(store, (lease) => runCapturedCommand(store,
      { id: 'no-launch', argv: [process.execPath, '-e', "require('fs').writeFileSync('must-not-run','bad')"], cwd: '.', timeout_ms: 5000 }, { onRunnerState: lease.setRunner }));
    assert.equal(result.launch_status, 'not_started');
    assert.equal(result.status, 'error');
    await assert.rejects(readFile(join(root, 'must-not-run')), { code: 'ENOENT' });
    await assert.rejects(readFile(owner), { code: 'ENOENT' });
    assert.equal(await withWorkspaceLock(store, async () => 'next-lease', { timeoutMs: 150 }), 'next-lease');
    assert.equal((await readdir(store.solRoot)).some((name) => name.endsWith('.tmp')), false);
  } finally { fs.promises.rename = rename; syncBuiltinESMExports(); }
});

test('STDIO write preserves observed paths, receipt and event when outer owner cleanup fails', { timeout: 25000 }, async (t) => {
  let client;
  const root = await directory(t, { beforeCleanup: () => client?.close() });
  const rulesPath = join(root, 'rules.json');
  await writeFile(rulesPath, JSON.stringify({ schema_version: 1, rules: [{ schema_version: 1, id: 'txt', globs: ['**/*.txt'], watch_paths: ['**/*'],
    commands: [{ id: 'count', argv: [process.execPath, '-e', "require('fs').appendFileSync('.codex/sol/check-count','x')"], cwd: '.', timeout_ms: 5000 }] }] }));
  client = startMcpServer({ workspace: root, rulesPath, serverPath: fileURLToPath(new URL('./helpers/lease-failure-server.mjs', import.meta.url)) });
  await client.initialize({ timeoutMs: 15000 });
  const response = await client.request('tools/call', { name: 'sol_apply_changes', arguments: { changes: [{ action: 'write', path: 'actual.txt', content: 'written' }] } }, { timeoutMs: 15000 });
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, true);
  assert.equal(result.tool_status, 'error');
  assert.deepEqual(result.changed_paths, ['actual.txt']);
  assert.equal(result.validation.status, 'passed');
  assert.ok(result.validation.evidence_handle);
  assert.ok(result.change_event_raw.handle);
  assert.equal(result.recovery_required, true);
  assert.equal(await readFile(join(root, 'actual.txt'), 'utf8'), 'written');
  assert.equal(await readFile(join(root, '.codex', 'sol', 'check-count'), 'utf8'), 'x');
  await client.close();
  const store = await createObservationStore(root);
  assert.equal((await store.readVerifiedJSON(result.validation.evidence_handle)).value.status, 'passed');
  assert.deepEqual((await store.readVerifiedJSON(result.change_event_raw.handle)).value.changed_paths, ['actual.txt']);
  assert.equal(await withWorkspaceLock(store, async () => 'explicit-recovery', { timeoutMs: 150 }), 'explicit-recovery');
  assert.equal(await readFile(join(root, '.codex', 'sol', 'check-count'), 'utf8'), 'x');
});
