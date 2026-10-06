import { randomUUID } from 'node:crypto';
import { runCapturedCommand } from './process.mjs';
import { withWorkspaceLock } from './workspace-lock.mjs';
import { snapshotInputs, digestChangedPaths, receiptSummary } from './validation.mjs';
import { fileFacts, fileFactFingerprint } from './workspace.mjs';
import { pack, storageErrorPack } from './pack.mjs';
import { SolFault } from './store.mjs';
import { assertContract } from './schema.mjs';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
export function publicError(error) {
  return { code: error instanceof SolFault ? error.code : 'IO_ERROR', message: String(error.message ?? error).slice(0, 512), retryable: error instanceof SolFault ? error.retryable : false };
}

/** One actual effect creates one event and one validation flow under its lease.
 * Capture failures remain failures even when validation itself succeeds.
 */
export async function recordActualChanges(store, validator, changed, { callId = randomUUID(), signal, onRunnerState } = {}) {
  if (!changed.length) return { validation: null, eventRef: null, error: null };
  const event = { schema_version: 1, event_id: randomUUID(), workspace_id: store.workspaceId, call_id: callId, origin: 'agent',
    changed_paths: [...changed].sort(), change_digest: await digestChangedPaths(store.workspaceRoot, changed) };
  assertContract('ChangeEvent', event);
  let eventRef = null;
  let error = null;
  let validation = null;
  let writer;
  try {
    writer = await store.beginCapture({ schema_version: 1, workspace_id: store.workspaceId, call_id: callId, tool: 'change_event',
      captured_at: new Date().toISOString(), media_type: 'application/json', encoding: 'utf-8', source_form: 'response_json', channel: 'response' });
    await writer.write(Buffer.from(JSON.stringify(event)));
    eventRef = await writer.commit({ complete: true });
  } catch (cause) {
    await writer?.abort().catch(() => {});
    error = publicError(cause);
  }
  try { validation = receiptSummary(await validator.onChange(event, { signal, onRunnerState })); }
  catch (cause) { error = publicError(cause); }
  return { validation, eventRef, error };
}

/** Executes configured argv once; actual changes and validation share the workspace lease. */
export async function runManagedCommand(store, validator, command, { tool = 'shell', paths, generated = [], signal, callId = randomUUID(), lease: workspaceLease } = {}) {
  let changed = [];
  let validation = null;
  let execution = null;
  let executionFacts = null;
  let observation = null;
  let eventRef = null;
  let output = [];
  let pathsKnown = false;
  const base = () => ({ tool_status: execution?.status === 'timeout' ? 'timeout' : execution?.status === 'passed' ? 'ok' : 'error', execution, changed_paths: [...changed], validation, observation,
    ...(executionFacts?.capture_error ? { capture_error: executionFacts.capture_error } : {}) });
  const finish = async (envelope) => {
    envelope.observation = null;
    if (eventRef) envelope.change_event_raw = eventRef;
    envelope.changed_paths_known = pathsKnown;
    envelope.changed_path_count = pathsKnown ? changed.length : null;
    envelope.changed_paths_omitted = 0;
    while (envelope.changed_paths.length && bytes(envelope) > 3500) { envelope.changed_paths.pop(); envelope.changed_paths_omitted += 1; }
    const meta = { schema_version: 1, call_id: callId, tool, tool_status: envelope.tool_status, upstream_complete: output.length === 2 && output.every((ref) => ref.complete) };
    observation = executionFacts?.capture_error || execution?.reason.includes('STORAGE_ERROR')
      ? storageErrorPack(meta, { refs: output, mayHaveExecuted: executionFacts?.launch_status !== 'not_started' })
      : await pack(store, meta, output, { maxBytes: Math.min(4096, 8192 - bytes(envelope) - 32) });
    envelope.observation = observation;
    if (observation.mode === 'storage_error') envelope.tool_status = 'error';
    if (bytes(envelope) > 8192) throw new SolFault('STORAGE_ERROR', 'Managed command response exceeds 8 KiB.');
    return envelope;
  };
  try {
    const operation = async (lease) => {
      const snapshot = async (options = {}) => paths
        ? new Map([...(await fileFacts(store.workspaceRoot, paths, options)).entries()].map(([path, fact]) => [path, fileFactFingerprint(fact)]))
        : new Map((await snapshotInputs(store.workspaceRoot, ['**/*'], generated, [], options)).items.map((item) => [item.path, fileFactFingerprint(item)]));
      const before = await snapshot({ signal });
      const result = await runCapturedCommand(store, command, { id: callId, tool, signal, onRunnerState: lease.setRunner });
      output = result.output;
      executionFacts = result;
      execution = { status: result.status, reason: result.reason, exit_code: result.exit_code, duration_ms: result.duration_ms };
      const after = await snapshot();
      changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
      pathsKnown = true;
      let validationError = null;
      if (changed.length) {
        const recorded = await recordActualChanges(store, validator, changed, { callId, signal, onRunnerState: lease.setRunner });
        validation = recorded.validation;
        eventRef = recorded.eventRef;
        validationError = recorded.error;
      }
      const envelope = base();
      if (result.cleanup_error) envelope.cleanup_error = result.cleanup_error;
      if (validationError) { envelope.tool_status = 'error'; envelope.validation_error = validationError; }
      return finish(envelope);
    };
    return await (workspaceLease ? operation(workspaceLease) : withWorkspaceLock(store, operation, { signal }));
  } catch (error) {
    // No retry: the command may already have changed files before an I/O error.
    try { return await finish({ ...base(), tool_status: 'error', error: publicError(error) }); }
    catch (packingError) {
      return { tool_status: 'error', error: publicError(error), observation_error: publicError(packingError), execution, changed_paths_known: pathsKnown, changed_path_count: pathsKnown ? changed.length : null, validation, raw: output, ...(eventRef ? { change_event_raw: eventRef } : {}) };
    }
  }
}
