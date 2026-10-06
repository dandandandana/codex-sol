import { fileFacts, fileFactFingerprint, writeWorkspaceFile, deleteWorkspaceFile, workspaceFile, validateWorkspacePath } from './workspace.mjs';
import { interruptionFault, SolFault } from './store.mjs';
import { randomUUID } from 'node:crypto';
import { withWorkspaceLock } from './workspace-lock.mjs';
import { publicError, recordActualChanges } from './managed-command.mjs';

/** Direct write/delete effects only. Caller owns identity, lease, event, validation
 * and task state. Preflight failure cannot mutate files; partial effects are never
 * rolled back or retried. A failed post-observation keeps change knowledge unknown.
 */
export async function applyFileChanges(root, changes, { signal } = {}) {
  if (!Array.isArray(changes) || changes.some((change) => !change || !['write', 'delete'].includes(change.action)
    || (change.action === 'write' && typeof change.content !== 'string')))
    throw new SolFault('BAD_ARGUMENTS', 'Changes must contain explicit write content or delete actions.');
  const paths = changes.map((change) => change.path);
  paths.forEach(validateWorkspacePath);
  if (new Set(paths.map((path) => process.platform === 'win32' ? path?.toLowerCase() : path)).size !== paths.length)
    throw new SolFault('PATH_ERROR', 'Each path may appear only once per call, including case aliases.');
  for (const path of paths) await workspaceFile(root, path, { allowMissing: true });
  const before = await fileFacts(root, paths, { signal });
  let error = null;
  const published = [];
  for (const change of changes) {
    if (signal?.aborted) { error = interruptionFault(signal, 'Managed modification was interrupted.'); break; }
    try {
      const options = { signal, expected: before.get(change.path) };
      if (change.action === 'delete') { await deleteWorkspaceFile(root, change.path, options); published.push(change.path); }
      else if (await writeWorkspaceFile(root, change.path, change.content, options)) published.push(change.path);
    } catch (cause) { error = cause; break; }
  }
  // Cancellation does not suppress the actual effects already published.
  try {
    const after = await fileFacts(root, paths);
    const changed = paths.filter((path) => fileFactFingerprint(before.get(path)) !== fileFactFingerprint(after.get(path)));
    return { changed, error, before, after, changed_paths_known: true };
  } catch (cause) {
    return { changed: published, error: cause, ...(error ? { modification_error: error } : {}), before, after: null, changed_paths_known: false };
  }
}

/** Reusable write entry: effects, event and synchronous validation share one
 * lease. Bound callers supply their operation identity; this never publishes
 * task state. Failures preserve observed partial effects and never retry writes.
 */
export async function runManagedFileChanges(store, validator, changes, { signal, callId = randomUUID(), lease } = {}) {
  let applied = { changed: [], error: null, changed_paths_known: false };
  let validation = null;
  let eventRef = null;
  const result = () => ({ tool_status: applied.error ? 'error' : 'ok', changed_paths: applied.changed,
    validation, upstream_error: applied.error ? publicError(applied.error) : null,
    ...(eventRef ? { change_event_raw: eventRef } : {}) });
  const operation = async (ownedLease) => {
    applied = await applyFileChanges(store.workspaceRoot, changes, { signal });
    if (!applied.changed_paths_known) return { ...result(), tool_status: 'error', changed_paths_known: false,
      error: publicError(applied.error), ...(applied.modification_error ? { upstream_error: publicError(applied.modification_error) } : {}) };
    const recorded = await recordActualChanges(store, validator, applied.changed, { callId, signal, onRunnerState: ownedLease.setRunner });
    validation = recorded.validation;
    eventRef = recorded.eventRef;
    return { ...result(), ...(recorded.error ? { tool_status: 'error', validation_error: recorded.error } : {}) };
  };
  try { return await (lease ? operation(lease) : withWorkspaceLock(store, operation, { signal })); }
  catch (error) { return { ...result(), tool_status: 'error', error: publicError(error), changed_paths_known: applied.changed_paths_known }; }
}
