import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { assertContract } from '../schema.mjs';
import { interruptionFault, readRawSlice, SolFault } from '../store.mjs';
import { isGeneratedPath, receiptSummary, snapshotInputs, ValidationEngine } from '../validation.mjs';
import { fileFacts, INPUT_FINGERPRINT_KIND, readWorkspaceBytes, workspaceFile, writeAtomicJSON } from '../workspace.mjs';
import { withWorkspaceLock } from '../workspace-lock.mjs';
import { publicError } from '../managed-command.mjs';
import { ArchitectureIndex } from './index.mjs';
import { ArchiveRecords } from '../records.mjs';
import { parseWorkspaceSnapshot } from '../workspace-snapshot.mjs';

export const REVIEW_POLICY_ID = 'change-review-v1';

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const handle = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u);
const uid = z.string().regex(/^[a-f0-9]{8}$/u);
const text = z.string().trim().min(1).max(768);
export const changeBindingSchema = z.object({ id: z.string().uuid(), version: digest }).strict();
export const changeOpenSchema = z.object({
  change: changeBindingSchema.optional(),
  task: z.object({ id: z.string().min(1).max(128), goal: text }).strict(),
  requirement_ref: text,
  scope: z.array(z.object({ path: z.string().min(1).max(256), module_uid: uid }).strict()).min(1).max(50),
  acceptance: z.array(text).min(1).max(12),
  expected_architecture_version: digest,
  reuse: z.object({ decision: z.enum(['reuse', 'extend', 'new', 'not_applicable']), reason: text,
    query_handle: handle, capability: z.object({ uid, symbol: z.string().min(1).max(256) }).strict().optional() }).strict(),
}).strict();
const evidenceHandles = z.array(handle).min(1).max(16);
const unresolved = z.array(text).max(16);
const reviewOutputSchema = z.object({
  method: z.enum(['self_review', 'separate_review']),
  modules: z.array(z.object({ uid, disposition: z.enum(['preserved', 'changed', 'removed']),
    contract_refs: evidenceHandles, evidence_handles: evidenceHandles, rationale: text, unresolved }).strict()).max(100),
  acceptance: z.array(z.object({ index: z.number().int().nonnegative(), evidence_handles: evidenceHandles,
    check_ids: z.array(z.string().min(1).max(4096)).max(128), rationale: text, unresolved }).strict()).min(1).max(12),
  uncovered: z.array(z.object({ index: z.number().int().nonnegative(), evidence_handles: evidenceHandles,
    rationale: text, unresolved }).strict()).max(512),
  checks_not_applicable: z.array(z.object({ path: z.string().min(1).max(256), evidence_handles: evidenceHandles, rationale: text }).strict()).max(50).optional(),
  unresolved,
}).strict();
export const changeReviewSchema = z.discriminatedUnion('phase', [
  z.object({ change: changeBindingSchema, phase: z.literal('prepare') }).strict(),
  z.object({ change: changeBindingSchema, phase: z.literal('submit'), review_context_handle: handle, review: reviewOutputSchema }).strict(),
]);
export const changeCompleteSchema = z.object({ change: changeBindingSchema, review_handle: handle }).strict();
const rawRef = z.custom((value) => { try { assertContract('RawRef', value); return true; } catch { return false; } });
const pointerSchema = z.object({ schema_version: z.literal(1), workspace_id: z.string(), change: changeBindingSchema, record: rawRef }).strict();
const operationPointerSchema = z.object({ schema_version: z.literal(1), workspace_id: z.string(),
  change: changeBindingSchema, operation_id: z.string().uuid(), outcome: rawRef }).strict();
const operationOutcomeSchema = z.object({ schema_version: z.literal(1), kind: z.literal('change_operation_outcome'),
  workspace_id: z.string(), change: changeBindingSchema, operation_id: z.string().uuid(),
  outcome: z.record(z.string(), z.unknown()), evidence_refs: z.array(rawRef).max(1024) }).strict();
const snapshotSchema = z.custom((value) => { try { parseWorkspaceSnapshot(value); return true; } catch { return false; } });
const recordSchema = z.object({ schema_version: z.literal(1), kind: z.literal('change_record'), workspace_id: z.string(),
  id: z.string().uuid(), version: digest, state: z.enum(['open', 'dirty', 'checking', 'completed', 'interrupted', 'abandoned']),
  task: changeOpenSchema.shape.task, requirement_ref: text, scope: changeOpenSchema.shape.scope, acceptance: changeOpenSchema.shape.acceptance,
  reuse: changeOpenSchema.shape.reuse, architecture_version: digest, context_config_sha: digest, rules_sha: digest,
  observed: snapshotSchema, accumulated_paths: z.array(z.string()), blockers: z.array(z.object({ code: z.string(), paths: z.array(z.string()) }).strict()),
  evidence_generation: z.number().int().nonnegative(), latest_validation: z.record(z.string(), z.unknown()).nullable(),
  pending: z.object({ operation_id: z.string().uuid(), paths: z.array(z.string()), kind: z.enum(['write', 'completion']).optional(), starting_binding: changeBindingSchema.optional() }).strict().nullable(),
  baseline_architecture_ref: rawRef.optional(), review_ref: rawRef.nullable().optional(), completion_ref: rawRef.nullable().optional(),
  input_fingerprint_kind: z.literal(INPUT_FINGERPRINT_KIND).optional(), review_policy_id: z.string().min(1).max(128).optional(),
  operation_ref: rawRef.nullable().optional(), recovery: z.object({ operation_id: z.string().uuid(), status: z.enum(['known', 'unknown']), outcome_ref: rawRef.nullable() }).strict().optional(),
  previous_handle: handle.nullable(), updated_at: z.string(), abandonment_reason: text.optional(),
}).strict().superRefine((record, ctx) => {
  const modern = record.observed?.fingerprint_kind === INPUT_FINGERPRINT_KIND;
  if (modern !== (record.input_fingerprint_kind === INPUT_FINGERPRINT_KIND) || modern !== !!record.review_policy_id
    || (!modern && ['operation_ref', 'recovery'].some((field) => Object.hasOwn(record, field))))
    ctx.addIssue({ code: 'custom', message: 'Change record fingerprint policy is inconsistent.' });
});
const referenceValidity = z.enum(['absent', 'current', 'stale']);
// A bounded immutable view, never a second mutable task record. The binding is
// always the published version, even when the observed facts require refresh.
const projectionSchema = z.object({ availability: z.literal('bound'), change: changeBindingSchema,
  task_id: z.string(), state: z.enum(['open', 'dirty', 'checking', 'completed', 'interrupted', 'abandoned']), scope_count: z.number().int().nonnegative(),
  selected_scope: z.array(z.object({ path: z.string(), in_scope: z.boolean(), module_uid: uid.optional() }).strict()),
  blocking: z.object({ count: z.number().int().nonnegative(), codes: z.array(z.string()) }).strict(),
  latest_validation: z.object({ status: z.string(), event_id: z.string().optional(), evidence_handle: handle.nullable().optional(),
    interpretation: z.literal('historical_only') }).strict().nullable(),
  review: z.object({ ref: rawRef.nullable(), validity: referenceValidity }).strict(),
  completion: z.object({ ref: rawRef.nullable(), validity: referenceValidity }).strict(),
  raw: rawRef, needs_status_refresh: z.boolean(), task_complete: z.boolean(), next: z.string(), version: digest,
}).strict();
const fault = (code, message) => { throw new SolFault(code, message); };
const check = (signal) => { if (signal?.aborted) throw interruptionFault(signal, 'Change coordination was interrupted.'); };
const conditions = () => sha({ node: process.version, platform: process.platform, arch: process.arch,
  environment: Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)) });
const sameRefs = (actual, expected) => Object.keys(expected).every((field) => actual[field] === expected[field]);
const difference = (before, after) => {
  const a = new Map(before.items.map((item) => [key(item.path), item]));
  const b = new Map(after.items.map((item) => [key(item.path), item]));
  return [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path)?.type !== b.get(path)?.type || a.get(path)?.sha256 !== b.get(path)?.sha256
      || (before.fingerprint_kind === after.fingerprint_kind && a.get(path)?.mode !== b.get(path)?.mode))
    .map((path) => (b.get(path) ?? a.get(path)).path).sort();
};

