import { readFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { createObservationStore, interruptionFault, SolFault } from './store.mjs';
import { ValidationEngine, digestChangedPaths, receiptSummary } from './validation.mjs';
import { recall } from './recall.mjs';
import { readObservation } from './read.mjs';
import { withWorkspaceLock } from './workspace-lock.mjs';
import { assertContract } from './schema.mjs';

import { workspaceFile, fileState } from './workspace.mjs';
import { applyManagedPatch } from './patch.mjs';
import { withHostCancellation } from './host-cancellation.mjs';

function fail(code, message) { throw new SolFault(code, message); }
function reply(value, isError = false) { return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError }; }
function safeError(error) {
  return { code: error instanceof SolFault ? error.code : 'IO_ERROR', message: error.message ?? String(error), retryable: error instanceof SolFault ? error.retryable : false };
}

async function applyChanges(root, changes, signal) {
  const paths = changes.map((item) => item.path);
  if (new Set(paths).size !== paths.length) fail('PATH_ERROR', 'Each path may appear only once per call.');
  for (const path of paths) await workspaceFile(root, path, { allowMissing: true });
  const before = await fileState(root, paths);
  let error = null;
  for (const change of changes) {
    if (signal?.aborted) { error = interruptionFault(signal, 'Managed modification was interrupted.'); break; }
    let temporary;
    try {
      const full = await workspaceFile(root, change.path, { allowMissing: true });
      if (change.action === 'delete') {
        await unlink(full);
      } else {
        await mkdir(dirname(full), { recursive: true });
        temporary = join(dirname(full), `.codex-sol-${randomUUID()}.tmp`);
        await writeFile(temporary, change.content, { flag: 'wx', mode: 0o600 });
        await rename(temporary, full);
        temporary = null;
      }
    } catch (cause) {
      error = cause;
      if (temporary) await unlink(temporary).catch(() => {});
      break;
    }
  }
  const after = await fileState(root, paths);
  const changed = paths.filter((path) => before.get(path) !== after.get(path));
  return { changed, error };
}

function captureMeta(store, callId, tool, form = 'stream_bytes') {
  return { schema_version: 1, workspace_id: store.workspaceId, call_id: callId, tool, captured_at: new Date().toISOString(), media_type: form === 'response_json' ? 'application/json' : 'text/plain; charset=utf-8', encoding: 'utf-8', source_form: form, channel: 'response' };
}

