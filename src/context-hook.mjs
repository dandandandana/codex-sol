import { realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SolFault } from './store.mjs';
import { readWorkspaceBytes } from './workspace.mjs';
import { withWorkspaceLock } from './workspace-lock.mjs';
import { patchPaths } from './patch.mjs';
import { contextError } from './architecture/context.mjs';
import { createSolRuntime, configureRuntimeChanges } from './runtime.mjs';

const nativeWrites = new Set(['apply_patch', 'Edit', 'Write']);
const managedWrite = (name) => typeof name === 'string' ? /^mcp__.+__sol_apply_(patch|changes)$/u.exec(name)?.[1] : undefined;
const deny = (code, next) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
  permissionDecisionReason: `${code}: ${next}` } });
const unfinished = (code, next) => ({ systemMessage: `SoL change remains unfinished (${code}). ${next}` });
function writePaths(kind, input) {
  if (kind === 'patch') return patchPaths(input?.patch);
  if (!Array.isArray(input?.changes) || !input.changes.length || input.changes.length > 50
    || input.changes.some((item) => !item || !['write', 'delete'].includes(item.action) || typeof item.path !== 'string'))
    throw new SolFault('BAD_ARGUMENTS', 'Use the sol_apply_changes input contract with explicit write/delete target paths.');
  return input.changes.map((item) => item.path);
}

/** Host adapter. Absent opt-in => no injection. Uses the local shared core
 * without assuming the MCP connection is ready; never modifies project source.
 */