/** One explicitly bound writable change per workspace. Mutable pointer -> immutable
 * record archive; all operations share the existing workspace lease. A pending
 * operation is published before writing and recovered as interrupted, never replayed.
 * Review records attest a model's version-bound judgment, not a semantic proof.
 * Completion requires cumulative checks and a stable, durably published basis.
 */
export class ChangeCoordinator {
  constructor(dependencies, rules, { generated = [], validator, rulesPath, requireRecordedConfig = false, reviewPolicyId = REVIEW_POLICY_ID } = {}) {
    this.store = dependencies.store; this.records = dependencies.records ?? new ArchiveRecords(this.store);
    this.loadConfig = dependencies.loadConfig.bind(dependencies);
    // Compatibility alias for existing archive fault-injection callers.
    this.engine = this.records; this.generated = generated; this.reviewPolicyId = z.string().trim().min(1).max(128).parse(reviewPolicyId);
    this.validator = validator ?? new ValidationEngine(this.store, rules, { generated });
    this.rules = rules; this.rulesPath = rulesPath;
    this.requireRecordedConfig = requireRecordedConfig;
    this.rulesSha = sha({ rules, generated }); this.directory = join(this.store.solRoot, 'architecture');
    this.pointer = join(this.directory, 'active-change.json');
  }

