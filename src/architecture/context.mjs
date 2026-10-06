import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { z } from 'zod';
import { interruptionFault, SolFault } from '../store.mjs';
import { fileFacts, INPUT_FINGERPRINT_KIND, readWorkspaceBytes, workspaceFile } from '../workspace.mjs';
import { withWorkspaceLock } from '../workspace-lock.mjs';
import { assertContract } from '../schema.mjs';
import { ArchiveRecords } from '../records.mjs';
import { ArchitectureIndex, architectureQuerySchema } from './index.mjs';
import { ChangeCoordinator, changeBindingSchema } from './change.mjs';

const PACKET_BYTES = 4096;
const FILE_BYTES = 1024 * 1024;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/u);
const handle = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u);
const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u).refine((s) => !['constructor', 'prototype'].includes(s));
const path = z.string().min(1).max(256);
const task = z.object({ id: z.string().min(1).max(128), goal: z.string().min(1).max(768), constraints: z.array(z.string().min(1).max(256)).max(8).default([]) }).strict();
export const contextPrepareSchema = z.object({ task, role: id, targets: z.array(path).max(16).default([]), upstream_handle: handle.optional(), architecture_query: z.string().max(256).optional(), change: changeBindingSchema.optional() }).strict();
export const contextSubmitSchema = z.object({ context_handle: handle, task_id: z.string().min(1).max(128), role: id, version: z.string().regex(/^[a-f0-9]{64}$/u), output: z.record(z.string(), z.unknown()), evidence_handles: z.array(handle).max(16).default([]) }).strict();
const configSchema = z.object({ schema_version: z.literal(1), roles: z.array(z.object({
  id, goal: z.string().min(1).max(512), allowed_operations: z.array(z.string().min(1).max(64)).min(1).max(8),
  sources: z.array(z.object({ path, required: z.boolean() }).strict()).max(24),
  require_targets: z.boolean(), input: z.object({ from_role: id, required: z.boolean() }).strict().optional(),
  output_schema: z.record(z.string(), z.unknown()), blocking_field: field.optional(),
  consumers: z.array(z.object({ role: id, fields: z.record(field, field) }).strict()).max(8), architecture: z.boolean().optional(),
}).strict()).min(1).max(8), architecture: z.object({ path }).strict().optional() }).strict();

function fail(code, message, diagnostics) {
  const error = new SolFault(code, message);
  if (diagnostics) error.diagnostics = diagnostics;
  throw error;
}
function checkSignal(signal) {
  if (signal?.aborted) throw interruptionFault(signal, 'Context operation was interrupted.');
}
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) fail('INPUT_ERROR', 'Context input does not match its contract.', result.error.issues.slice(0, 8).map((e) => ({ path: e.path.join('.').slice(0, 160), message: e.message.slice(0, 200) })));
  return result.data;
}
function jsonBytes(value) {
  try { return Buffer.from(JSON.stringify(value)); }
  catch { fail('INPUT_ERROR', 'Context data must be serializable JSON.'); }
}

async function readFile(store, sourcePath, maxBytes, signal) {
  return readWorkspaceBytes(store.workspaceRoot, sourcePath, maxBytes, { signal });
}

function fingerprint(record) {
  return sha(jsonBytes({ config_sha: record.config_sha, task: record.task, role: record.role.id, targets: record.targets,
    sources: record.sources.map(({ path: sourcePath, required, state, sha256, mode }) => ({ path: sourcePath, required, state, sha256,
      ...(record.input_fingerprint_kind ? { mode } : {}) })),
    ...(record.input_fingerprint_kind ? { input_fingerprint_kind: record.input_fingerprint_kind } : {}),
    upstream: record.upstream?.artifact.sha256 ?? null, ...(record.architecture ? { architecture_version: record.architecture.version, architecture_query: record.architecture.query } : {}),
    ...(record.change_state ? { change_state_version: record.change_state.version } : {}) }));
}

function prefix(text, maxBytes) {
  let result = '';
  let bytes = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    result += char;
  }
  return result;
}

