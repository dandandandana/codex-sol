import { createObservationStore, SolFault } from './store.mjs';
import { assertContract } from './schema.mjs';
import { ValidationEngine } from './validation.mjs';
import { ContextEngine } from './architecture/context.mjs';
import { ContextSessions } from './architecture/session.mjs';

/** Transport-free composition. All configuration is supplied by the adapter.
 * Hooks may omit rules until an explicitly bound change needs validation; this
 * creates no task, executes no command and does not start a transport.
 */
export async function createSolRuntime(workspaceRoot, rulesConfig = null, options = {}) {
  const store = await createObservationStore(workspaceRoot);
  const validator = rulesConfig === null ? null : new ValidationEngine(store, assertContract('RulesConfig', rulesConfig), options);
  const contextEngine = options.contextRulesPath ? await new ContextEngine(store, options.contextRulesPath).initialize() : null;
  const contextConfig = contextEngine ? await contextEngine.loadConfig() : null;
  const runtime = { store, validator, contextEngine, contextConfig,
    sessions: contextEngine ? new ContextSessions(contextEngine) : null, changesEngine: null };
  if (rulesConfig !== null && contextConfig?.architecture) configureRuntimeChanges(runtime, rulesConfig, options);
  return runtime;
}

/** Bound Hook recovery joins the same deterministic core only when required. */
export function configureRuntimeChanges(runtime, rulesConfig, options = {}) {
  if (!runtime.contextEngine) throw new SolFault('CHANGE_UNAVAILABLE', 'Change state requires configured responsibility context.');
  assertContract('RulesConfig', rulesConfig);
  runtime.validator ??= new ValidationEngine(runtime.store, rulesConfig, options);
  runtime.changesEngine = runtime.contextEngine.configureChanges(rulesConfig, { ...options, validator: runtime.validator });
  return runtime.changesEngine;
}
