import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObservationStore } from '../src/store.mjs';
import { ArchiveRecords } from '../src/records.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sol-records-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await createObservationStore(root);
  return { root, store, records: new ArchiveRecords(store) };
}

test('records preserve archived bytes and verify type, workspace and exact RawRef in one read', async (t) => {
  const { store, records } = await fixture(t);
  const value = { schema_version: 1, kind: 'fixture', workspace_id: store.workspaceId, message: '中文' };
  const ref = await records.archive(value, 'fixture_tool');
  store.openVerified = async () => { throw new Error('Bare archive access is forbidden.'); };
  assert.deepEqual(await records.stored(ref, 'fixture_tool', 'fixture'), value);
  assert.deepEqual(await records.evidence([ref.handle, ref.handle]), [ref]);
  await assert.rejects(records.stored(ref, 'other_tool', 'fixture'), { code: 'REFERENCE_INVALID' });
  await assert.rejects(records.stored(ref, 'fixture_tool', 'other_kind'), { code: 'REFERENCE_INVALID' });
  await assert.rejects(records.stored({ ...ref, sha256: '0'.repeat(64) }, 'fixture_tool', 'fixture'), { code: 'REFERENCE_INVALID' });
  const wrong = await records.archive({ ...value, workspace_id: 'other' }, 'fixture_tool');
  await assert.rejects(records.stored(wrong, 'fixture_tool', 'fixture'), { code: 'REFERENCE_INVALID' });
});

test('records reject excessive/corrupt bytes and cancellation without publishing fake refs', async (t) => {
  const { root, store, records } = await fixture(t);
  const value = { schema_version: 1, kind: 'fixture', workspace_id: store.workspaceId };
  await assert.rejects(records.archive({ ...value, message: 'a'.repeat(256 * 1024) }, 'fixture_tool'), { code: 'INPUT_LIMIT' });
  const ref = await records.archive(value, 'fixture_tool');
  await writeFile(join(root, '.codex/sol/observations', ref.handle, 'raw'), 'corrupted');
  await assert.rejects(records.stored(ref, 'fixture_tool', 'fixture'), { code: 'CORRUPT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(records.archive(value, 'fixture_tool', controller.signal), { code: 'INTERRUPTED' });
  await assert.rejects(records.evidence([ref.handle], controller.signal), { code: 'INTERRUPTED' });
});

test('structured record consumers reject text, alternate encoding, stream and output-channel metadata', async (t) => {
  const { root, store, records } = await fixture(t);
  const value = { schema_version: 1, kind: 'fixture', workspace_id: store.workspaceId };
  const ref = await records.archive(value, 'fixture_tool');
  const metaPath = join(root, '.codex/sol/observations', ref.handle, 'meta.json');
  const original = JSON.parse(await readFile(metaPath, 'utf8'));
  for (const altered of [{ media_type: 'text/plain' }, { encoding: 'base64' }, { source_form: 'stream_bytes' }, { channel: 'stdout' }]) {
    await writeFile(metaPath, JSON.stringify({ ...original, ...altered }));
    await assert.rejects(records.stored(ref.handle, 'fixture_tool', 'fixture'), { code: 'REFERENCE_INVALID' });
  }
  await writeFile(metaPath, JSON.stringify(original));
  assert.deepEqual(await records.stored(ref.handle, 'fixture_tool', 'fixture'), value);
});
