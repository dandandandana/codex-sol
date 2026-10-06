import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { release } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { runCapturedCommand, toCheckResult } from './process.mjs';
import { snapshotInputs, digestChangedPaths, matchesGlob } from './workspace-snapshot.mjs';
import { INPUT_FINGERPRINT_KIND } from './workspace.mjs';
export { snapshotInputs, digestChangedPaths, matchesGlob, isGeneratedPath } from './workspace-snapshot.mjs';
import { assertContract } from './schema.mjs';
import { interruptionFault, SolFault } from './store.mjs';
import { interruptionReason } from './host-cancellation.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const PROVENANCE_BYTES = 128 * 1024;
const pathKey = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
function checkCancellation(signal) { if (signal?.aborted) throw interruptionFault(signal, 'Validation operation was interrupted.'); }

function receiptBase(event, key, status, reason, checks = []) {
  return { schema_version: 1, receipt_id: randomUUID(), event_id: event.event_id, change_digest: event.change_digest, validation_key: key, status, reason, checks, evidence_handle: null };
}

async function executableHash(file, signal) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) { checkCancellation(signal); digest.update(chunk); }
  return digest.digest('hex');
}

async function resolveExecutable(executable) {
  // Do not approximate platform/PATH resolution and certify the wrong binary.
  if (!isAbsolute(executable)) return null;
  const file = await realpath(executable);
  if (!(await lstat(file)).isFile()) return null;
  // Byte-identical Linux programs cannot certify old checks after chmod removes
  // execute permission. The caller records unverified conditions on access failure.
  if (process.platform === 'linux') await access(file, constants.X_OK);
  return file;
}

// Only hashes leave this function: inherited environment values may contain secrets.
async function runtimeConditions(store, selected, signal) {
  checkCancellation(signal);
  const environmentSha = sha(JSON.stringify(Object.entries(process.env).map(([key, value]) => [pathKey(key), value]).sort(([a], [b]) => a.localeCompare(b))));
  const hashes = new Map();
  const hash = async (file) => {
    if (!hashes.has(file)) hashes.set(file, await executableHash(file, signal));
    return hashes.get(file);
  };
  const runtimeSha = sha(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    release: release(), executable: await hash(process.execPath) }));
  const result = [];
  for (const rule of selected) {
    const commands = [];
    for (const command of rule.commands) {
      checkCancellation(signal);
      try {
        const cwd = await realpath(resolve(store.workspaceRoot, command.cwd));
        const executable = await resolveExecutable(command.argv[0]);
        commands.push({ id: `${rule.id}/${command.id}`, executable_sha: executable ? await hash(executable) : null,
          executable_path_sha: executable ? sha(executable) : null, cwd_sha: sha(cwd) });
      } catch (error) {
        checkCancellation(signal);
        commands.push({ id: `${rule.id}/${command.id}`, executable_sha: null, executable_path_sha: null, cwd_sha: null });
      }
    }
    result.push({ id: rule.id, environment_sha: environmentSha, runtime_sha: runtimeSha, commands,
      verified: commands.every((command) => command.executable_sha && command.cwd_sha) });
  }
  checkCancellation(signal);
  return result;
}

/** Validate runtime rule identities without storage, commands or input mutation. */
export function validateRulesConfiguration(rulesConfig) {
  assertContract('RulesConfig', rulesConfig);
  const checkIds = new Set();
  const ruleIds = new Set();
  for (const rule of rulesConfig.rules) {
    if (ruleIds.has(rule.id)) throw new SolFault('CONFIG_ERROR', 'Validation rule IDs must be unique.');
    ruleIds.add(rule.id);
    for (const command of rule.commands) {
      const id = `${rule.id}/${command.id}`;
      if (id.length > 4096 || checkIds.has(id)) throw new SolFault('CONFIG_ERROR', 'Validation check IDs must be unique and at most 4096 characters.');
      checkIds.add(id);
    }
  }
  return rulesConfig;
}

export class ValidationEngine {
  constructor(store, rulesConfig, { generated = [] } = {}) {
    validateRulesConfiguration(rulesConfig);
    if (!Array.isArray(generated)) throw new TypeError('Generated exclusions must be an array.');
    generated.forEach((path) => assertContract('WorkspaceGlob', path));
    this.store = store;
    this.rules = structuredClone(rulesConfig.rules);
    this.generated = [...generated];
    this.queue = Promise.resolve();
    this.inflight = new Map();
    this.receiptRoot = join(store.solRoot, 'receipts');
  }

