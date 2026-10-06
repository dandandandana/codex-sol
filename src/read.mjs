import { pack, storageErrorPack } from './pack.mjs';
import { interruptionFault, SolFault } from './store.mjs';

function upstreamFault(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError') {
    const fault = interruptionFault(signal, 'File reading was interrupted.');
    return { code: fault.code, message: fault.message, retryable: false };
  }
  return { code: error instanceof SolFault ? error.code : 'IO_ERROR', message: 'File reading failed before completion.', retryable: true };
}

/**
 * Capture before opening the source, preserve partial upstream bytes, and publish
 * only committed refs. openSource({signal}) owns and closes its async iterable.
 * Storage failure stops consumption; it never replays or exposes uncaptured data.
 */
export async function readObservation(store, captureMeta, openSource, { signal } = {}) {
  const meta = { schema_version: 1, call_id: captureMeta.call_id, tool: captureMeta.tool, tool_status: 'unknown', upstream_complete: false };
  let writer;
  let ref;
  let started = false;
  let receivedBytes = 0;
  let storageFailure = null;
  let upstreamError = null;
  const inline = [];
  try {
    writer = await store.beginCapture(captureMeta);
    try {
      if (signal?.aborted) throw interruptionFault(signal, 'File reading was interrupted.');
      started = true;
      const source = await openSource({ signal });
      for await (const chunk of source) {
        if (signal?.aborted) throw interruptionFault(signal, 'File reading was interrupted.');
        const captured = chunk instanceof Uint8Array && receivedBytes + chunk.length <= 8192 ? Buffer.from(chunk) : chunk;
        receivedBytes += captured.length;
        try { await writer.write(captured); }
        catch (error) { storageFailure = error; throw error; }
        if (receivedBytes <= 8192) inline.push(captured);
        else inline.length = 0;
      }
      if (signal?.aborted) throw interruptionFault(signal, 'File reading was interrupted.');
    } catch (error) {
      if (storageFailure) throw error;
      upstreamError = error;
    }
    ref = await writer.commit({ complete: !upstreamError });
    meta.tool_status = upstreamError ? 'unknown' : 'ok';
    meta.upstream_complete = !upstreamError;
    const error = upstreamError ? upstreamFault(upstreamError, signal) : null;
    const envelopeBytes = error ? Buffer.byteLength(JSON.stringify({ observation: null, error })) - 4 : 0;
    const observation = await pack(store, meta, [ref], { maxBytes: 4096 - envelopeBytes });
    if (observation.mode === 'storage_error') return { value: storageErrorPack(meta, { refs: [ref], receivedBytes, mayHaveExecuted: started }), isError: true };
    if (upstreamError) return { value: { observation, error }, isError: true };
    if (observation.mode === 'inline') {
      try { return { value: { observation, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(inline)) }, isError: false }; }
      catch { return { value: { observation, error: { code: 'UNSUPPORTED_ENCODING', message: 'File is not valid UTF-8; recall exact bytes using its handle.', retryable: false } }, isError: true }; }
    }
    return { value: observation, isError: false };
  } catch (error) {
    await writer?.abort();
    process.stderr.write(`Codex-SoL observation storage failed (${error.code ?? error.name ?? 'IO_ERROR'}).\n`);
    meta.tool_status = started ? 'unknown' : 'error';
    return { value: storageErrorPack(meta, { refs: ref ? [ref] : [], receivedBytes, mayHaveExecuted: started }), isError: true };
  }
}