export async function createSolServer(workspaceRoot, rulesConfig, options = {}) {
  const store = await createObservationStore(workspaceRoot);
  assertContract('RulesConfig', rulesConfig);
  const validator = new ValidationEngine(store, rulesConfig, options);
  const server = new McpServer({ name: 'codex-sol', version: '0.1.0' });

  server.registerTool('sol_apply_patch', {
    title: 'Apply a Codex context patch and validate',
    description: 'Use this for ordinary file patches. Accepts the same Begin Patch / Update File format as apply_patch, uses the installed Codex patch engine, and returns actual changes plus a synchronous Validation Receipt.',
    inputSchema: z.object({ patch: z.string() }).strict(),
  }, async ({ patch }, context) => {
    try {
      const result = await withHostCancellation(store, options, context, (signal) => applyManagedPatch(store, validator, patch, { executable: options.patchExecutable, generated: options.generated, signal }));
      return reply(result, result.tool_status !== 'ok');
    } catch (error) { return reply({ tool_status: 'error', error: safeError(error), changed_paths: [] }, true); }
  });

  server.registerTool('sol_apply_changes', {
    title: 'Apply workspace file changes and validate',
    description: 'Write or delete workspace files, detect actual changes, then synchronously run configured checks. Use this for changes that require a Validation Receipt.',
    inputSchema: z.object({ changes: z.array(z.discriminatedUnion('action', [z.object({ action: z.literal('write'), path: z.string(), content: z.string() }).strict(), z.object({ action: z.literal('delete'), path: z.string() }).strict()])).min(1).max(50) }).strict(),
  }, async ({ changes }, context) => {
    let applied = { changed: [], error: null };
    let receipt = null;
    return withHostCancellation(store, options, context, (signal) => withWorkspaceLock(store, async (lease) => {
      const callId = randomUUID();
      let result;
      try { result = await applyChanges(store.workspaceRoot, changes, signal); }
      catch (error) { return reply({ tool_status: 'error', error: safeError(error), changed_paths: [] }, true); }
      applied = result;
      if (result.changed.length) {
        try {
          const event = { schema_version: 1, event_id: randomUUID(), workspace_id: store.workspaceId, call_id: callId, origin: 'agent', changed_paths: [...result.changed].sort(), change_digest: await digestChangedPaths(store.workspaceRoot, result.changed) };
          assertContract('ChangeEvent', event);
          receipt = receiptSummary(await validator.onChange(event, { signal, onRunnerState: lease.setRunner }));
        } catch (error) {
          return reply({ tool_status: 'error', changed_paths: result.changed, validation_error: safeError(error), upstream_error: result.error ? safeError(result.error) : null }, true);
        }
      }
      return reply({ tool_status: result.error ? 'error' : 'ok', changed_paths: result.changed, validation: receipt, upstream_error: result.error ? safeError(result.error) : null }, !!result.error);
    }, { signal })).catch((error) => reply({ tool_status: 'error', error: safeError(error), changed_paths: applied.changed, validation: receipt, upstream_error: applied.error ? safeError(applied.error) : null }, true));
  });

  server.registerTool('sol_read_file', {
    title: 'Read workspace file with bounded observation',
    description: 'Read a workspace text file through ObservationPack; exact raw bytes remain retrievable with sol_recall.',
    inputSchema: z.object({ path: z.string() }).strict(),
  }, async ({ path }, context) => {
    const callId = randomUUID();
    try {
      const full = await workspaceFile(store.workspaceRoot, path);
      const result = await withHostCancellation(store, options, context, (signal) => readObservation(store, captureMeta(store, callId, 'sol_read_file'), ({ signal: readSignal }) => createReadStream(full, { signal: readSignal }), { signal }));
      return reply(result.value, result.isError);
    } catch (error) {
      return reply({ tool_status: 'error', error: safeError(error), raw: null }, true);
    }
  });

  server.registerTool('sol_recall', {
    title: 'Recall exact observation bytes or lines',
    description: 'Recall archived output by opaque handle. Supports line ranges, case-sensitive literal search, and exact byte ranges.',
    inputSchema: z.object({ handle: z.string(), selector: z.discriminatedUnion('kind', [z.object({ kind: z.literal('lines'), start: z.number().int(), end: z.number().int() }).strict(), z.object({ kind: z.literal('keyword'), literal: z.string(), context_lines: z.number().int().min(0).max(10).optional() }).strict(), z.object({ kind: z.literal('bytes'), start: z.number().int(), end: z.number().int() }).strict()]), cursor: z.string().optional() }).strict(),
  }, async ({ handle, selector, cursor }) => {
    try { return reply(await recall(store, { schema_version: 1, handle, selector, ...(cursor ? { cursor } : {}) })); }
    catch (error) { return reply({ schema_version: 1, ...safeError(error) }, true); }
  });

  return { server, store, validator };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const workspace = process.env.CODEX_SOL_WORKSPACE;
  const configPath = process.env.CODEX_SOL_RULES;
  if (!workspace || !configPath) {
    process.stderr.write('CODEX_SOL_WORKSPACE and CODEX_SOL_RULES are required.\n');
    process.exitCode = 2;
  } else {
    try {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      const generated = JSON.parse(process.env.CODEX_SOL_GENERATED_PATHS ?? '[]');
      if (!Array.isArray(generated)) throw new TypeError('CODEX_SOL_GENERATED_PATHS must be a JSON array.');
      generated.forEach((path) => assertContract('WorkspaceGlob', path));
      const { server } = await createSolServer(workspace, config, { generated, patchExecutable: process.env.CODEX_SOL_PATCH_EXECUTABLE, hostExecutable: process.env.CODEX_SOL_HOST_EXECUTABLE });
      serveStdio(() => server, { onerror: (error) => process.stderr.write(`${error.message}\n`) });
    } catch (error) {
      process.stderr.write(`Codex-SoL startup failed: ${error.message}\n`);
      process.exitCode = 2;
    }
  }
}