/** Read-only shared Context contract parser. Does not create storage or archives. */
export async function readContextConfiguration(workspaceRoot, configPath, { signal } = {}) {
    let bytes;
    let config;
    try {
      bytes = await readWorkspaceBytes(workspaceRoot, configPath, 128 * 1024, { signal });
      config = configSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch (error) {
      if (error.code === 'INTERRUPTED' || error.code === 'HOST_STATE_ERROR') throw error;
      fail('CONFIG_ERROR', 'Context configuration must be a valid, bounded JSON file inside the workspace.');
    }
    const roles = new Map();
    const validators = new Map();
    const ajv = new Ajv({ allErrors: true, validateFormats: false, strict: true });
    for (const role of config.roles) {
      if (roles.has(role.id)) fail('CONFIG_ERROR', 'Context role IDs must be unique.');
      if (new Set(role.sources.map((s) => s.path)).size !== role.sources.length) fail('CONFIG_ERROR', 'Role source paths must be unique.');
      for (const source of role.sources) await workspaceFile(workspaceRoot, source.path, { allowMissing: true });
      if (role.output_schema.type !== 'object' || role.output_schema.additionalProperties !== false) fail('CONFIG_ERROR', 'Role output schema must be a closed object schema.');
      if (role.blocking_field) {
        const property = role.output_schema.properties?.[role.blocking_field];
        if (!role.output_schema.required?.includes(role.blocking_field) || property?.type !== 'array' || property.items?.type !== 'string') fail('CONFIG_ERROR', 'Blocking field must be a required array of strings in the output schema.');
      }
      try {
        const validator = ajv.compile(role.output_schema);
        if (validator.$async) fail('CONFIG_ERROR', 'Async output schemas are unsupported.');
        validators.set(role.id, validator);
      } catch { fail('CONFIG_ERROR', 'Role output schema could not be compiled; use synchronous JSON Schema 2020-12 without external references.'); }
      roles.set(role.id, role);
    }
    for (const role of roles.values()) {
      if (role.input && !roles.has(role.input.from_role)) fail('CONFIG_ERROR', 'Input references an unknown role.');
      if (new Set(role.consumers.map((c) => c.role)).size !== role.consumers.length) fail('CONFIG_ERROR', 'Consumers must be unique.');
      for (const consumer of role.consumers) {
        const next = roles.get(consumer.role);
        if (next?.input?.from_role !== role.id) fail('CONFIG_ERROR', 'Consumer must declare the matching producer as its input.');
        const fields = Object.values(consumer.fields);
        if (!fields.length || fields.some((name) => !Object.hasOwn(role.output_schema.properties ?? {}, name) || !role.output_schema.required?.includes(name))) fail('CONFIG_ERROR', 'Consumer mappings must select required output fields.');
        if (role.blocking_field && !fields.includes(role.blocking_field)) fail('CONFIG_ERROR', 'Every consumer must receive the blocking field.');
      }
      if (role.input && !roles.get(role.input.from_role).consumers.some((c) => c.role === role.id)) fail('CONFIG_ERROR', 'Producer must declare the consumer mapping.');
    }
    // This first slice passes artifacts along an acyclic set of responsibilities.
    const visit = (role, chain = new Set()) => {
      if (chain.has(role.id)) fail('CONFIG_ERROR', 'Context responsibility mappings must not contain cycles.');
      for (const consumer of role.consumers) visit(roles.get(consumer.role), new Set([...chain, role.id]));
    };
    for (const role of roles.values()) visit(role);
    for (const role of roles.values()) if (role.architecture && !config.architecture) fail('CONFIG_ERROR', 'A role requests architecture but no declaration path is configured.');
    return { roles, validators, sha256: sha(bytes), architecture: config.architecture };
}

/** Local opt-in responsibility contracts. No inference, source writes or task
 * completion transitions. Both operations share the managed workspace lock;
 * archive publication is immutable. Caller owns cancellation via AbortSignal.
 * Versions describe selected inputs, not the entire repository or test validity.
 */
export class ContextEngine {
  constructor(store, configPath) {
    this.store = store;
    this.records = new ArchiveRecords(store);
    this.configPath = configPath;
    this.changes = null;
  }

  /** MCP and command Hooks use the same coordinator configuration. Hook callers
   * configure this only for an explicitly change-bound session. */
  configureChanges(rules, options = {}) {
    assertContract('RulesConfig', rules);
    if (options.generated !== undefined) {
      if (!Array.isArray(options.generated)) fail('CONFIG_ERROR', 'Generated paths must be a JSON array matching MCP.');
      for (const item of options.generated) assertContract('WorkspaceGlob', item);
    }
    this.changes = new ChangeCoordinator(this, rules, options);
    return this.changes;
  }

  /** Caller owns the lease; never call status() from within a Context lock.
   * Recovery may accept a newer persistent version of the same explicit ID. */
  async inspectChangeLocked(binding, task, targets, { signal, allowVersionRefresh = false } = {}) {
    checkSignal(signal);
    if (!this.changes) fail('CHANGE_UNAVAILABLE', 'Change state requires the same validation and architecture configuration as MCP.');
    const inspected = await this.changes.inspectLocked({ targets, signal });
    if (!inspected || inspected.record.id !== binding.id) fail('CHANGE_NOT_CURRENT', 'The explicitly bound change is not current; inspect sol_change_status without transferring this task.');
    if (!allowVersionRefresh && inspected.record.version !== binding.version) fail('CHANGE_VERSION', 'Use the current published change binding from sol_change_status.');
    if (inspected.record.task.id !== task.id || inspected.record.task.goal !== task.goal) fail('TASK_MISMATCH', 'Context identity and goal must match the explicitly bound change.');
    return inspected.projection;
  }

  async initialize() {
    if (isAbsolute(this.configPath)) {
      // Windows TEMP commonly uses an 8.3 alias, while the store uses realpath.
      // Resolve the operator's config alias before checking workspace containment.
      const info = await lstat(this.configPath);
      if (!info.isFile() || info.isSymbolicLink()) fail('CONFIG_ERROR', 'Context configuration must be a regular file.');
      this.configPath = relative(this.store.workspaceRoot, await realpath(resolve(this.configPath))).replaceAll('\\', '/');
    }
    await this.loadConfig();
    return this;
  }

  async loadConfig(signal) { return readContextConfiguration(this.store.workspaceRoot, this.configPath, { signal }); }

  async archive(...args) { return this.records.archive(...args); }
  async stored(...args) { return this.records.stored(...args); }
  async evidence(...args) { return this.records.evidence(...args); }

  async fresh(record, config, signal, seen = new Set()) {
    checkSignal(signal);
    if (record.input_fingerprint_kind !== INPUT_FINGERPRINT_KIND) fail('CONTEXT_STALE', 'Selected source fingerprint policy changed; prepare again.');
    if (record.config_sha !== config.sha256 || record.version !== fingerprint(record)) fail('CONTEXT_STALE', 'Context contract changed or its version is invalid; prepare again.');
    if (record.change_state) {
      let current;
      try { current = await this.inspectChangeLocked(record.change_state.change, record.task, record.targets, { signal }); }
      catch (error) {
        if (!['CHANGE_NOT_CURRENT', 'CHANGE_VERSION', 'TASK_MISMATCH'].includes(error.code)) throw error;
        fail('CONTEXT_STALE', 'The bound change identity, intent or persistent version changed; prepare current responsibility inputs.');
      }
      if (current.version !== record.change_state.version) fail('CONTEXT_STALE', 'Bound change facts or evidence validity changed; prepare again.');
    }
    for (const source of record.sources) {
      if (source.raw) {
        const verified = (await this.evidence([source.raw.handle], signal))[0];
        if (verified.sha256 !== source.raw.sha256 || !verified.complete) fail('REFERENCE_INVALID', 'Selected source archive is invalid.');
      }
      let bytes;
      try { bytes = await readFile(this.store, source.path, FILE_BYTES, signal); }
      catch (error) {
        if (error.code === 'ENOENT' && source.state === 'missing') continue;
        if (error.code === 'INTERRUPTED' || error.code === 'HOST_STATE_ERROR') throw error;
        fail('CONTEXT_STALE', 'A selected source is no longer readable; prepare again.');
      }
      const fact = (await fileFacts(this.store.workspaceRoot, [source.path], { signal })).get(source.path);
      if (source.state !== 'available' || sha(bytes) !== source.sha256 || fact.type !== 'file' || fact.sha256 !== source.sha256 || fact.mode !== source.mode) fail('CONTEXT_STALE', 'Selected source content changed; prepare again.');
    }
    if (record.architecture) {
      if (!config.architecture || record.architecture.path !== config.architecture.path) fail('CONTEXT_STALE', 'Architecture configuration changed.');
      await this.evidence([record.architecture.raw.handle], signal);
      await new ArchitectureIndex(this.store.workspaceRoot, config.architecture.path).fresh(record.architecture.versions, signal);
    }
    if (record.upstream) {
      const upstreamHandle = record.upstream.artifact.handle;
      if (seen.has(upstreamHandle) || seen.size >= 8) fail('REFERENCE_INVALID', 'Context reference chain is cyclic or too deep.');
      seen.add(upstreamHandle);
      const artifact = await this.stored(upstreamHandle, 'sol_context_submit', 'context_artifact', signal);
      await this.evidence(artifact.evidence.map((ref) => ref.handle), signal);
      const previous = await this.stored(artifact.context.handle, 'sol_context_prepare', 'context_record', signal);
      await this.fresh(previous, config, signal, seen);
    }
    checkSignal(signal);
  }

  async prepare(input, { signal } = {}) {
    const args = parse(contextPrepareSchema, input);
    return withWorkspaceLock(this.store, async () => {
      const config = await this.loadConfig(signal);
      const role = config.roles.get(args.role);
      if (!role) fail('ROLE_UNKNOWN', `Select a configured responsibility: ${[...config.roles.keys()].join(', ')}.`);
      const diagnostics = [];
      const changeState = args.change ? await this.inspectChangeLocked(args.change, args.task, args.targets, { signal }) : null;
      if (changeState?.blocking.count) diagnostics.push({ code: 'CHANGE_BLOCKED', blocking: true,
        message: 'Current change has blockers; follow change_state.next and recall change_state.raw for details.' });
      if (changeState?.state === 'abandoned') diagnostics.push({ code: 'CHANGE_ABANDONED', blocking: true, message: 'This change is abandoned; explicitly prepare a new task.' });
      let upstream = null;
      if (args.upstream_handle) {
        const artifact = await this.stored(args.upstream_handle, 'sol_context_submit', 'context_artifact', signal);
        if (JSON.stringify(artifact.task) !== JSON.stringify(args.task)) fail('TASK_MISMATCH', 'Upstream artifact belongs to a different task or goal.');
        const producer = config.roles.get(artifact.role);
        const consumer = producer?.consumers.find((c) => c.role === role.id);
        if (!consumer || role.input?.from_role !== producer.id) fail('CONSUMER_MISMATCH', 'This role cannot consume the supplied artifact.');
        const previous = await this.stored(artifact.context.handle, 'sol_context_prepare', 'context_record', signal);
        await this.fresh(previous, config, signal);
        const evidence = await this.evidence(artifact.evidence.map((ref) => ref.handle), signal);
        const fields = Object.fromEntries(Object.entries(consumer.fields).map(([target, source]) => [target, artifact.output[source]]));
        const blockers = producer.blocking_field ? artifact.output[producer.blocking_field] : [];
        const projection = { fields, evidence, blockers };
        const raw = await this.archive(projection, 'sol_context_handoff', signal);
        upstream = { from_role: producer.id, artifact: (await this.evidence([args.upstream_handle], signal))[0], raw, ...projection };
        if (blockers.length) diagnostics.push({ code: 'UPSTREAM_BLOCKED', blocking: true, message: 'Producer reported unresolved blockers; resolve them before implementation.' });
      } else if (role.input?.required) diagnostics.push({ code: 'UPSTREAM_MISSING', blocking: true, message: 'Supply an accepted artifact from the configured producer.' });
      if (role.require_targets && !args.targets.length) diagnostics.push({ code: 'TARGETS_MISSING', blocking: true, message: 'Locate and supply target paths before preparing this responsibility.' });
      const selected = new Map(role.sources.map((source) => [source.path, source.required]));
      for (const target of args.targets) selected.set(target, true);
      const sources = [];
      for (const [sourcePath, required] of selected) {
        let bytes;
        try { bytes = await readFile(this.store, sourcePath, FILE_BYTES, signal); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          sources.push({ path: sourcePath, required, state: 'missing', sha256: null });
          diagnostics.push({ code: 'SOURCE_MISSING', source: sourcePath, blocking: required, message: 'Selected source is missing.' });
          continue;
        }
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { fail('UNSUPPORTED_ENCODING', 'Context sources must be valid UTF-8.'); }
        const fact = (await fileFacts(this.store.workspaceRoot, [sourcePath], { signal })).get(sourcePath);
        if (fact.type !== 'file' || fact.sha256 !== sha(bytes)) fail('CONTEXT_STALE', 'Source changed while capturing Context; prepare again.');
        const raw = await this.archive(bytes, 'sol_context_source', signal, true);
        const excerpt = prefix(text, 512);
        sources.push({ path: sourcePath, required, state: 'available', sha256: sha(bytes), mode: fact.mode, raw, excerpt, omitted_bytes: bytes.length - Buffer.byteLength(excerpt) });
      }
      let architecture;
      if (role.architecture) {
        const index = new ArchitectureIndex(this.store.workspaceRoot, config.architecture.path);
        const snapshot = await index.load(signal);
        const query = args.architecture_query ?? '';
        const material = { ...index.select(snapshot, { paths: args.targets, capability: query }), workspace_id: this.store.workspaceId };
        const raw = await this.archive(material, 'sol_architecture_query', signal);
        architecture = { path: config.architecture.path, version: snapshot.version, versions: snapshot.versions, query, status: snapshot.status, raw, material };
        if (snapshot.status === 'blocked') diagnostics.push({ code: 'ARCHITECTURE_BLOCKED', blocking: true, message: 'Architecture declaration or code facts have blockers; recall architecture.raw for diagnostics.' });
      }
      const record = { schema_version: 1, kind: 'context_record', workspace_id: this.store.workspaceId, input_fingerprint_kind: INPUT_FINGERPRINT_KIND, config_sha: config.sha256,
        task: args.task, role: { id: role.id, goal: role.goal, allowed_operations: role.allowed_operations }, targets: args.targets,
        status: diagnostics.some((d) => d.blocking) ? 'blocked' : 'ready', diagnostics, sources, upstream,
        output_schema: role.output_schema, consumers: role.consumers,
        ...(architecture ? { architecture } : {}),
        ...(changeState ? { change_state: changeState } : {}),
        capabilities: { architecture_index: architecture ? architecture.status : 'unavailable', change_state: changeState ? 'bound' : this.changes ? 'not_bound' : 'unavailable', context_isolation: 'same_thread' } };
      record.version = fingerprint(record);
      await this.fresh(record, await this.loadConfig(signal), signal);
      const raw = await this.archive(record, 'sol_context_prepare', signal);
      checkSignal(signal);
      const packet = { ...record, kind: 'context', raw, delivery: 'full', omitted: [] };
      if (packet.architecture) { packet.architecture = { ...packet.architecture }; delete packet.architecture.versions; packet.omitted.push('architecture.versions: recall raw'); }
      // Remove only expandable material. Task constraints, versions, diagnostics
      // and upstream blockers remain intact; refuse if those alone exceed budget.
      const drops = [
        () => { if (packet.architecture?.material) { delete packet.architecture.material; packet.omitted.push('architecture.material: recall architecture.raw'); } },
        ...packet.sources.map((source, index) => () => { if (source.excerpt !== undefined) { packet.sources[index] = { ...source }; delete packet.sources[index].excerpt; packet.omitted.push(`sources[${index}].excerpt`); } }),
        () => { if (packet.upstream) { packet.upstream = { ...packet.upstream }; delete packet.upstream.fields; delete packet.upstream.evidence; packet.omitted.push('upstream.fields/evidence: recall upstream.raw'); } },
        () => { delete packet.output_schema; packet.omitted.push('output_schema: recall raw'); },
        () => { delete packet.consumers; packet.omitted.push('consumers: recall raw'); },
        () => { packet.omitted_source_count = packet.sources.length; packet.sources = []; packet.omitted.push('sources: recall raw'); },
      ];
      for (const drop of drops) { if (jsonBytes(packet).length <= PACKET_BYTES) break; drop(); }
      if (jsonBytes(packet).length > PACKET_BYTES) fail('CONTEXT_BUDGET', 'Required context exceeds 4096 bytes; narrow the task, constraints or source selection.');
      return packet;
    }, { signal });
  }

  async architectureQuery(input, { signal } = {}) {
    const args = parse(architectureQuerySchema, input);
    return withWorkspaceLock(this.store, async () => {
      const config = await this.loadConfig(signal);
      if (!config.architecture) fail('ARCHITECTURE_UNAVAILABLE', 'Architecture is not configured.');
      const index = new ArchitectureIndex(this.store.workspaceRoot, config.architecture.path);
      const snapshot = await index.load(signal);
      const material = { ...index.select(snapshot, args), workspace_id: this.store.workspaceId };
      const raw = await this.archive(material, 'sol_architecture_query', signal);
      const packet = { ...material, raw, omitted: [] };
      for (const field of ['candidates', 'impact', 'declared_impact', 'owners', 'uncovered', 'diagnostics']) {
        if (jsonBytes(packet).length <= PACKET_BYTES) break;
        packet[`${field}_count`] = packet[field].length; delete packet[field]; packet.omitted.push(`${field}: recall raw`);
      }
      if (jsonBytes(packet).length > PACKET_BYTES) fail('CONTEXT_BUDGET', 'Architecture query exceeds the packet budget.');
      return packet;
    }, { signal });
  }

  async submit(input, { signal } = {}) {
    const args = parse(contextSubmitSchema, input);
    if (jsonBytes(args).length > 64 * 1024) fail('INPUT_LIMIT', 'Context submission exceeds 64 KiB.');
    return withWorkspaceLock(this.store, async () => {
      const config = await this.loadConfig(signal);
      const record = await this.stored(args.context_handle, 'sol_context_prepare', 'context_record', signal);
      if (record.task.id !== args.task_id || record.role.id !== args.role) fail('TASK_MISMATCH', 'Submission does not match the prepared task and responsibility.');
      if (record.version !== args.version) fail('CONTEXT_STALE', 'Submission must use the prepared context version.');
      await this.fresh(record, config, signal);
      if (record.status !== 'ready') fail('CONTEXT_BLOCKED', 'Resolve missing prerequisites and prepare again before submitting.');
      const validator = config.validators.get(args.role);
      if (!validator || !validator(args.output)) fail('OUTPUT_INVALID', 'Output does not match the prepared responsibility schema.', (validator?.errors ?? []).slice(0, 8).map((e) => ({ path: e.instancePath.slice(0, 160), keyword: e.keyword, message: e.message })));
      const evidence = await this.evidence(args.evidence_handles, signal);
      const context = (await this.evidence([args.context_handle], signal))[0];
      const role = config.roles.get(args.role);
      const artifact = { schema_version: 1, kind: 'context_artifact', workspace_id: this.store.workspaceId,
        task: record.task, role: args.role, context, context_version: record.version,
        output: args.output, evidence, blocked: role.blocking_field ? args.output[role.blocking_field].length > 0 : false };
      artifact.version = sha(jsonBytes(artifact));
      await this.fresh(record, await this.loadConfig(signal), signal);
      const raw = await this.archive(artifact, 'sol_context_submit', signal);
      checkSignal(signal);
      return { schema_version: 1, kind: 'artifact_receipt', accepted: true, task_complete: false,
        task_id: record.task.id, role: args.role, version: artifact.version, raw, blocked: artifact.blocked, evidence_count: evidence.length };
    }, { signal });
  }
}

export function contextError(error) {
  const storageFailure = ['IO_ERROR', 'STORAGE_ERROR'].includes(error.code);
  return { tool_status: 'error', error: { code: error instanceof SolFault ? error.code : 'IO_ERROR',
    message: storageFailure ? 'Context I/O failed; inspect local runtime storage, free space and source availability.' : error instanceof SolFault ? error.message : 'Context operation failed; inspect local configuration and source availability.',
    retryable: error instanceof SolFault ? error.retryable : false,
    ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) } };
}
