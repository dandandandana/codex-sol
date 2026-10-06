import { randomUUID } from 'node:crypto';
import { interruptionFault, SolFault } from './store.mjs';
import { assertContract } from './schema.mjs';

const RECORD_BYTES = 256 * 1024;
const check = (signal) => { if (signal?.aborted) throw interruptionFault(signal, 'Record access was interrupted.'); };
const fail = (code, message) => { throw new SolFault(code, message); };
const reference = (handle, meta) => ({ schema_version: 1, handle, sha256: meta.sha256,
  bytes: meta.bytes, media_type: meta.media_type, complete: meta.complete });

/** Immutable bounded evidence only. No mutable task state or Context routing. */
export class ArchiveRecords {
  constructor(store) { this.store = store; }

  async archive(value, tool, signal, text = false, { callId = randomUUID() } = {}) {
    check(signal);
    let bytes;
    try { bytes = text ? Buffer.from(value) : Buffer.from(JSON.stringify(value)); }
    catch { fail('INPUT_ERROR', 'Record data must be serializable JSON.'); }
    if (bytes.length > (text ? 1024 * 1024 : RECORD_BYTES)) fail('INPUT_LIMIT', 'Archived record exceeds its byte limit.');
    const writer = await this.store.beginCapture({ schema_version: 1, workspace_id: this.store.workspaceId,
      call_id: callId, tool, captured_at: new Date().toISOString(), media_type: text ? 'text/plain; charset=utf-8' : 'application/json',
      encoding: 'utf-8', source_form: text ? 'stream_bytes' : 'response_json', channel: 'response' });
    try { await writer.write(bytes); check(signal); return await writer.commit({ complete: true }); }
    catch (error) { await writer.abort(); throw error; }
  }

  async stored(value, tool, kind, signal) {
    check(signal);
    const ref = typeof value === 'string' ? null : value;
    if (ref) assertContract('RawRef', ref);
    const handle = ref?.handle ?? value;
    const { value: record } = await this.store.readVerifiedJSON(handle, { maxBytes: RECORD_BYTES, signal,
      validateMeta: (meta) => {
        if (meta.tool !== tool || !meta.complete || meta.bytes > RECORD_BYTES || meta.media_type !== 'application/json'
          || meta.encoding !== 'utf-8' || meta.source_form !== 'response_json' || meta.channel !== 'response'
          || (ref && Object.entries(reference(handle, meta)).some(([field, expected]) => ref[field] !== expected)))
          fail('REFERENCE_INVALID', 'Reference does not match complete evidence of the expected type.');
      } });
    if (record?.kind !== kind || record.schema_version !== 1 || record.workspace_id !== this.store.workspaceId)
      fail('REFERENCE_INVALID', 'Record reference has the wrong workspace, identity or kind.');
    return record;
  }

  async evidence(handles, signal) {
    const refs = [];
    for (const value of new Set(handles)) {
      check(signal);
      const { meta } = await this.store.verify(value, { signal });
      refs.push(reference(value, meta));
    }
    return refs;
  }
}