  async onChange(event, { signal, onRunnerState } = {}) {
    assertContract('ChangeEvent', event);
    if (event.workspace_id !== this.store.workspaceId) throw new SolFault('WORKSPACE_ERROR', 'Change event workspace mismatch.');
    return this.#enqueue({ ...event, paths: event.changed_paths, source_kind: 'change' }, signal, onRunnerState);
  }

  #paths(paths) {
    if (!Array.isArray(paths)) throw new SolFault('VALIDATION_PATHS', 'Validation paths must be an array.');
    paths.forEach((path) => assertContract('WorkspacePath', path));
    return [...new Set(paths)];
  }

  #rules(ruleIds) {
    if (!Array.isArray(ruleIds) || !ruleIds.length || new Set(ruleIds).size !== ruleIds.length
      || ruleIds.some((id) => !this.rules.some((rule) => rule.id === id)))
      throw new SolFault('VALIDATION_RULES', 'Select nonempty, unique, configured validation rule IDs.');
    return this.rules.filter((rule) => ruleIds.includes(rule.id));
  }

  /** Rule triggers are configuration facts, not a claim of complete behavioral coverage. */
  plan(paths) {
    const targets = this.#paths(paths);
    const rules = this.rules.map((rule) => ({ id: rule.id,
      trigger_paths: targets.filter((path) => rule.globs.some((glob) => matchesGlob(path, glob))),
      check_ids: rule.commands.map((command) => `${rule.id}/${command.id}`) })).filter((rule) => rule.trigger_paths.length);
    return { rules, uncovered_paths: targets.filter((path) => !rules.some((rule) => rule.trigger_paths.includes(path))) };
  }

  /** The caller holds the workspace lease. This schedules checks, never a ChangeEvent. */
  async revalidate({ rule_ids, paths, operation_id = randomUUID() }, { signal, onRunnerState } = {}) {
    this.#rules(rule_ids);
    const targets = this.#paths(paths);
    assertContract('OpaqueId', operation_id);
    const operation = { event_id: `revalidation:${sha(operation_id)}`, call_id: operation_id, paths: targets,
      source_kind: 'revalidation', rule_ids: [...rule_ids], request_sha: sha(JSON.stringify({ rule_ids, paths: targets })) };
    return this.#enqueue(operation, signal, onRunnerState);
  }

  #enqueue(event, signal, onRunnerState) {
    const existing = this.inflight.get(event.event_id);
    if (existing) {
      if (event.request_sha && existing.request_sha !== event.request_sha) throw new SolFault('VALIDATION_OPERATION', 'Revalidation operation ID was already used with different inputs.');
      return existing.task;
    }
    const task = this.queue.then(() => this.#run(event, signal, onRunnerState));
    this.inflight.set(event.event_id, { task, request_sha: event.request_sha });
    this.queue = task.catch(() => {});
    return task;
  }

  async #persist(event, receipt, evidence = {}) {
    await mkdir(this.receiptRoot, { recursive: true });
    const key = sha(event.event_id);
    const record = join(this.receiptRoot, `${key}.json`);
    const temp = join(this.receiptRoot, `.${key}.${randomUUID()}.tmp`);
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ event_id: event.event_id, receipt, ...evidence,
      ...(event.request_sha ? { request_sha: event.request_sha } : {}) }), 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, record);
    await unlink(join(this.receiptRoot, `${key}.running`)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }

  async #existing(event) {
    try {
      const record = JSON.parse(await readFile(join(this.receiptRoot, `${sha(event.event_id)}.json`), 'utf8'));
      if (record.event_id !== event.event_id) throw new SolFault('CORRUPT', 'Receipt ID collision.');
      if (event.request_sha && record.request_sha !== event.request_sha) throw new SolFault('VALIDATION_OPERATION', 'Revalidation operation ID was already used with different inputs.');
      assertContract('ValidationReceipt', record.receipt);
      return record.receipt;
    } catch (error) {
      if (error.code === 'ENOENT') {
        try {
          await lstat(join(this.receiptRoot, `${sha(event.event_id)}.running`));
          const interrupted = receiptBase(event, sha(event.event_id), 'error', 'interrupted');
          await this.#archiveReceipt(event, interrupted);
          await this.#persist(event, interrupted);
          return interrupted;
        } catch (markerError) {
          if (markerError.code === 'ENOENT') return null;
          throw markerError;
        }
      }
      throw error;
    }
  }

  async #archiveReceipt(event, receipt) {
    let writer;
    try {
      writer = await this.store.beginCapture({ schema_version: 1, workspace_id: this.store.workspaceId, call_id: event.call_id, tool: 'validation_receipt', captured_at: new Date().toISOString(), media_type: 'application/json', encoding: 'utf-8', source_form: 'response_json', channel: 'response' });
      receipt.evidence_handle = writer.handle;
      await writer.write(Buffer.from(JSON.stringify(receipt), 'utf8'));
      return await writer.commit({ complete: true });
    } catch (error) {
      await writer?.abort();
      receipt.status = 'error';
      receipt.reason = 'storage';
      receipt.evidence_handle = null;
      process.stderr.write(`Codex-SoL receipt archive failed: ${error.message ?? String(error)}\n`);
      return null;
    }
  }

  async #sources(selected, paths, signal) {
    const conditions = await runtimeConditions(this.store, selected, signal);
    const result = [];
    for (const rule of selected) {
      checkCancellation(signal);
      const inputs = await snapshotInputs(this.store.workspaceRoot, rule.watch_paths, this.generated, paths, { signal });
      result.push({ id: rule.id, rule_config_sha: sha(JSON.stringify(rule)), generated_sha: sha(JSON.stringify(this.generated)),
        input_sha: inputs.sha256, input_fingerprint_kind: inputs.fingerprint_kind, seed_paths: [...paths], check_ids: rule.commands.map((command) => `${rule.id}/${command.id}`),
        conditions: conditions.find((condition) => condition.id === rule.id) });
    }
    if (Buffer.byteLength(JSON.stringify(result)) > PROVENANCE_BYTES / 2) throw new SolFault('VALIDATION_PROVENANCE_LIMIT', 'Validation provenance exceeds its metadata budget.');
    checkCancellation(signal);
    return result;
  }

  async #finish(event, receipt, sources = [], signal) {
    const interrupted = () => {
      receipt.status = 'error'; receipt.reason = interruptionReason(signal);
    };
    if (signal?.aborted) interrupted();
    let receiptRef = await this.#archiveReceipt(event, receipt);
    let provenanceRef = null;
    let provenanceError = null;
    if (signal?.aborted && receipt.reason !== interruptionReason(signal)) {
      interrupted(); receipt.evidence_handle = null; receiptRef = null;
    }
    if (receipt.status === 'passed' && receipt.checks.every((check) => check.output.length === 2 && check.output.every((ref) => ref.complete))) {
      let writer;
      try {
        const provenance = { schema_version: 1, kind: 'validation_provenance', workspace_id: this.store.workspaceId,
          source_kind: event.source_kind, source_id: event.event_id, call_id: event.call_id,
          receipt_id: receipt.receipt_id, receipt_ref: receiptRef, rules: sources };
        const bytes = Buffer.from(JSON.stringify(provenance));
        if (bytes.length > PROVENANCE_BYTES) throw new SolFault('VALIDATION_PROVENANCE_LIMIT', 'Validation provenance exceeds 128 KiB.');
        writer = await this.store.beginCapture({ schema_version: 1, workspace_id: this.store.workspaceId, call_id: event.call_id,
          tool: 'validation_provenance', captured_at: new Date().toISOString(), media_type: 'application/json',
          encoding: 'utf-8', source_form: 'response_json', channel: 'response' });
        await writer.write(bytes); provenanceRef = await writer.commit({ complete: true });
      } catch (error) {
        await writer?.abort();
        receipt.status = 'error'; receipt.reason = 'storage'; receipt.evidence_handle = null; receiptRef = null;
        provenanceError = { code: error.code ?? 'STORAGE_ERROR' };
      }
    }
    if (signal?.aborted && receipt.reason !== interruptionReason(signal)) {
      interrupted(); receipt.evidence_handle = null; receiptRef = null; provenanceRef = null;
    }
    assertContract('ValidationReceipt', receipt);
    await this.#persist(event, receipt, { source_kind: event.source_kind, receipt_ref: receiptRef,
      provenance_ref: provenanceRef, ...(provenanceError ? { provenance_error: provenanceError } : {}),
      ...(provenanceRef ? {} : { provenance_diagnostics: sources }) });
    if (signal?.aborted && receipt.reason !== interruptionReason(signal)) {
      interrupted(); receipt.evidence_handle = null;
      await this.#persist(event, receipt, { source_kind: event.source_kind, receipt_ref: null, provenance_ref: null,
        provenance_diagnostics: sources });
    }
    return receipt;
  }

  async #verified(ref, tool, { signal, json = false, callId, channel } = {}) {
    checkCancellation(signal);
    assertContract('RawRef', ref);
    if (!ref.complete) throw new SolFault('VALIDATION_EVIDENCE', 'Validation evidence is incomplete.');
    const validateMeta = (meta) => {
      if (meta.tool !== tool || !meta.complete || meta.sha256 !== ref.sha256 || meta.bytes !== ref.bytes
        || meta.media_type !== ref.media_type || (callId !== undefined && meta.call_id !== callId)
        || (channel !== undefined && meta.channel !== channel))
        throw new SolFault('VALIDATION_EVIDENCE', 'Validation evidence identity or raw reference does not match.');
      checkCancellation(signal);
      if (json && (meta.bytes > PROVENANCE_BYTES || meta.media_type !== 'application/json' || meta.encoding !== 'utf-8'
        || meta.source_form !== 'response_json' || meta.channel !== 'response'))
        throw new SolFault('VALIDATION_EVIDENCE', 'Validation metadata is not a bounded JSON archive.');
    };
    // JSON allocation follows identity/size checks; returned bytes come from the
    // same full verification stream. Output checks need no raw buffer at all.
    const result = json
      ? await this.store.readVerifiedJSON(ref.handle, { signal, maxBytes: PROVENANCE_BYTES, validateMeta })
      : await this.store.verify(ref.handle, { signal, validateMeta });
    checkCancellation(signal);
    return json ? { meta: result.meta, value: result.value } : { meta: result.meta };
  }

  /** No runner or repair writes: missing, legacy or stale evidence stays missing. */
  async reuse(receiptOrSummary, ruleIds, { signal } = {}) {
    return this.#verifyReceipt(receiptOrSummary, ruleIds, signal, false);
  }

  /** Verify completed evidence independently of permission to reuse historical checks. */
  async freshness(receiptOrSummary, ruleIds, { signal } = {}) {
    return this.#verifyReceipt(receiptOrSummary, ruleIds, signal, true);
  }

  async #verifyReceipt(receiptOrSummary, ruleIds, signal, ignoreReusePermission) {
    const selected = this.#rules(ruleIds);
    const result = { valid_rule_ids: [], missing_rule_ids: [...ruleIds], receipt_ref: null, provenance_ref: null, diagnostics: [] };
    checkCancellation(signal);
    let receipt;
    let provenance;
    try {
      if (!receiptOrSummary || typeof receiptOrSummary !== 'object') throw new SolFault('VALIDATION_EVIDENCE', 'Supply an original receipt or summary.');
      assertContract('OpaqueId', receiptOrSummary.event_id);
      const file = join(this.receiptRoot, `${sha(receiptOrSummary.event_id)}.json`);
      const stats = await lstat(file);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > PROVENANCE_BYTES)
        throw new SolFault('VALIDATION_EVIDENCE', 'Receipt pointer is not bounded regular metadata.');
      const record = JSON.parse(await readFile(file, 'utf8'));
      if (record.event_id !== receiptOrSummary.event_id || !record.receipt_ref || !record.provenance_ref)
        throw new SolFault('VALIDATION_EVIDENCE', 'Receipt has no verified provenance.');
      const original = await this.#verified(record.receipt_ref, 'validation_receipt', { signal, json: true });
      receipt = assertContract('ValidationReceipt', original.value);
      if (receipt.event_id !== record.event_id || receipt.evidence_handle !== record.receipt_ref.handle
        || !isDeepStrictEqual(receipt, record.receipt) || receipt.status !== 'passed')
        throw new SolFault('VALIDATION_EVIDENCE', 'Receipt archive is not the original passed result.');
      const expectedInput = Object.hasOwn(receiptOrSummary, 'receipt_id') ? receipt : receiptSummary(receipt);
      if (!isDeepStrictEqual(receiptOrSummary, expectedInput))
        throw new SolFault('VALIDATION_EVIDENCE', 'Supplied receipt identity or summary differs from its archive.');
      const archived = await this.#verified(record.provenance_ref, 'validation_provenance', { signal, json: true, callId: original.meta.call_id });
      provenance = archived.value;
      if (provenance.schema_version !== 1 || provenance.kind !== 'validation_provenance'
        || provenance.workspace_id !== this.store.workspaceId || provenance.source_id !== receipt.event_id
        || provenance.receipt_id !== receipt.receipt_id || provenance.call_id !== original.meta.call_id
        || !['change', 'revalidation'].includes(provenance.source_kind) || provenance.source_kind !== record.source_kind
        || !isDeepStrictEqual(provenance.receipt_ref, record.receipt_ref) || !Array.isArray(provenance.rules)
        || new Set(provenance.rules.map((rule) => rule.id)).size !== provenance.rules.length)
        throw new SolFault('VALIDATION_EVIDENCE', 'Provenance identity does not match the receipt.');
      for (const check of receipt.checks) {
        if (check.status !== 'passed' || check.exit_code !== 0 || check.output.length !== 2)
          throw new SolFault('VALIDATION_EVIDENCE', 'Receipt contains an unsuccessful or incomplete check.');
        for (const [index, ref] of check.output.entries()) {
          await this.#verified(ref, 'validation', { signal, callId: check.id, channel: index ? 'stderr' : 'stdout' });
        }
      }
      result.receipt_ref = record.receipt_ref; result.provenance_ref = record.provenance_ref;
    } catch (error) {
      checkCancellation(signal);
      result.diagnostics.push({ code: 'VALIDATION_EVIDENCE_UNAVAILABLE', reason: error.code ?? 'invalid_metadata' });
      return result;
    }
    for (const rule of selected) {
      checkCancellation(signal);
      let reason = null;
      const source = provenance.rules.find((item) => item.id === rule.id);
      if (!ignoreReusePermission && rule.reuse !== 'watched_inputs') reason = 'reuse_not_declared';
      else if (!source) reason = 'rule_not_in_receipt';
      else if (source.input_fingerprint_kind !== INPUT_FINGERPRINT_KIND) reason = 'input_fingerprint_unknown';
      else {
        try {
          const paths = this.#paths(source.seed_paths);
          const [current] = await this.#sources([rule], paths, signal);
          const checkIds = rule.commands.map((command) => `${rule.id}/${command.id}`);
          if (!isDeepStrictEqual(source.check_ids, checkIds) || checkIds.some((id) => !receipt.checks.some((check) => check.id === id))) reason = 'check_ids_changed';
          else if (!source.conditions?.verified || !current.conditions.verified) reason = 'runtime_conditions_unverified';
          else if (source.rule_config_sha !== current.rule_config_sha) reason = 'rule_config_changed';
          else if (source.generated_sha !== current.generated_sha) reason = 'generated_paths_changed';
          else if (source.input_sha !== current.input_sha) reason = 'watched_inputs_changed';
          else if (!isDeepStrictEqual(source.conditions, current.conditions)) reason = 'runtime_conditions_changed';
        } catch (error) { checkCancellation(signal); reason = error.code ?? 'inputs_unavailable'; }
      }
      if (reason) result.diagnostics.push({ code: 'VALIDATION_RULE_NOT_REUSABLE', rule_id: rule.id, reason });
      else result.valid_rule_ids.push(rule.id);
    }
    result.missing_rule_ids = ruleIds.filter((id) => !result.valid_rule_ids.includes(id));
    checkCancellation(signal);
    return result;
  }

  async #run(event, signal, onRunnerState) {
    if (event.source_kind === 'revalidation') event.change_digest = await digestChangedPaths(this.store.workspaceRoot, event.paths);
    const cached = await this.#existing(event);
    if (cached) return cached;
    await mkdir(this.receiptRoot, { recursive: true });
    const marker = await open(join(this.receiptRoot, `${sha(event.event_id)}.running`), 'wx', 0o600);
    try { await marker.writeFile(JSON.stringify({ event_id: event.event_id, started_at: new Date().toISOString() })); await marker.sync(); }
    finally { await marker.close(); }
    const selected = event.rule_ids ? this.#rules(event.rule_ids)
      : this.rules.filter((rule) => event.paths.some((path) => rule.globs.some((glob) => matchesGlob(path, glob))));
    const configHash = sha(JSON.stringify(selected));
    if (signal?.aborted) {
      const receipt = receiptBase(event, configHash, 'error', interruptionReason(signal));
      return this.#finish(event, receipt, [], signal);
    }
    if (event.origin === 'validation') {
      const receipt = receiptBase(event, configHash, 'skipped', 'validation_origin');
      return this.#finish(event, receipt, [], signal);
    }
    if (!selected.length) {
      const receipt = receiptBase(event, configHash, 'skipped', 'no_rule');
      return this.#finish(event, receipt, [], signal);
    }
    let receipt;
    const checks = [];
    let validationKey = configHash;
    let sources = [];
    try {
      const globs = [...new Set(selected.flatMap((rule) => rule.watch_paths))];
      sources = await this.#sources(selected, event.paths, signal);
      const before = await snapshotInputs(this.store.workspaceRoot, globs, this.generated, event.paths, { signal });
      validationKey = sha(JSON.stringify({ input: before.sha256, fingerprint_kind: before.fingerprint_kind, rules: selected }));
      let stopped = false;
      const deadline = Date.now() + 300000;
      for (const rule of selected) {
        for (const command of rule.commands) {
          const id = `${rule.id}/${command.id}`;
          if (stopped || Date.now() >= deadline) {
            checks.push({ id, status: 'skipped', reason: stopped ? 'prior_failure' : 'total_timeout', exit_code: null, duration_ms: 0, output: [] });
            continue;
          }
          const result = await runCapturedCommand(this.store, command, { id, remainingMs: deadline - Date.now(), signal, onRunnerState });
          checks.push(toCheckResult(result));
          if (result.status !== 'passed') stopped = true;
        }
      }
      const after = await snapshotInputs(this.store.workspaceRoot, globs, this.generated, event.paths, { signal: signal?.aborted ? undefined : signal });
      const afterSources = await this.#sources(selected, event.paths, signal?.aborted ? undefined : signal);
      const stale = before.sha256 !== after.sha256 || !isDeepStrictEqual(sources, afterSources);
      const firstBad = checks.find((check) => check.status !== 'passed' && check.status !== 'skipped');
      const status = signal?.aborted ? 'error' : stale ? 'stale' : firstBad?.status ?? (checks.some((check) => check.reason === 'total_timeout') ? 'timeout' : 'passed');
      const reason = signal?.aborted ? interruptionReason(signal) : stale ? 'input_changed' : firstBad ? firstBad.reason : status === 'timeout' ? 'total_timeout' : 'all_checks_passed';
      receipt = receiptBase(event, validationKey, status, reason, checks);
    } catch (error) {
      receipt = receiptBase(event, validationKey, 'error', signal?.aborted ? interruptionReason(signal) : `runner:${error.code ?? error.message ?? String(error)}`, checks);
    }
    return this.#finish(event, receipt, sources, signal);
  }
}

export function receiptSummary(receipt) {
  const first = receipt.checks.find((check) => check.status !== 'passed' && check.status !== 'skipped');
  const summary = { event_id: receipt.event_id, change_digest: receipt.change_digest, status: receipt.status, reason: receipt.reason, executed: receipt.checks.filter((c) => c.status !== 'skipped').length, skipped: receipt.checks.filter((c) => c.status === 'skipped').length, first_failure: first ? { id: first.id, status: first.status, reason: first.reason, exit_code: first.exit_code, duration_ms: first.duration_ms, output: first.output.map((ref) => ref.handle) } : null, evidence_handle: receipt.evidence_handle };
  if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > 4096 && summary.first_failure) {
    summary.first_failure = { id: summary.first_failure.id.slice(0, 256), status: summary.first_failure.status, reason: summary.first_failure.reason.slice(0, 256), exit_code: summary.first_failure.exit_code, duration_ms: summary.first_failure.duration_ms, output: summary.first_failure.output };
  }
  if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > 4096) summary.reason = summary.reason.slice(0, 256);
  if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > 4096) throw new SolFault('STORAGE_ERROR', 'Receipt summary exceeds 4 KiB.');
  return summary;
}
