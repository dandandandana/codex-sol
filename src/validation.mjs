import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { runCapturedCommand } from './process.mjs';
import { assertContract } from './schema.mjs';
import { SolFault } from './store.mjs';
import { interruptionReason } from './host-cancellation.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const DEFAULT_EXCLUDED = ['.git', '.codex/sol'];

function globRegex(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
      else { out += '.*'; i += 1; }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += /[.+^${}()|[\]\\]/u.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`${out}$`, 'u');
}

export function matchesGlob(path, glob) { return globRegex(glob).test(path); }
function excluded(path, extra = []) {
  const comparison = process.platform === 'win32' ? path.toLowerCase() : path;
  return DEFAULT_EXCLUDED.some((part) => comparison === part || comparison.startsWith(`${part}/`))
    || extra.some((part) => path === part || path.startsWith(`${part}/`) || matchesGlob(path, part));
}
function normalize(path) { return path.split(sep).join('/'); }

async function listTree(root, paths = [], prefix = '', generated = []) {
  const directory = prefix ? join(root, prefix) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = prefix ? `${normalize(prefix)}/${entry.name}` : entry.name;
    if (excluded(path, generated)) continue;
    const full = join(root, path);
    const stats = await lstat(full);
    if (stats.isSymbolicLink()) throw new SolFault('SNAPSHOT_ERROR', `Symlink in input tree: ${path}`);
    if (stats.isDirectory()) await listTree(root, paths, path, generated);
    else if (stats.isFile()) paths.push(path);
    else throw new SolFault('SNAPSHOT_ERROR', `Unsupported input type: ${path}`);
  }
  return paths;
}

export async function snapshotInputs(root, globs, generated = [], changedPaths = []) {
  const all = await listTree(root, [], '', generated);
  const paths = [...new Set([...all, ...changedPaths])].filter((path) => !excluded(path, generated) && globs.some((glob) => matchesGlob(path, glob))).sort();
  const items = [];
  for (const path of paths) {
    try {
      const bytes = await readFile(join(root, path));
      items.push({ path, type: 'file', sha256: sha(bytes) });
    } catch (error) {
      if (error.code !== 'ENOENT' || !changedPaths.includes(path)) throw error;
      items.push({ path, type: 'missing' });
    }
  }
  return { items, sha256: sha(JSON.stringify(items)) };
}

export async function digestChangedPaths(root, changedPaths) {
  const items = [];
  for (const path of [...new Set(changedPaths)].sort()) {
    assertContract('ChangeEvent', { schema_version: 1, event_id: 'path-check', workspace_id: 'path-check', call_id: 'path-check', origin: 'agent', changed_paths: [path], change_digest: '0'.repeat(64) });
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(`${root}${sep}`)) throw new SolFault('PATH_ERROR', 'Changed path escapes workspace.');
    try {
      const stats = await lstat(full);
      if (stats.isSymbolicLink()) throw new SolFault('PATH_ERROR', `Changed path is a symlink: ${path}`);
      if (!stats.isFile()) throw new SolFault('PATH_ERROR', `Changed path is not a file: ${path}`);
      items.push({ path, sha256: sha(await readFile(full)) });
    } catch (error) {
      if (error.code === 'ENOENT') items.push({ path, deleted: true });
      else throw error;
    }
  }
  return sha(JSON.stringify(items));
}

function receiptBase(event, key, status, reason, checks = []) {
  return { schema_version: 1, receipt_id: randomUUID(), event_id: event.event_id, change_digest: event.change_digest, validation_key: key, status, reason, checks, evidence_handle: null };
}

export class ValidationEngine {
  constructor(store, rulesConfig, { generated = [] } = {}) {
    assertContract('RulesConfig', rulesConfig);
    if (!Array.isArray(generated)) throw new TypeError('Generated exclusions must be an array.');
    generated.forEach((path) => assertContract('WorkspaceGlob', path));
    const checkIds = new Set();
    for (const rule of rulesConfig.rules) {
      for (const command of rule.commands) {
        const id = `${rule.id}/${command.id}`;
        if (id.length > 4096 || checkIds.has(id)) throw new SolFault('CONFIG_ERROR', 'Validation check IDs must be unique and at most 4096 characters.');
        checkIds.add(id);
      }
    }
    this.store = store;
    this.rules = rulesConfig.rules;
    this.generated = generated;
    this.queue = Promise.resolve();
    this.inflight = new Map();
    this.receiptRoot = join(store.solRoot, 'receipts');
  }

