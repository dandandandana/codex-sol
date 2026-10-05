import { readFile, mkdir, open, lstat, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createObservationStore, SolFault } from './store.mjs';
import { ValidationEngine } from './validation.mjs';
import { runManagedCommand, publicError } from './managed-command.mjs';
import { assertContract } from './schema.mjs';
import { writeAtomicJSON } from './workspace.mjs';

const ENTRY = fileURLToPath(import.meta.url);
const quotePS = (value) => `'${value.replaceAll("'", "''")}'`;
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function readJSON(path, maxBytes = 131072) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new SolFault('CONFIG_ERROR', 'Expected a regular, bounded JSON file.');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function loadNativeConfig(path) {
  const config = assertContract('NativeConfig', await readJSON(path));
  if (process.platform !== 'win32') throw new SolFault('CONFIG_ERROR', 'Native tool integration currently supports Windows only.');
  for (const key of ['workspace', 'rules', 'node', 'shell']) {
    if (!isAbsolute(config[key])) throw new SolFault('CONFIG_ERROR', `Native config ${key} must be an absolute path.`);
  }
  config.workspace = await realpath(config.workspace);
  for (const key of ['node', 'shell']) {
    if (!(await lstat(config[key])).isFile()) throw new SolFault('CONFIG_ERROR', `Native config ${key} must be an executable file.`);
  }
  const store = await createObservationStore(config.workspace);
  const rules = assertContract('RulesConfig', await readJSON(config.rules));
  const validator = new ValidationEngine(store, rules, { generated: config.generated });
  const spool = join(store.solRoot, 'native');
  await mkdir(spool, { recursive: true });
  if ((await lstat(spool)).isSymbolicLink()) throw new SolFault('PATH_ERROR', 'Native request directory must not be a link.');
  return { config, store, validator, spool };
}

function keyFor(event) {
  for (const key of ['session_id', 'tool_use_id']) if (typeof event[key] !== 'string' || !event[key] || event[key].length > 4096) throw new SolFault('INPUT_ERROR', `Hook event requires ${key}.`);
  return sha(JSON.stringify([event.session_id, event.tool_use_id]));
}

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

/** Only rewrites native shell input; no arbitrary shell tool is exposed over MCP. */
export async function handleNativeHook(event, configPath) {
  if (!event || typeof event !== 'object') throw new SolFault('INPUT_ERROR', 'Hook input must be an object.');
  if (event.hook_event_name === 'SessionStart') return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Codex-SoL is enabled for this Windows project. For context patches use codex_sol.sol_apply_patch with the normal Begin Patch format. Native apply_patch is routed by denial to that tool. For full writes/deletes use sol_apply_changes; for file reads and exact archived output use sol_read_file / sol_recall. Ordinary Shell calls are wrapped under the host shell permissions. Read tool_status, execution and validation separately; never describe failed, stale, timeout or interrupted receipts as passed.' } };
  if (event.hook_event_name === 'PreToolUse' && ['apply_patch', 'Edit', 'Write'].includes(event.tool_name)) return deny('Use codex_sol.sol_apply_patch with the same context patch to receive a Validation Receipt. Native apply_patch cannot be switched to another tool by a Hook.');
  if (event.tool_name !== 'Bash') return {};
  try {
    const { config, spool } = await loadNativeConfig(configPath);
    const key = keyFor(event);
    const requestPath = join(spool, `${key}.request.json`);
    const resultPath = join(spool, `${key}.result.json`);
    if (event.hook_event_name === 'PreToolUse') {
      const command = event.tool_input?.command;
      if (typeof command !== 'string' || !command.trim() || command.length > 8000) return deny('Shell middleware requires a command of 1–8000 characters. Split larger operations or use sol_apply_patch / sol_apply_changes.');
      const request = { schema_version: 1, config: resolve(configPath), call_id: key, command };
      try {
        const file = await open(requestPath, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(request)); await file.sync(); }
        finally { await file.close(); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = assertContract('NativeRequest', await readJSON(requestPath));
        if (JSON.stringify(existing) !== JSON.stringify(request)) return deny('A different command already uses this tool call ID. It will not be replayed.');
      }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...event.tool_input, command: `& ${quotePS(config.node)} ${quotePS(ENTRY)} --run ${quotePS(requestPath)}` } } };
    }
    if (event.hook_event_name === 'PostToolUse') {
      let value;
      try { value = await readJSON(resultPath, 16384); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        value = { tool_status: 'error', error: { code: 'INTERRUPTED', message: 'The native runner has no committed result. Execution may have occurred; do not replay this call automatically.', retryable: false } };
      }
      // The runner emits bounded JSON on success. On failure the host may drop
      // stdout, so the committed result becomes explicit blocking feedback.
      return value.tool_status === 'ok' ? {} : { decision: 'block', reason: JSON.stringify(value) };
    }
    return {};
  } catch (error) {
    return event.hook_event_name === 'PreToolUse' ? deny(`Codex-SoL middleware is unavailable: ${publicError(error).message}`) : { decision: 'block', reason: JSON.stringify({ tool_status: 'error', error: publicError(error) }) };
  }
}