  async storage(create = false) {
    for (const path of [join(this.store.workspaceRoot, '.codex'), this.store.solRoot]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) fault('CHANGE_STORAGE', 'Change storage is not a regular private directory.');
    }
    if (create) await mkdir(this.directory, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(this.directory).catch((error) => { if (error.code === 'ENOENT' && !create) return null; throw error; });
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink()) fault('CHANGE_STORAGE', 'Change storage is not a regular private directory.');
    return true;
  }

  async read({ signal } = {}) {
    check(signal);
    let file;
    try {
      if (!await this.storage()) return null;
      const info = await lstat(this.pointer).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) return null;
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2048) fault('CHANGE_CORRUPT', 'Current change pointer is invalid.');
      file = await open(this.pointer, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const size = (await file.stat()).size;
      if (size > 2048) fault('CHANGE_CORRUPT', 'Current change pointer exceeds its bound.');
      const pointer = pointerSchema.parse(JSON.parse((await readRawSlice(file, 0, size)).toString('utf8')));
      if (pointer.workspace_id !== this.store.workspaceId) fault('CHANGE_CORRUPT', 'Change belongs to a different workspace.');
      const original = await this.records.stored(pointer.record, 'sol_change_record', 'change_record', signal);
      const { version, ...body } = original;
      if (sha(body) !== version || pointer.change.id !== original.id || pointer.change.version !== version) fault('CHANGE_CORRUPT', 'Change identity or version is invalid.');
      const record = recordSchema.parse(original);
      return { record, raw: pointer.record };
    } catch (error) {
      check(signal);
      if (error instanceof SolFault) throw error;
      fault('CHANGE_CORRUPT', 'Current change record could not be verified; inspect storage before continuing.');
    } finally { await file?.close(); }
  }

  async publish(record, previous = null, { beforePublish } = {}) {
    await this.storage(true);
    const info = await lstat(this.pointer).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink())) fault('CHANGE_STORAGE', 'Current change pointer is not a regular file.');
    const { version: ignored, ...body } = record;
    const value = { ...body, previous_handle: previous?.handle ?? null, updated_at: new Date().toISOString() };
    value.version = sha(value);
    recordSchema.parse(value);
    // Archive first: an I/O failure never publishes a pointer to partial evidence.
    const raw = await this.records.archive(value, 'sol_change_record');
    await writeAtomicJSON(this.pointer, { schema_version: 1, workspace_id: this.store.workspaceId,
      change: { id: value.id, version: value.version }, record: raw }, { beforePublish });
    return { record: value, raw };
  }

  packet(current, details = {}) {
    if (!current) return { schema_version: 1, kind: 'change_status', state: 'none', task_complete: false };
    const { record, raw } = current;
    const result = { schema_version: 1, kind: 'change_status', change: { id: record.id, version: record.version },
      task_id: record.task.id, state: record.state, task_complete: record.state === 'completed' && !!record.completion_ref, raw, scope_count: record.scope.length,
      accumulated_path_count: record.accumulated_paths.length, evidence_generation: record.evidence_generation,
      validation_status: record.latest_validation?.status ?? null, blockers: record.blockers,
      next: record.state === 'interrupted' ? 'Inspect actual changes and explicitly call sol_change_resume; never replay the prior write automatically.' :
        record.state === 'abandoned' ? 'History and source changes remain; a new change can be opened.' :
        record.state === 'completed' ? 'Completion evidence is published. Query current capabilities before opening the next change.' :
        'Bind writes with change.id and change.version. Maintain the declaration through bound writes, then sol_change_review prepare/submit and sol_change_complete.', ...details };
    if (record.review_ref) result.review = record.review_ref;
    if (record.completion_ref) result.completion = record.completion_ref;
    if (Buffer.byteLength(JSON.stringify(result)) > 4096) {
      result.blocker_count = record.blockers.length;
      result.blockers = [...new Set(record.blockers.map((b) => b.code))].map((code) => ({ code }));
      result.omitted = ['blocker paths: recall raw'];
      if (result.completion_blockers) {
        result.completion_blocker_count = result.completion_blockers.length;
        result.completion_blockers = [...new Set(result.completion_blockers.map((b) => b.code))].map((code) => ({ code }));
        result.omitted.push('completion blocker paths: recall review_context_handle');
      }
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 4096) fault('CHANGE_BUDGET', 'Change status exceeds the output budget.');
    return result;
  }

  async snapshot(signal) {
    check(signal);
    const value = await snapshotInputs(this.store.workspaceRoot, ['**/*'], this.generated, [], { signal });
    check(signal);
    if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) fault('CHANGE_INPUT_LIMIT', 'Change inputs exceed 128 KiB of metadata; configure generated exclusions before opening a change.');
    return value;
  }

  async verified(ref, tool, kind, signal) {
    return this.records.stored(ref, tool, kind, signal);
  }

  async currentRules(signal) {
    check(signal);
    if (!this.rulesPath) return;
    let file;
    try {
      const info = await lstat(this.rulesPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) fault('CHANGE_RULES_CHANGED', 'Rules are unavailable or invalid; restart this MCP server with the current configuration.');
      file = await open(this.rulesPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const size = (await file.stat()).size;
      if (size > 256 * 1024) fault('CHANGE_RULES_CHANGED', 'Rules exceed their bound.');
      const rules = JSON.parse((await readRawSlice(file, 0, size)).toString('utf8'));
      check(signal);
      assertContract('RulesConfig', rules);
      if (sha({ rules, generated: this.generated }) !== this.rulesSha) fault('CHANGE_RULES_CHANGED', 'Validation rules changed; restart this MCP server before adjusting or completing the change.');
    } catch (error) {
      check(signal);
      if (error instanceof SolFault) throw error;
      fault('CHANGE_RULES_CHANGED', 'Validation rules could not be verified; restart with a valid configuration.');
    } finally { await file?.close(); }
  }

  async captureSources(paths, observed, signal) {
    const items = new Map(observed.items.map((item) => [key(item.path), item]));
    const sources = [];
    for (const path of [...new Set(paths)].sort()) {
      check(signal);
      const item = items.get(key(path));
      if (!item || item.type === 'missing') { sources.push({ path, state: 'missing' }); continue; }
      const bytes = await readWorkspaceBytes(this.store.workspaceRoot, path, 1024 * 1024, { signal });
      const fact = (await fileFacts(this.store.workspaceRoot, [path], { signal })).get(path);
      if (createHash('sha256').update(bytes).digest('hex') !== item.sha256 || fact.type !== 'file' || fact.sha256 !== item.sha256 || fact.mode !== item.mode) fault('CHANGE_REVIEW_STALE', 'Source changed while capturing review evidence; prepare again.');
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { fault('UNSUPPORTED_ENCODING', 'Review source evidence must be UTF-8 text in this JavaScript slice.'); }
      sources.push({ path, state: 'file', sha256: item.sha256, mode: item.mode, raw: await this.records.archive(bytes, 'sol_change_source', signal, true) });
    }
    return sources;
  }

  async completionValid(record, config, signal) {
    check(signal);
    if (!record.completion_ref) fault('CHANGE_COMPLETION_INVALID', 'Completed state has no completion evidence.');
    const completed = await this.verified(record.completion_ref, 'sol_change_completion', 'change_completion', signal);
    const basis = completed.basis;
    if (!basis || completed.change_id !== record.id || completed.basis_version !== sha(basis)
      || basis.observed_sha !== record.observed.sha256 || basis.scope_sha !== sha(record.scope)
      || basis.intent_sha !== sha({ task: record.task, requirement_ref: record.requirement_ref, acceptance: record.acceptance, reuse: record.reuse })
      || record.review_policy_id !== this.reviewPolicyId || basis.review_policy_id !== this.reviewPolicyId
      || basis.input_fingerprint_kind !== INPUT_FINGERPRINT_KIND || record.input_fingerprint_kind !== INPUT_FINGERPRINT_KIND
      || basis.context_config_sha !== config.sha256 || basis.rules_sha !== this.rulesSha
      || completed.conditions_sha !== conditions() || !Array.isArray(completed.evidence_refs)
      || completed.review_ref?.handle !== record.review_ref?.handle) fault('CHANGE_COMPLETION_INVALID', 'Completion evidence does not describe the current task and inputs.');
    const review = await this.verified(completed.review_ref, 'sol_change_review', 'change_review', signal);
    if (review.change_id !== record.id || review.review_policy_id !== this.reviewPolicyId || review.basis_version !== completed.basis_version || review.unresolved.length) fault('CHANGE_COMPLETION_INVALID', 'Completion review is missing, stale or unresolved.');
    const prepared = await this.records.stored(review.context_handle, 'sol_change_review_context', 'change_review_context', signal);
    if (prepared.change_id !== record.id || prepared.version !== sha(prepared.basis) || prepared.version !== completed.basis_version)
      fault('CHANGE_COMPLETION_INVALID', 'Completion review material is missing or belongs to another basis.');
    for (const ref of completed.evidence_refs) {
      const [actual] = await this.records.evidence([ref.handle], signal);
      if (!actual.complete || !sameRefs(actual, ref)) fault('CHANGE_COMPLETION_INVALID', 'Completion evidence is unavailable or incomplete.');
    }
    if (!Array.isArray(completed.rule_evidence)) fault('CHANGE_COMPLETION_INVALID', 'Completion lacks its cumulative check evidence.');
    for (const rule of completed.rule_evidence) {
      check(signal);
      const { value: receipt } = await this.store.readVerifiedJSON(rule.receipt_ref.handle, { maxBytes: 128 * 1024, signal,
        validateMeta: (meta) => { if (meta.tool !== 'validation_receipt' || !sameRefs({ ...meta, handle: rule.receipt_ref.handle }, rule.receipt_ref)) fault('REFERENCE_INVALID', 'Validation receipt identity is invalid.'); } });
      const fresh = await this.validator.freshness(receipt, [rule.id], { signal });
      if (!fresh.valid_rule_ids.includes(rule.id)) {
        if (fresh.diagnostics.some((d) => d.reason === 'runtime_conditions_unverified'))
          fault('CHANGE_COMPLETION_INVALID', 'Check executable identity cannot be verified. Configure an actual absolute executable path, restart this MCP server, adjust the change and prepare a new review.');
        fault('CHANGE_COMPLETION_INVALID', 'Required check inputs, evidence or execution conditions changed; prepare a current review and retry completion.');
      }
    }
    if (!config.architecture) fault('ARCHITECTURE_UNAVAILABLE', 'Architecture is not configured.');
    await new ArchitectureIndex(this.store.workspaceRoot, config.architecture.path).fresh(completed.architecture_versions, signal);
    check(signal);
  }

  async assessLocked(current, { signal } = {}) {
    check(signal);
    if (!current) return null;
    const record = current.record;
    if (this.requireRecordedConfig && this.rulesSha !== record.rules_sha)
      fault('CHANGE_UNAVAILABLE', 'Hook validation rules or generated exclusions differ from the recorded MCP configuration; inspect configuration through MCP.');
    if (record.state === 'abandoned') return { observed: record.observed, paths: [], configChanged: false,
      completionInvalid: false, reviewValidity: record.review_ref ? 'stale' : 'absent', completionValidity: record.completion_ref ? 'stale' : 'absent',
      needsRefresh: false, state: 'abandoned', blockers: record.blockers };
    await this.currentRules(signal);
    const observed = await this.snapshot(signal);
    const paths = difference(record.observed, observed);
    const config = await this.loadConfig(signal);
    const configChanged = config.sha256 !== record.context_config_sha || this.rulesSha !== record.rules_sha;
    const policyChanged = record.review_policy_id !== this.reviewPolicyId || record.input_fingerprint_kind !== INPUT_FINGERPRINT_KIND;
    let completionInvalid = false;
    let completionValidity = record.completion_ref ? 'stale' : 'absent';
    if (record.state === 'completed' && !paths.length && !configChanged && !policyChanged) {
      try { await this.completionValid(record, config, signal); completionValidity = 'current'; }
      catch (error) {
        check(signal);
        if (!(error instanceof SolFault) || ['INTERRUPTED', 'HOST_STATE_ERROR'].includes(error.code)) throw error;
        completionInvalid = true;
      }
    }
    let reviewValidity = record.review_ref ? 'stale' : 'absent';
    if (record.review_ref && !paths.length && !configChanged && !policyChanged && !record.pending && record.state !== 'checking') {
      try {
        const review = await this.verified(record.review_ref, 'sol_change_review', 'change_review', signal);
        const inputs = await this.reviewInputs(current, signal);
        const prepared = await this.records.stored(review.context_handle, 'sol_change_review_context', 'change_review_context', signal);
        if (review.change_id === record.id && review.review_policy_id === this.reviewPolicyId && review.basis_version === inputs.version && prepared.version === inputs.version
          && prepared.version === sha(prepared.basis) && prepared.change_id === record.id && !review.unresolved.length && !inputs.blockers.length) {
          for (const ref of review.evidence_refs) await this.verifiedSource(ref, signal);
          reviewValidity = 'current';
        }
      } catch (error) {
        check(signal);
        if (!(error instanceof SolFault) || ['INTERRUPTED', 'HOST_STATE_ERROR'].includes(error.code)) throw error;
      }
    }
    const recoveredOperation = record.pending ? await this.recoverOperation(record, signal) : null;
    const pendingChanged = record.pending && (record.state !== 'interrupted' || !record.recovery
      || record.recovery.status !== recoveredOperation.status || record.recovery.outcome_ref?.handle !== recoveredOperation.outcome_ref?.handle);
    const needsRefresh = !!(paths.length || pendingChanged
      || record.state === 'checking' || configChanged || policyChanged || completionInvalid);
    const scope = new Set(record.scope.map((item) => key(item.path)));
    const outside = paths.filter((path) => !scope.has(key(path)));
    const blockers = [...record.blockers];
    if (outside.length) blockers.push({ code: 'CHANGE_OUTSIDE_SCOPE', paths: outside });
    if (configChanged && !blockers.some((b) => b.code === 'CHANGE_CONFIG_CHANGED')) blockers.push({ code: 'CHANGE_CONFIG_CHANGED', paths: [] });
    if (completionInvalid) blockers.push({ code: 'CHANGE_COMPLETION_INVALID', paths: [] });
    check(signal);
    return { observed, paths, configChanged, policyChanged, completionInvalid, reviewValidity, completionValidity, needsRefresh, blockers, recoveredOperation,
      state: needsRefresh ? record.pending || ['interrupted', 'checking'].includes(record.state) ? 'interrupted' : 'dirty' : record.state };
  }

  async verifiedSource(ref, signal) {
    const [actual] = await this.records.evidence([ref.handle], signal);
    if (!actual.complete || !sameRefs(actual, ref)) fault('REFERENCE_INVALID', 'Review evidence is unavailable or incomplete.');
  }

  /** Caller owns the workspace lease. No lock acquisition, archive, pointer
   * publication, check runner or recovery action is performed here. */
  async inspectLocked({ targets = [], signal } = {}) {
    const current = await this.read({ signal });
    const facts = await this.assessLocked(current, { signal });
    if (!current) return null;
    const { record, raw } = current;
    const blockers = [...facts.blockers];
    if (facts.needsRefresh) blockers.push({ code: 'CHANGE_STATUS_REFRESH', paths: [] });
    if (facts.state === 'interrupted') blockers.push({ code: 'CHANGE_INTERRUPTED', paths: [] });
    if (record.review_ref && facts.reviewValidity === 'stale') blockers.push({ code: 'CHANGE_REVIEW_STALE', paths: [] });
    const taskComplete = facts.state === 'completed' && facts.completionValidity === 'current';
    const projection = { availability: 'bound', change: { id: record.id, version: record.version }, task_id: record.task.id,
      state: facts.state, scope_count: record.scope.length,
      selected_scope: targets.map((path) => {
        const match = record.scope.find((item) => key(item.path) === key(path));
        return { path, in_scope: !!match, ...(match ? { module_uid: match.module_uid } : {}) };
      }),
      blocking: { count: blockers.length, codes: [...new Set(blockers.map((b) => b.code))].sort() },
      latest_validation: record.latest_validation ? { status: record.latest_validation.status,
        ...(record.latest_validation.event_id ? { event_id: record.latest_validation.event_id } : {}),
        ...(record.latest_validation.evidence_handle !== undefined ? { evidence_handle: record.latest_validation.evidence_handle } : {}), interpretation: 'historical_only' } : null,
      review: { ref: record.review_ref ?? null, validity: facts.reviewValidity },
      completion: { ref: record.completion_ref ?? null, validity: facts.completionValidity }, raw,
      needs_status_refresh: facts.needsRefresh, task_complete: taskComplete,
      next: facts.needsRefresh ? 'Call sol_change_status for a published binding before continuing; inspect actual effects and explicitly resume interruptions.' :
        facts.state === 'interrupted' ? 'Inspect actual effects and call sol_change_resume with the current binding; do not replay the interrupted operation.' :
        facts.state === 'abandoned' ? 'This change is abandoned. Query capabilities and explicitly open a new task.' :
        taskComplete ? 'Current completion evidence is valid. Report completion; query capabilities before opening the next task.' :
        facts.reviewValidity === 'current' ? 'Follow this responsibility\'s permitted operations. Continue bound edits if needed, or call sol_change_complete with the current binding and review.ref.handle.' :
        'Follow this responsibility\'s output contract before writes. Continue permitted bound edits, or call sol_change_review prepare, maintain declarations and submit a current review before completion.',
    };
    projection.version = sha({ projection, observed_sha: facts.observed.sha256 });
    projectionSchema.parse(projection);
    if (Buffer.byteLength(JSON.stringify(projection)) > 4096) fault('CONTEXT_BUDGET', 'Required change projection exceeds the Context budget; narrow selected targets.');
    return { record, projection };
  }

  async refresh(current, { signal } = {}) {
    const facts = await this.assessLocked(current, { signal });
    if (!facts?.needsRefresh) return current;
    const { record } = current;
    const { observed, blockers, paths } = facts;
    const operation = facts.recoveredOperation ?? null;
    return this.publish({ ...record, state: facts.state,
      observed, pending: operation?.status === 'unknown' ? record.pending : null,
      input_fingerprint_kind: INPUT_FINGERPRINT_KIND, review_policy_id: this.reviewPolicyId,
      ...(operation ? { recovery: operation, operation_ref: operation.outcome_ref } : {}),
      evidence_generation: record.evidence_generation + 1, latest_validation: null, blockers, review_ref: null, completion_ref: null,
      accumulated_paths: [...new Set([...record.accumulated_paths, ...paths])].sort() }, current.raw);
  }

  async operationDirectory(create = false) {
    await this.storage(create);
    const directory = join(this.directory, 'operations');
    if (create) await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(directory).catch((error) => { if (error.code === 'ENOENT' && !create) return null; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) fault('CHANGE_STORAGE', 'Operation references require a regular private directory.');
    return info ? directory : null;
  }

  /** This evidence pointer has no authority to change the active task. */
  async publishOperation(startingBinding, operationId, outcome, signal) {
    check(signal);
    const evidence = new Map();
    const collect = (value, depth = 0) => {
      if (!value || typeof value !== 'object') return;
      if (depth > 32) fault('CHANGE_BUDGET', 'Operation evidence exceeds its nesting limit.');
      try { assertContract('RawRef', value); evidence.set(value.handle, value); return; } catch { /* containers are not refs */ }
      for (const child of Object.values(value)) collect(child, depth + 1);
    };
    collect(outcome);
    // Validation summaries and change events carry handle fields rather than RawRefs.
    for (const name of ['evidence_handle', 'event_handle']) {
      const value = outcome.validation?.[name] ?? outcome[name];
      if (value) { const [ref] = await this.records.evidence([value], signal); evidence.set(value, ref); }
    }
    if (outcome.validation?.evidence_handle) {
      const { value: receipt } = await this.store.readVerifiedJSON(outcome.validation.evidence_handle, { maxBytes: 128 * 1024, signal,
        validateMeta: (meta) => { if (meta.tool !== 'validation_receipt' || !meta.complete) fault('REFERENCE_INVALID', 'Operation validation evidence has the wrong type.'); } });
      assertContract('ValidationReceipt', receipt);
      collect(receipt.checks.flatMap((result) => result.output));
    }
    for (const ref of evidence.values()) await this.verifiedSource(ref, signal);
    const value = operationOutcomeSchema.parse({ schema_version: 1, kind: 'change_operation_outcome',
      workspace_id: this.store.workspaceId, change: startingBinding, operation_id: operationId,
      outcome, evidence_refs: [...evidence.values()] });
    const raw = await this.records.archive(value, 'sol_change_operation_outcome', signal, false, { callId: operationId });
    const directory = await this.operationDirectory(true);
    const path = join(directory, `${operationId}.json`);
    if (await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; }))
      fault('CHANGE_STORAGE', 'Operation outcome was already published.');
    await writeAtomicJSON(path, { schema_version: 1, workspace_id: this.store.workspaceId,
      change: startingBinding, operation_id: operationId, outcome: raw });
    return raw;
  }

  async recoverOperation(record, signal) {
    const pending = record.pending;
    const unknown = { operation_id: pending.operation_id, status: 'unknown', outcome_ref: null };
    // Legacy pending writes have no trustworthy starting binding. Never infer one.
    if (!pending.starting_binding || pending.kind !== 'write') return unknown;
    let file;
    try {
      check(signal);
      const directory = await this.operationDirectory();
      if (!directory) return unknown;
      const path = join(directory, `${pending.operation_id}.json`);
      const info = await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) return unknown;
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2048) fault('CHANGE_CORRUPT', 'Operation pointer is invalid.');
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const size = (await file.stat()).size;
      if (size > 2048) fault('CHANGE_CORRUPT', 'Operation pointer exceeds its bound.');
      const pointer = operationPointerSchema.parse(JSON.parse((await readRawSlice(file, 0, size)).toString('utf8')));
      if (pointer.workspace_id !== this.store.workspaceId || pointer.operation_id !== pending.operation_id
        || pointer.change.id !== record.id || !sameRefs(pointer.change, pending.starting_binding))
        fault('CHANGE_CORRUPT', 'Operation pointer has the wrong workspace, task or starting binding.');
      const outcome = operationOutcomeSchema.parse(await this.verified(pointer.outcome, 'sol_change_operation_outcome', 'change_operation_outcome', signal));
      if (outcome.operation_id !== pending.operation_id || !sameRefs(outcome.change, pointer.change))
        fault('CHANGE_CORRUPT', 'Operation outcome does not match its pointer.');
      for (const ref of outcome.evidence_refs) await this.verifiedSource(ref, signal);
      return { operation_id: pending.operation_id, status: 'known', outcome_ref: pointer.outcome };
    } catch (error) {
      check(signal);
      if (error instanceof SolFault && error.code === 'NOT_FOUND') return unknown;
      if (error instanceof SolFault) throw error;
      fault('CHANGE_CORRUPT', 'Operation outcome could not be verified; the active pointer was preserved.');
    } finally { await file?.close(); }
  }

  bind(current, binding) {
    if (!binding) fault('CHANGE_REQUIRED', 'Architecture mode requires an explicit change binding. Query and open a change first.');
    changeBindingSchema.parse(binding);
    if (!current || current.record.id !== binding.id) fault('CHANGE_NOT_CURRENT', 'Change is not the current workspace change; inspect sol_change_status.');
    if (current.record.version !== binding.version) fault('CHANGE_VERSION', 'Change version changed; inspect sol_change_status before retrying.');
  }

  /** Shared write guard. Caller owns the lease; this does not publish or run checks. */
  async assertWritableLocked(current, binding, paths, { signal } = {}) {
    check(signal); this.bind(current, binding);
    if (!['open', 'dirty'].includes(current.record.state)) fault('CHANGE_STATE', 'Change is not writable; inspect its state and explicitly resume if interrupted.');
    if (current.record.blockers.length) fault('CHANGE_BLOCKED', 'Explain accumulated changes by adjusting the change scope before writing.');
    if (!Array.isArray(paths) || !paths.length || paths.length > 50) fault('BAD_ARGUMENTS', 'A managed write requires 1–50 explicit target paths.');
    const scope = new Set(current.record.scope.map((item) => key(item.path)));
    for (const path of paths) {
      check(signal);
      await workspaceFile(this.store.workspaceRoot, path, { allowMissing: true });
      if (!scope.has(key(path))) fault('CHANGE_OUTSIDE_SCOPE', `Write target is outside the registered scope: ${path}`);
    }
    return scope;
  }

  /** Command Hook preflight; the MCP entry repeats the guard under its own lease.
   * A newer session material version is not permission to use an old write binding.
   * Caller owns the lease. No archive, pointer, runner or recovery side effects. */
  async preflightWriteLocked(binding, paths, { task, signal } = {}) {
    const current = await this.read({ signal }); this.bind(current, binding);
    if (!task || current.record.task.id !== task.id || current.record.task.goal !== task.goal)
      fault('TASK_MISMATCH', 'The write must belong to the session’s explicitly prepared identity and goal.');
    const facts = await this.assessLocked(current, { signal });
    if (facts.needsRefresh) fault('CHANGE_STATUS_REFRESH', 'Call sol_change_status to inspect actual effects and obtain the current published binding before writing.');
    await this.assertWritableLocked(current, binding, paths, { signal });
  }

  async open(input, { signal } = {}) {
    const args = changeOpenSchema.parse(input);
    return withWorkspaceLock(this.store, async () => {
      check(signal);
      let current = await this.refresh(await this.read({ signal }), { signal });
      if (args.change) {
        this.bind(current, args.change);
        if (['interrupted', 'abandoned'].includes(current.record.state)) fault('CHANGE_STATE', 'Resume an interrupted change before adjustment; abandoned changes cannot be reopened.');
        if (args.task.id !== current.record.task.id) fault('CHANGE_TASK', 'Scope adjustment must retain the task identity.');
      } else if (current && !['abandoned', 'completed'].includes(current.record.state)) fault('CHANGE_ACTIVE', 'A writable change already exists; adjust it or explicitly abandon it.');
      await this.currentRules();
      const config = await this.loadConfig(signal);
      if (!config.architecture) fault('ARCHITECTURE_UNAVAILABLE', 'Architecture is not configured.');
      const index = new ArchitectureIndex(this.store.workspaceRoot, config.architecture.path);
      const snapshot = await index.load(signal);
      const query = await this.records.stored(args.reuse.query_handle, 'sol_architecture_query', 'architecture_query', signal);
      if (args.expected_architecture_version !== snapshot.version || query.version !== snapshot.version) fault('CHANGE_QUERY_STALE', 'Architecture query is stale; query current ownership and capabilities again.');
      if (snapshot.status !== 'ready') fault('ARCHITECTURE_BLOCKED', 'Resolve architecture diagnostics before opening or expanding a change.');
      if (['reuse', 'extend'].includes(args.reuse.decision) && (!args.reuse.capability || !query.candidates.some((candidate) =>
        candidate.uid === args.reuse.capability.uid && candidate.symbol === args.reuse.capability.symbol && candidate.verification === 'static_export')))
        fault('CHANGE_REUSE', 'Reuse or extension must select a verified candidate from the cited query.');
      const scopeKeys = args.scope.map((item) => key(item.path));
      if (new Set(scopeKeys).size !== scopeKeys.length) fault('CHANGE_SCOPE', 'Scope paths must be unique, including Windows case aliases.');
      for (const item of args.scope) {
        await workspaceFile(this.store.workspaceRoot, item.path, { allowMissing: true });
        if (isGeneratedPath(item.path, this.generated)) fault('CHANGE_SCOPE', 'Generated paths cannot be managed change targets.');
        const module = snapshot.tree.find((m) => m.uid === item.module_uid);
        const owners = snapshot.tree.filter((m) => m.source.some((s) => key(s.path) === key(item.path)));
        if (!module || !['active', 'planned'].includes(module.state) || owners.some((m) => m.uid !== item.module_uid))
          fault('CHANGE_OWNERSHIP', `Scope ownership does not match the architecture declaration: ${item.path}`);
      }
      if (args.change && current.record.accumulated_paths.some((path) => !scopeKeys.includes(key(path))))
        fault('CHANGE_SCOPE', 'Adjusted scope must account for all accumulated changes; history cannot be removed from scope.');
      const observed = await this.snapshot();
      const changeId = args.change ? current.record.id : randomUUID();
      let baseline = args.change ? current.record.baseline_architecture_ref : null;
      if (!args.change) {
        const sources = await this.captureSources([...snapshot.versions.map((v) => v.path), ...args.scope.map((s) => s.path)], observed, signal);
        baseline = await this.records.archive({ schema_version: 1, kind: 'change_baseline', workspace_id: this.store.workspaceId,
          change_id: changeId, architecture: snapshot, observed_sha: observed.sha256, sources }, 'sol_change_baseline', signal);
      }
      await index.fresh(snapshot.versions, signal);
      if ((await this.snapshot()).sha256 !== observed.sha256) fault('CHANGE_REVIEW_STALE', 'Workspace changed during registration; query and register current inputs.');
      if ((await this.loadConfig(signal)).sha256 !== config.sha256) fault('CHANGE_CONFIG_CHANGED', 'Context configuration changed during registration; prepare current inputs again.');
      check(signal);
      const old = args.change ? current.record : null;
      current = await this.publish({ schema_version: 1, kind: 'change_record', workspace_id: this.store.workspaceId,
        id: changeId, state: old ? 'dirty' : 'open', task: args.task, requirement_ref: args.requirement_ref,
        scope: args.scope, acceptance: args.acceptance, reuse: args.reuse, architecture_version: snapshot.version,
        context_config_sha: config.sha256, rules_sha: this.rulesSha, input_fingerprint_kind: INPUT_FINGERPRINT_KIND, review_policy_id: this.reviewPolicyId, observed, accumulated_paths: old?.accumulated_paths ?? [],
        blockers: [], evidence_generation: (old?.evidence_generation ?? -1) + 1, latest_validation: null, pending: null,
        ...(baseline ? { baseline_architecture_ref: baseline } : {}), review_ref: null, completion_ref: null }, current?.raw);
      return this.packet(current);
    }, { signal });
  }

  async status({ signal } = {}) {
    return withWorkspaceLock(this.store, async () => { check(signal); return this.packet(await this.refresh(await this.read({ signal }), { signal })); }, { signal });
  }

  async reviewInputs(current, signal, capture = false) {
    const record = current.record;
    const config = await this.loadConfig(signal);
    if (!config.architecture) fault('ARCHITECTURE_UNAVAILABLE', 'Architecture is not configured.');
    await this.currentRules(signal);
    const observed = await this.snapshot(signal);
    if (observed.sha256 !== record.observed.sha256) fault('CHANGE_REVIEW_STALE', 'Workspace changed; inspect change status and prepare review again.');
    const index = new ArchitectureIndex(this.store.workspaceRoot, config.architecture.path);
    const architecture = await index.load(signal);
    const baseline = record.baseline_architecture_ref ? await this.verified(record.baseline_architecture_ref, 'sol_change_baseline', 'change_baseline', signal) : null;
    if (baseline && baseline.change_id !== record.id) fault('REFERENCE_INVALID', 'Initial architecture belongs to another change.');
    const maintenance = index.maintenance(baseline?.architecture ?? null, architecture, { paths: record.accumulated_paths, scope: record.scope });
    const paths = [...new Set([...record.accumulated_paths, ...maintenance.impact_paths])].sort();
    const plan = this.validator.plan(paths);
    // The declaration has its own version-bound Normify/source/policy checks.
    // watch_paths are input dependencies, never proof that a rule covers a path.
    const noChecks = plan.uncovered_paths.filter((path) => key(path) !== key(config.architecture.path));
    const blockers = [...record.blockers, ...maintenance.blockers.map((b) => ({ code: b.code, paths: b.path ? [b.path] : [] }))];
    const currentPaths = new Set(observed.items.filter((item) => item.type === 'file').map((item) => key(item.path)));
    const registered = new Set(architecture.tree.flatMap((module) => module.source.map((source) => key(source.path))));
    for (const issue of maintenance.uncovered) if (issue.reason === 'removed_source_presence_unverified' && currentPaths.has(key(issue.path)) && !registered.has(key(issue.path)))
      blockers.push({ code: 'UNREGISTERED_SOURCE', paths: [issue.path] });
    const hidden = record.accumulated_paths.filter((path) => isGeneratedPath(path, this.generated));
    if (hidden.length) blockers.push({ code: 'CHANGE_GENERATED_HISTORY', paths: hidden });
    const docs = (path) => /\.(?:md|txt|rst|adoc)$/iu.test(path) && !registered.has(key(path));
    const missingRules = noChecks.filter((path) => !docs(path));
    if (missingRules.length) blockers.push({ code: 'REQUIRED_CHECK_MISSING', paths: missingRules });
    const basis = { change_id: record.id, review_policy_id: this.reviewPolicyId, input_fingerprint_kind: INPUT_FINGERPRINT_KIND, observed_sha: observed.sha256, architecture_version: architecture.version,
      baseline_sha: record.baseline_architecture_ref?.sha256 ?? null, context_config_sha: config.sha256, rules_sha: this.rulesSha,
      scope_sha: sha(record.scope), intent_sha: sha({ task: record.task, requirement_ref: record.requirement_ref, acceptance: record.acceptance, reuse: record.reuse }),
      plan_sha: sha(plan) };
    const sources = capture ? await this.captureSources([...paths, config.architecture.path, ...record.scope.map((s) => s.path)], observed, signal) : [];
    await index.fresh(architecture.versions, signal);
    if ((await this.snapshot(signal)).sha256 !== observed.sha256 || (await this.loadConfig(signal)).sha256 !== config.sha256)
      fault('CHANGE_REVIEW_STALE', 'Review inputs changed during preparation; prepare again.');
    check(signal);
    return { schema_version: 1, kind: 'change_review_context', workspace_id: this.store.workspaceId, change_id: record.id,
      basis, version: sha(basis), task: record.task, requirement_ref: record.requirement_ref, acceptance: record.acceptance,
      scope: record.scope, architecture, maintenance, plan, paths, checks_not_applicable_paths: noChecks.filter(docs),
      sources, baseline_ref: record.baseline_architecture_ref ?? null, before_sources: baseline?.sources ?? [], blockers };
  }

  async review(input, { signal } = {}) {
    const args = changeReviewSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(args)) > 64 * 1024) fault('CHANGE_REVIEW_LIMIT', 'Review submission exceeds 64 KiB.');
    return withWorkspaceLock(this.store, async () => {
      check(signal);
      const current = await this.refresh(await this.read({ signal }), { signal }); this.bind(current, args.change);
      if (!['open', 'dirty'].includes(current.record.state)) fault('CHANGE_STATE', 'Review requires an open or dirty change; explicitly resume interruptions.');
      const inputs = await this.reviewInputs(current, signal, args.phase === 'prepare');
      if (args.phase === 'prepare') {
        const raw = await this.records.archive(inputs, 'sol_change_review_context', signal);
        const result = { schema_version: 1, kind: 'change_review_context', change: args.change, version: inputs.version,
          status: inputs.blockers.length ? 'blocked' : 'ready', task_complete: false, raw, affected_uids: inputs.maintenance.affected_uids,
          acceptance_count: inputs.acceptance.length, uncovered_count: inputs.maintenance.uncovered.length,
          required_checks: inputs.plan.rules, blockers: inputs.blockers,
          next: 'Recall raw for before/current source refs, maintenance suggestions and exact coverage. Submit every affected UID, acceptance index and uncovered index. Declaration fixes use bound writes; prepare again afterward.' };
        if (Buffer.byteLength(JSON.stringify(result)) > 4096) {
          result.affected_uid_count = result.affected_uids.length; delete result.affected_uids; delete result.required_checks;
          result.blockers = [...new Set(result.blockers.map((b) => b.code))].map((code) => ({ code }));
          result.omitted = ['UIDs, check plan and blocker paths: recall raw'];
        }
        if (Buffer.byteLength(JSON.stringify(result)) > 4096) fault('CHANGE_BUDGET', 'Review preparation exceeds its output budget.');
        return result;
      }
      const prepared = await this.records.stored(args.review_context_handle, 'sol_change_review_context', 'change_review_context', signal);
      if (prepared.change_id !== current.record.id || prepared.version !== sha(prepared.basis) || prepared.version !== inputs.version)
        fault('CHANGE_REVIEW_STALE', 'Review was prepared against another task or earlier inputs.');
      const output = args.review;
      const exact = (actual, expected, code) => {
        if (new Set(actual).size !== actual.length || actual.length !== expected.length || actual.some((id) => !expected.includes(id)))
          fault(code, 'Review must cover each required item exactly once.');
      };
      exact(output.modules.map((m) => m.uid), inputs.maintenance.affected_uids, 'CHANGE_REVIEW_MODULES');
      exact(output.acceptance.map((a) => a.index), inputs.acceptance.map((_, i) => i), 'CHANGE_REVIEW_ACCEPTANCE');
      exact(output.uncovered.map((u) => u.index), inputs.maintenance.uncovered.map((_, i) => i), 'CHANGE_REVIEW_COVERAGE');
      const currentUids = new Set(inputs.architecture.tree.map((m) => m.uid));
      for (const module of output.modules) if ((module.disposition === 'removed') === currentUids.has(module.uid))
        fault('CHANGE_REVIEW_MODULES', 'Removed disposition must match current module existence.');
      const checkIds = inputs.plan.rules.flatMap((r) => r.check_ids);
      for (const item of output.acceptance) {
        if (new Set(item.check_ids).size !== item.check_ids.length || item.check_ids.some((id) => !checkIds.includes(id))) fault('CHANGE_REVIEW_CHECKS', 'Acceptance cites a check outside the required plan.');
        if (checkIds.length && !item.check_ids.length) fault('CHANGE_REVIEW_CHECKS', 'Map each acceptance criterion to required behavioral checks.');
      }
      const exemptions = output.checks_not_applicable ?? [];
      exact(exemptions.map((e) => e.path), inputs.checks_not_applicable_paths, 'CHANGE_REVIEW_CHECKS');
      const available = [...prepared.sources, ...prepared.before_sources].flatMap((s) => s.raw ? [s.raw] : []);
      const currentHandles = new Set(prepared.sources.flatMap((s) => s.raw ? [s.raw.handle] : []));
      const allowed = new Map(available.map((ref) => [ref.handle, ref]));
      const rows = [...output.modules, ...output.acceptance, ...output.uncovered, ...exemptions];
      const evidence = [];
      for (const row of rows) {
        if (!row.evidence_handles.some((h) => currentHandles.has(h))) fault('CHANGE_REVIEW_EVIDENCE', 'Every reviewed item needs current captured source evidence.');
        for (const h of [...(row.contract_refs ?? []), ...row.evidence_handles]) {
          const ref = allowed.get(h);
          if (!ref) fault('CHANGE_REVIEW_EVIDENCE', 'Evidence must cite before/current source refs from this preparation.');
          const [actual] = await this.records.evidence([h], signal);
          if (!actual.complete || !sameRefs(actual, ref)) fault('CHANGE_REVIEW_EVIDENCE', 'Review source evidence is unavailable or incomplete.');
          evidence.push(ref);
        }
      }
      const handlesAt = (list, paths) => new Set(list.filter((source) => paths.some((path) => key(path) === key(source.path))).flatMap((source) => source.raw ? [source.raw.handle] : []));
      const declarationHandles = handlesAt(prepared.sources, [inputs.architecture.versions[0].path]);
      for (const module of output.modules) {
        const currentModule = inputs.architecture.tree.find((m) => m.uid === module.uid);
        const paths = currentModule?.source.map((source) => source.path) ?? [];
        const own = paths.length ? handlesAt(prepared.sources, paths) : declarationHandles;
        if (!module.evidence_handles.some((h) => own.has(h))) fault('CHANGE_REVIEW_EVIDENCE', 'Module review must cite its own current sources, or the declaration for source-less/removed modules.');
        if (!currentModule) {
          const prior = (await this.verified(inputs.baseline_ref, 'sol_change_baseline', 'change_baseline', signal)).architecture.tree.find((m) => m.uid === module.uid);
          const before = handlesAt(prepared.before_sources, prior?.source.map((s) => s.path) ?? []);
          if (before.size && ![...module.contract_refs, ...module.evidence_handles].some((h) => before.has(h))) fault('CHANGE_REVIEW_EVIDENCE', 'Removed module review must also cite its before sources.');
        }
      }
      for (const row of output.uncovered) {
        const issue = inputs.maintenance.uncovered[row.index];
        if (!issue.path) continue;
        const current = handlesAt(prepared.sources, [issue.path]);
        const prior = handlesAt(prepared.before_sources, [issue.path]);
        const own = current.size ? current : prior;
        if (own.size && !row.evidence_handles.some((h) => own.has(h))) fault('CHANGE_REVIEW_EVIDENCE', 'Uncovered relationship review must cite its source path.');
      }
      const outstanding = [...output.unresolved, ...rows.flatMap((row) => row.unresolved ?? [])];
      const raw = await this.records.archive({ schema_version: 1, kind: 'change_review', workspace_id: this.store.workspaceId,
        change_id: current.record.id, review_policy_id: this.reviewPolicyId, basis_version: inputs.version, context_handle: args.review_context_handle,
        method: { reported: output.method, identity_verified: false }, review: output, unresolved: outstanding,
        evidence_refs: [...new Map(evidence.map((ref) => [ref.handle, ref])).values()] }, 'sol_change_review', signal);
      if ((await this.reviewInputs(current, signal)).version !== inputs.version) fault('CHANGE_REVIEW_STALE', 'Inputs changed during review submission.');
      const updated = await this.publish({ ...current.record, state: 'dirty', review_ref: raw, completion_ref: null }, current.raw);
      return this.packet(updated, { accepted: true, review: raw,
        review_status: outstanding.length || inputs.blockers.length ? 'blocked' : 'ready', unresolved_count: outstanding.length });
    }, { signal });
  }

  async validationHistory(current, signal) {
    const result = []; const seen = new Set(); let record = current.record;
    for (let count = 0; count < 256 && record.id === current.record.id; count++) {
      check(signal);
      if (record.latest_validation?.evidence_handle && !seen.has(record.latest_validation.evidence_handle)) {
        seen.add(record.latest_validation.evidence_handle); result.push(record.latest_validation);
      }
      if (!record.previous_handle) break;
      if (seen.has(`record:${record.previous_handle}`)) fault('CHANGE_CORRUPT', 'Change history contains a cycle.');
      seen.add(`record:${record.previous_handle}`);
      const original = await this.records.stored(record.previous_handle, 'sol_change_record', 'change_record', signal);
      const { version, ...body } = original;
      if (sha(body) !== version) fault('CHANGE_CORRUPT', 'Historical change version is invalid.');
      record = recordSchema.parse(original);
    }
    return result;
  }

  async complete(input, { signal } = {}) {
    const args = changeCompleteSchema.parse(input);
    return withWorkspaceLock(this.store, async (lease) => {
      check(signal);
      const initial = await this.refresh(await this.read({ signal }), { signal }); this.bind(initial, args.change);
      if (!['open', 'dirty'].includes(initial.record.state)) fault('CHANGE_STATE', 'Completion requires an open or dirty change; explicitly resume interruptions.');
      if (!initial.record.review_ref || args.review_handle !== initial.record.review_ref.handle) fault('CHANGE_REVIEW_REQUIRED', 'Submit a current review before completing.');
      const inputs = await this.reviewInputs(initial, signal);
      const reviewed = await this.verified(initial.record.review_ref, 'sol_change_review', 'change_review', signal);
      if (reviewed.change_id !== initial.record.id || reviewed.review_policy_id !== this.reviewPolicyId || reviewed.basis_version !== inputs.version) fault('CHANGE_REVIEW_STALE', 'Review no longer describes current inputs.');
      const problems = [...inputs.blockers, ...(reviewed.unresolved.length ? [{ code: 'CHANGE_REVIEW_UNRESOLVED', paths: [] }] : [])];
      if (problems.length) return this.packet(initial, { completion_status: 'blocked', completion_blockers: problems, review_context_handle: reviewed.context_handle });
      const prepared = await this.records.stored(reviewed.context_handle, 'sol_change_review_context', 'change_review_context', signal);
      const operationId = randomUUID();
      let current = await this.publish({ ...initial.record, state: 'checking', completion_ref: null,
        pending: { kind: 'completion', operation_id: operationId, paths: inputs.paths } }, initial.raw);
      const startConditions = conditions();
      try {
        const remaining = new Set(inputs.plan.rules.map((r) => r.id));
        const ruleEvidence = [];
        for (const old of await this.validationHistory(initial, signal)) {
          if (!remaining.size) break;
          const reused = await this.validator.reuse(old, [...remaining], { signal });
          for (const id of reused.valid_rule_ids) {
            remaining.delete(id); ruleEvidence.push({ id, reused: true, receipt_ref: reused.receipt_ref, provenance_ref: reused.provenance_ref });
          }
        }
        let freshReceipt = null;
        if (remaining.size) {
          freshReceipt = await this.validator.revalidate({ rule_ids: [...remaining], paths: inputs.paths, operation_id: operationId }, { signal, onRunnerState: lease.setRunner });
          current = await this.publish({ ...current.record, latest_validation: receiptSummary(freshReceipt) }, current.raw);
          if (freshReceipt.status !== 'passed') fault(freshReceipt.reason === 'interrupted' ? 'INTERRUPTED' : 'CHANGE_CHECK_FAILED', 'Required checks did not pass; inspect the archived receipt before retrying.');
          const [receiptRef] = await this.records.evidence([freshReceipt.evidence_handle], signal);
          const verified = await this.validator.reuse(freshReceipt, [...remaining], { signal });
          for (const id of remaining) {
            const required = inputs.plan.rules.find((rule) => rule.id === id).check_ids;
            if (required.some((checkId) => !freshReceipt.checks.some((c) => c.id === checkId && c.status === 'passed'))) fault('CHANGE_CHECK_FAILED', 'Fresh receipt omitted a required check.');
            ruleEvidence.push({ id, reused: false, receipt_ref: receiptRef, provenance_ref: verified.provenance_ref });
          }
        }
        check(signal);
        if ((await this.reviewInputs(current, signal)).version !== inputs.version || conditions() !== startConditions) fault('CHANGE_REVIEW_STALE', 'Inputs or execution conditions changed during completion.');
        const refs = [initial.record.review_ref, inputs.baseline_ref, ...reviewed.evidence_refs,
          ...prepared.sources.flatMap((source) => source.raw ? [source.raw] : []),
          ...prepared.before_sources.flatMap((source) => source.raw ? [source.raw] : []),
          ...ruleEvidence.flatMap((rule) => [rule.receipt_ref, rule.provenance_ref].filter(Boolean))];
        for (const ref of [...new Map(ruleEvidence.map((rule) => [rule.receipt_ref.handle, rule.receipt_ref])).values()]) {
          const { value: receipt } = await this.store.readVerifiedJSON(ref.handle, { maxBytes: 128 * 1024, signal,
            validateMeta: (meta) => { if (meta.tool !== 'validation_receipt' || !meta.complete || !sameRefs({ ...meta, handle: ref.handle }, ref)) fault('REFERENCE_INVALID', 'Completion requires a bounded real validation receipt.'); } });
          assertContract('ValidationReceipt', receipt);
          if (receipt.status !== 'passed') fault('CHANGE_CHECK_FAILED', 'Completion cites a non-passing receipt.');
          refs.push(...receipt.checks.flatMap((c) => c.output));
        }
        const evidenceRefs = [...new Map(refs.filter(Boolean).map((ref) => [ref.handle, ref])).values()];
        for (const ref of evidenceRefs) {
          const [actual] = await this.records.evidence([ref.handle], signal);
          if (!actual.complete || !sameRefs(actual, ref)) fault('REFERENCE_INVALID', 'Completion evidence is unavailable or incomplete.');
        }
        const completed = await this.records.archive({ schema_version: 1, kind: 'change_completion', workspace_id: this.store.workspaceId,
          change_id: initial.record.id, review_policy_id: this.reviewPolicyId, basis: inputs.basis, basis_version: inputs.version, review_ref: initial.record.review_ref,
          architecture_versions: inputs.architecture.versions, rule_evidence: ruleEvidence, evidence_refs: evidenceRefs,
          conditions_sha: startConditions, captured_at: new Date().toISOString() }, 'sol_change_completion', signal);
        if ((await this.reviewInputs(current, signal)).version !== inputs.version || conditions() !== startConditions) fault('CHANGE_REVIEW_STALE', 'Inputs changed before completion publication.');
        check(signal);
        const finalRecord = { ...current.record, state: 'completed', pending: null, completion_ref: completed };
        current = await this.publish(finalRecord, current.raw, { beforePublish: async () => {
          check(signal); await this.currentRules(signal);
          await this.completionValid(finalRecord, await this.loadConfig(signal), signal);
          if ((await this.snapshot(signal)).sha256 !== inputs.basis.observed_sha) fault('CHANGE_REVIEW_STALE', 'Workspace changed while archiving the final record; completion was not published.');
          check(signal);
        } });
        return this.packet(current, { completion_status: 'completed', reused_rule_count: ruleEvidence.filter((r) => r.reused).length,
          executed_rule_count: ruleEvidence.filter((r) => !r.reused).length });
      } catch (error) {
        const interrupted = signal?.aborted || error.code === 'INTERRUPTED' || error.code === 'HOST_STATE_ERROR';
        try {
          current = await this.refresh(current);
          current = await this.publish({ ...current.record, state: interrupted ? 'interrupted' : 'dirty', pending: null,
            completion_ref: null }, current.raw);
          return this.packet(current, { completion_status: interrupted ? 'interrupted' : 'blocked', completion_error: publicError(error) });
        } catch (publicationError) {
          return this.packet(current, { state: 'interrupted', task_complete: false, recovery_required: true,
            completion_status: 'interrupted', completion_error: publicError(error), change_persistence_error: publicError(publicationError) });
        }
      }
    }, { signal });
  }

  async transition(binding, state, { signal, reason } = {}) {
    return withWorkspaceLock(this.store, async () => {
      check(signal);
      const current = await this.refresh(await this.read({ signal }), { signal }); this.bind(current, binding);
      if (state === 'dirty' && current.record.state !== 'interrupted') fault('CHANGE_STATE', 'Only interrupted changes can be resumed.');
      if (state === 'abandoned' && current.record.state === 'abandoned') return this.packet(current);
      return this.packet(await this.publish({ ...current.record, state, pending: null,
        ...(state === 'abandoned' ? { abandonment_reason: text.parse(reason) } : {}) }, current.raw));
    }, { signal });
  }

  async run(binding, paths, operation, { signal } = {}) {
    return withWorkspaceLock(this.store, async (lease) => {
      check(signal);
      const initial = await this.refresh(await this.read({ signal }), { signal });
      const scope = await this.assertWritableLocked(initial, binding, paths, { signal });
      const operationId = randomUUID();
      const pending = await this.publish({ ...initial.record, state: 'dirty', latest_validation: null,
        recovery: undefined, operation_ref: null,
        pending: { operation_id: operationId, paths, kind: 'write', starting_binding: binding },
        evidence_generation: initial.record.evidence_generation + 1 }, initial.raw);
      let outcome;
      try { check(signal); outcome = await operation(lease, { operationId, callId: operationId }); }
      catch (error) { outcome = { tool_status: 'error', error: publicError(error), changed_paths: [], changed_paths_known: false }; }
      try {
        // Always capture actual effects after cancellation; never replay a partial write.
        const observed = await this.snapshot();
        const changed = difference(initial.record.observed, observed);
        if (outcome.changed_paths_known === false) outcome = { ...outcome, changed_paths: changed.slice(0, 50),
          changed_paths_known: true, changed_path_count: changed.length, changed_paths_omitted: Math.max(0, changed.length - 50) };
        const outside = changed.filter((path) => !scope.has(key(path)));
        const interrupted = signal?.aborted || outcome.error?.code === 'INTERRUPTED' || outcome.error?.code === 'HOST_STATE_ERROR';
        // Cancellation stops execution; durable capture of the already-known effects still proceeds.
        const operationRef = await this.publishOperation(binding, operationId, outcome);
        const record = { ...pending.record, pending: null, observed, operation_ref: operationRef,
          state: interrupted ? 'interrupted' : changed.length ? 'dirty' : initial.record.state,
          accumulated_paths: [...new Set([...initial.record.accumulated_paths, ...changed])].sort(),
          latest_validation: changed.length ? outcome.validation ?? null : initial.record.latest_validation,
          review_ref: changed.length ? null : initial.record.review_ref, completion_ref: changed.length ? null : initial.record.completion_ref,
          evidence_generation: changed.length ? pending.record.evidence_generation : initial.record.evidence_generation,
          blockers: outside.length ? [{ code: 'CHANGE_OUTSIDE_SCOPE', paths: outside }] : [] };
        const settled = await this.publish(record, pending.raw);
        return { ...outcome, ...(outside.length ? { tool_status: 'error', scope_error: { code: 'CHANGE_OUTSIDE_SCOPE', message: 'Actual operation effects include unregistered paths; inspect and adjust the change scope.' } } : {}), change: this.packet(settled) };
      } catch (error) {
        // Pending remains durable if final publication fails. Recovery is explicit.
        return { ...outcome, tool_status: 'error', change_persistence_error: publicError(error),
          change: { ...this.packet(pending), state: 'interrupted', recovery_required: true } };
      }
    }, { signal });
  }
}