export async function handleContextHook(event, { workspace, rules, validationRules, generated = [], signal } = {}) {
  const name = event?.hook_event_name;
  if (!['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'].includes(name) || !rules) return {};
  if (name === 'SessionStart' && !['startup', 'resume', 'clear', 'compact'].includes(event.source)) return {};
  const writeKind = managedWrite(event.tool_name);
  if (name === 'PreToolUse' && !writeKind && !nativeWrites.has(event.tool_name)) return {};
  // The host supplies this flag for the whole turn; never create another retry counter.
  if (name === 'Stop' && event.stop_hook_active === true) return {};
  try {
    const root = await realpath(resolve(workspace));
    const cwd = await realpath(event.cwd);
    const normalize = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
    const prefix = normalize(root).endsWith(sep) ? normalize(root) : normalize(root) + sep;
    if (normalize(cwd) !== normalize(root) && !normalize(cwd).startsWith(prefix)) throw new Error('Workspace mismatch');
    const runtime = await createSolRuntime(root, null, { contextRulesPath: rules });
    const { store, contextEngine: engine, sessions } = runtime;
    if (['PreToolUse', 'Stop'].includes(name) && !(await engine.loadConfig(signal)).architecture) return {};
    if (name === 'PreToolUse' && nativeWrites.has(event.tool_name))
      return deny('MANAGED_WRITE_REQUIRED', 'Use sol_apply_patch or sol_apply_changes with the explicit task/change binding; native patch is not replaced automatically.');
    const bound = await sessions.read(event.session_id, { signal });
    const record = bound ? await engine.stored(bound.handle, 'sol_context_prepare', 'context_record', signal) : null;
    if (record?.change_state) {
      // Independent command Hooks do not inherit MCP server env. Only a bound
      // session needs validation config; old unbound recovery stays independent.
      if (!validationRules) throw new SolFault('CHANGE_UNAVAILABLE', 'Bound change recovery requires explicit validation rules matching MCP.');
      const rulesPath = resolve(root, validationRules);
      const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readWorkspaceBytes(root,
        relative(root, rulesPath).replaceAll('\\', '/'), 256 * 1024, { signal })));
      const exclusions = typeof generated === 'string' ? JSON.parse(generated) : generated;
      configureRuntimeChanges(runtime, config, { rulesPath, generated: exclusions, requireRecordedConfig: true });
    }
    if (name === 'PreToolUse' || name === 'Stop') {
      return await withWorkspaceLock(store, async () => {
        const context = await sessions.read(event.session_id, { signal });
        const prepared = context ? await engine.stored(context.handle, 'sol_context_prepare', 'context_record', signal) : null;
        if (!prepared?.change_state) {
          if (name === 'Stop') return {};
          return deny('CHANGE_CONTEXT_REQUIRED', 'Prepare this session’s explicit task and change with sol_context_prepare before a managed write. Do not inherit another chat’s workspace change.');
        }
        if (!engine.changes) throw new SolFault('CHANGE_UNAVAILABLE', 'The session binding changed while loading configuration; recover and retry.');
        if (name === 'PreToolUse') {
          if (event.tool_input?.change?.id !== prepared.change_state.change.id)
            throw new SolFault('CHANGE_NOT_CURRENT', 'The write must use this session’s explicitly prepared change ID.');
          await engine.changes.preflightWriteLocked(event.tool_input.change, writePaths(writeKind, event.tool_input), { task: prepared.task, signal });
          return {};
        }
        const state = await sessions.changeLocked(prepared, signal);
        if (state.task_complete) return {};
        if (event.stop_hook_active !== false)
          return unfinished('STOP_FLAG_UNAVAILABLE', 'The host did not provide a valid continuation flag; inspect sol_change_status explicitly.');
        const waiting = prepared.status === 'blocked' || ['interrupted', 'abandoned', 'checking'].includes(state.state)
          || state.blocking.codes.some((code) => !['CHANGE_STATUS_REFRESH', 'CHANGE_REVIEW_STALE', 'CHANGE_COMPLETION_INVALID'].includes(code));
        if (waiting) return unfinished(state.state, state.next + ' Resolve required inputs or external blockers explicitly; no operation will be replayed.');
        return { decision: 'block', reason: JSON.stringify({ kind: 'change_closeout', change: state.change,
          state: state.state, task_complete: false, review: state.review, completion: state.completion,
          next: state.next + ' Perform an actionable closeout step only. If input or an external prerequisite is missing, report it and preserve unfinished state. This Hook permits at most one continuation per turn; acceptance or a passed single check is not completion.' }) };
      }, { signal });
    }
    if (name === 'UserPromptSubmit') {
      const reminder = await sessions.remind(event.session_id, { signal });
      return reminder ? { hookSpecificOutput: { hookEventName: name, additionalContext: JSON.stringify(reminder) } } : {};
    }
    const recovered = await sessions.recover(event.session_id, { signal });
    const text = recovered ? JSON.stringify(recovered) : JSON.stringify({ kind: 'context_entry', bound_task: false,
      roles: [...(await engine.loadConfig(signal)).roles.keys()],
      next: 'Context is configured for this workspace. For a concrete task call sol_context_prepare with its explicit identity, goal, role and target paths. Use sol_recall for omitted material and sol_context_submit for the required output. No task is bound to this session; do not infer one from another chat. Tool availability depends on the MCP connection.' });
    return { hookSpecificOutput: { hookEventName: name, additionalContext: text } };
  } catch (error) {
    const { error: diagnostic } = contextError(error);
    if (name === 'PreToolUse') return deny(diagnostic.code, diagnostic.message + ' Inspect configuration or sol_change_status; prepare the matching task before retrying.');
    if (name === 'Stop') return unfinished(diagnostic.code, 'Closeout could not be verified. Inspect configuration and sol_change_status; do not report completion.');
    return { hookSpecificOutput: { hookEventName: name, additionalContext: JSON.stringify({ kind: 'context_unavailable', code: diagnostic.code,
      next: 'Context recovery did not succeed. Inspect configuration or prepare fresh responsibility inputs through MCP. Do not report old material or task state as current or complete.' }) } };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const flags = new Map();
    for (let i = 0; i < args.length; i += 2) {
      if (!['--workspace', '--rules', '--validation-rules', '--generated'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || flags.has(args[i])) throw new Error('Invalid argument');
      flags.set(args[i], args[i + 1]);
    }
    const workspace = flags.get('--workspace') ?? process.env.CODEX_SOL_WORKSPACE;
    const rules = flags.get('--rules') ?? process.env.CODEX_SOL_CONTEXT_RULES;
    const validationRules = flags.get('--validation-rules') ?? process.env.CODEX_SOL_RULES;
    // Delay validation-only configuration until an explicit change is found.
    const generated = flags.get('--generated') ?? process.env.CODEX_SOL_GENERATED_PATHS ?? '[]';
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 128 * 1024) throw new Error('Hook input limit exceeded');
    }
    const result = await handleContextHook(JSON.parse(input), { workspace, rules, validationRules, generated });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Context Hook input or configuration is invalid.\n');
    process.exitCode = 1;
  }
}