export async function runNativeRequest(requestPath, { signal } = {}) {
  const request = assertContract('NativeRequest', await readJSON(requestPath));
  const { config, store, validator, spool } = await loadNativeConfig(request.config);
  if (resolve(requestPath) !== join(spool, `${request.call_id}.request.json`)) throw new SolFault('PATH_ERROR', 'Native request path does not belong to this workspace.');
  const resultPath = join(spool, `${request.call_id}.result.json`);
  try { return await readJSON(resultPath, 16384); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const marker = await open(join(spool, `${request.call_id}.running`), 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') throw new SolFault('RECOVERY_REQUIRED', 'This native call already started without a committed result. Inspect its evidence; it will not be replayed.');
    throw error;
  });
  try { await marker.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })); await marker.sync(); }
  finally { await marker.close(); }
  // Preserve the host-selected working directory and its sandbox/token. The
  // configured PowerShell version and profile setting are part of this adapter.
  const actualCwd = await realpath(process.cwd());
  const cwd = relative(store.workspaceRoot, actualCwd);
  if (cwd === '..' || cwd.startsWith(`..${sep}`) || isAbsolute(cwd)) throw new SolFault('PATH_ERROR', 'Native Shell cwd is outside the configured workspace.');
  const argv = [config.shell];
  if (!config.load_profile) argv.push('-NoProfile');
  argv.push('-NonInteractive', '-EncodedCommand', Buffer.from(request.command, 'utf16le').toString('base64'));
  const result = await runManagedCommand(store, validator, { argv, cwd: cwd.split(sep).join('/') || '.', timeout_ms: config.timeout_ms }, { tool: 'Bash', generated: config.generated, signal, callId: request.call_id });
  await writeAtomicJSON(resultPath, result);
  await unlink(join(spool, `${request.call_id}.running`));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === ENTRY) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    if (process.argv[2] === '--run') {
      const value = await runNativeRequest(process.argv[3], { signal: controller.signal });
      process.stdout.write(`${JSON.stringify(value)}\n`);
      process.exitCode = value.execution?.exit_code ?? (value.tool_status === 'ok' ? 0 : 1);
      if (value.tool_status !== 'ok' && process.exitCode === 0) process.exitCode = 1;
    } else if (process.argv[2] === '--config') {
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new SolFault('INPUT_ERROR', 'Hook input exceeds 2 MiB.');
      }
      process.stdout.write(`${JSON.stringify(await handleNativeHook(JSON.parse(input), process.argv[3]))}\n`);
    } else throw new SolFault('CONFIG_ERROR', 'Use --config <native.json> or --run <request.json>.');
  } catch (error) {
    process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
    process.exitCode = process.argv[2] === '--config' ? 2 : 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