  async onChange(event, { signal, onRunnerState } = {}) {
    assertContract('ChangeEvent', event);
    if (event.workspace_id !== this.store.workspaceId) throw new SolFault('WORKSPACE_ERROR', 'Change event workspace mismatch.');
    const existing = this.inflight.get(event.event_id);
    if (existing) return existing;
    const task = this.queue.then(() => this.#run(event, signal, onRunnerState));
    this.inflight.set(event.event_id, task);
    this.queue = task.catch(() => {});
    return task;
  }

  async #persist(event, receipt) {
    await mkdir(this.receiptRoot, { recursive: true });
    const key = sha(event.event_id);
    const record = join(this.receiptRoot, `${key}.json`);
    const temp = join(this.receiptRoot, `.${key}.${randomUUID()}.tmp`);
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ event_id: event.event_id, receipt }), 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, record);
    await unlink(join(this.receiptRoot, `${key}.running`)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }

  async #existing(event) {
    try {
      const record = JSON.parse(await readFile(join(this.receiptRoot, `${sha(event.event_id)}.json`), 'utf8'));
      if (record.event_id !== event.event_id) throw new SolFault('CORRUPT', 'Receipt ID collision.');
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
      await writer.commit({ complete: true });
      return receipt;
    } catch (error) {
      await writer?.abort();
      receipt.status = 'error';
      receipt.reason = 'storage';
      receipt.evidence_handle = null;
      process.stderr.write(`Codex-SoL receipt archive failed: ${error.message ?? String(error)}\n`);
      return receipt;
    }
  }

  async #run(event, signal, onRunnerState) {
    const cached = await this.#existing(event);
    if (cached) return cached;
    await mkdir(this.receiptRoot, { recursive: true });
    const marker = await open(join(this.receiptRoot, `${sha(event.event_id)}.running`), 'wx', 0o600);
    try { await marker.writeFile(JSON.stringify({ event_id: event.event_id, started_at: new Date().toISOString() })); await marker.sync(); }
    finally { await marker.close(); }
    const selected = this.rules.filter((rule) => event.changed_paths.some((path) => rule.globs.some((glob) => matchesGlob(path, glob))));
    const configHash = sha(JSON.stringify(selected));
    if (signal?.aborted) {
      const receipt = receiptBase(event, configHash, 'error', interruptionReason(signal));
      await this.#archiveReceipt(event, receipt);
      await this.#persist(event, receipt);
      return receipt;
    }
    if (event.origin === 'validation') {
      const receipt = receiptBase(event, configHash, 'skipped', 'validation_origin');
      await this.#archiveReceipt(event, receipt);
      await this.#persist(event, receipt);
      return receipt;
    }
    if (!selected.length) {
      const receipt = receiptBase(event, configHash, 'skipped', 'no_rule');
      await this.#archiveReceipt(event, receipt);
      await this.#persist(event, receipt);
      return receipt;
    }
    let receipt;
    const checks = [];
    let validationKey = configHash;
    try {
      const globs = [...new Set(selected.flatMap((rule) => rule.watch_paths))];
      const before = await snapshotInputs(this.store.workspaceRoot, globs, this.generated, event.changed_paths);
      validationKey = sha(JSON.stringify({ input: before.items, rules: selected }));
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
          checks.push(result);
          if (result.status !== 'passed') stopped = true;
        }
      }
      const after = await snapshotInputs(this.store.workspaceRoot, globs, this.generated, event.changed_paths);
      const stale = before.sha256 !== after.sha256;
      const firstBad = checks.find((check) => check.status !== 'passed' && check.status !== 'skipped');
      const status = signal?.aborted ? 'error' : stale ? 'stale' : firstBad?.status ?? (checks.some((check) => check.reason === 'total_timeout') ? 'timeout' : 'passed');
      const reason = signal?.aborted ? interruptionReason(signal) : stale ? 'input_changed' : firstBad ? firstBad.reason : status === 'timeout' ? 'total_timeout' : 'all_checks_passed';
      receipt = receiptBase(event, validationKey, status, reason, checks);
    } catch (error) {
      receipt = receiptBase(event, validationKey, 'error', `runner:${error.code ?? error.message ?? String(error)}`, checks);
    }
    await this.#archiveReceipt(event, receipt);
    assertContract('ValidationReceipt', receipt);
    await this.#persist(event, receipt);
    return receipt;
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
