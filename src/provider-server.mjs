import { constants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { RepositoryIndex } from './repository-index.mjs';
import { ArchitectureIndex, architectureQuerySchema } from './architecture/index.mjs';
import { readObservation } from './read.mjs';
import { recall } from './recall.mjs';
import { parseProviderConfig, createProviderPolicy, validateProviderRoots, canonicalProviderDigest, PROVIDER_V1_PROTOCOL, PROVIDER_V2_PROTOCOL } from './provider-policy.mjs';
import { createObservationStore, SolFault } from './store.mjs';
import { readWorkspaceBytes } from './workspace-read.mjs';
import { withWorkspaceLock } from './workspace-lock.mjs';

const PROTOCOL = PROVIDER_V1_PROTOCOL;
const CONFIG_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 4096;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function reply(value, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError };
}

function safeError(error) {
  if (error instanceof SolFault) return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
  };
  return { code: 'IO_ERROR', message: 'Provider operation failed.', retryable: false };
}

function errorReply(error) { return reply({ tool_status: 'error', error: safeError(error), raw: null }, true); }
function jsonBytes(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

function boundedQueryPacket(selected, { protocol, workspaceId, declaration, query, raw, pack }) {
  const packet = {
    schema_version: 1,
    kind: 'sol_component_discovery_query',
    protocol,
    workspace_id: workspaceId,
    declaration,
    query,
    ...selected,
    raw,
    observation: {
      mode: pack.mode,
      summary: pack.summary,
      excerpts: pack.excerpts,
      omitted_bytes: pack.omitted_bytes,
      reason: pack.reason,
    },
    omitted: [],
  };
  for (const field of ['candidates', 'impact', 'declared_impact', 'owners', 'uncovered', 'diagnostics']) {
    if (jsonBytes(packet) <= RESPONSE_LIMIT) break;
    if (Array.isArray(packet[field])) {
      packet[field + '_count'] = packet[field].length;
      delete packet[field];
      packet.omitted.push(field + ': recall raw');
    }
  }
  if (jsonBytes(packet) > RESPONSE_LIMIT) {
    delete packet.observation.excerpts;
    packet.observation.excerpts_omitted = true;
  }
  if (jsonBytes(packet) > RESPONSE_LIMIT) {
    delete packet.query;
    packet.query_omitted = true;
  }
  if (jsonBytes(packet) > RESPONSE_LIMIT) {
    delete packet.engine;
    packet.engine_omitted = true;
  }
  if (jsonBytes(packet) > RESPONSE_LIMIT) throw new SolFault('PROVIDER_BUDGET', 'Provider query view exceeds 4 KiB; narrow paths or capability.');
  return packet;
}

function boundedRepositoryPacket(result, raw, pack) {
  const coverage = Object.fromEntries(Object.entries(result.coverage).map(([name, value]) => [name, {
    status: value.status,
    count: value.count,
    reasons: value.reasons.slice(0, 4),
    ...(value.reasons.length > 4 ? { omitted_reasons: value.reasons.length - 4 } : {}),
  }]));
  let candidateLimit = Math.min(8, result.candidates.length);
  let packet;
  do {
    packet = {
      schema_version: 2,
      kind: 'repository_query_v2',
      protocol: result.protocol,
      mode: result.mode,
      workspace_id: result.workspace_id,
      scope_digest: result.scope_digest,
      exclusion_digest: result.exclusion_digest,
      inventory_digest: result.inventory_digest,
      collection_stable: result.collection_stable,
      query: result.query,
      coverage,
      sources_count: result.sources.length,
      candidates_count: result.candidates.length,
      candidates: result.candidates.slice(0, candidateLimit),
      relations_count: result.relations.length,
      unresolved_count: result.unresolved.length,
      exclusions_count: result.exclusions.length,
      raw,
      observation: { mode: pack.mode, summary: pack.summary, omitted_bytes: pack.omitted_bytes, reason: pack.reason },
    };
    if (jsonBytes(packet) <= RESPONSE_LIMIT || candidateLimit === 0) break;
    candidateLimit -= 1;
  } while (true);
  if (jsonBytes(packet) > RESPONSE_LIMIT) {
    delete packet.query;
    packet.query_omitted = true;
  }
  if (jsonBytes(packet) > RESPONSE_LIMIT) {
    delete packet.observation;
    packet.observation_omitted = true;
  }
  if (jsonBytes(packet) > RESPONSE_LIMIT) throw new SolFault('PROVIDER_BUDGET', 'Repository query view exceeds 4 KiB; inspect its raw evidence.');
  return packet;
}

function captureMeta(store, callId, tool, form = 'stream_bytes') {
  return {
    schema_version: 1,
    workspace_id: store.workspaceId,
    call_id: callId,
    tool,
    captured_at: new Date().toISOString(),
    media_type: form === 'response_json' ? 'application/json' : 'text/plain; charset=utf-8',
    encoding: 'utf-8',
    source_form: form,
    channel: 'response',
  };
}

async function* bufferChunks(bytes) {
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) yield bytes.subarray(offset, offset + 64 * 1024);
}

async function readBoundedConfig(path) {
  const absolute = resolve(path);
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size > CONFIG_LIMIT) {
    throw new SolFault('CONFIG_ERROR', 'Provider config must be a regular JSON file within 64 KiB.');
  }
  const file = await open(absolute, READ_FLAGS);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > CONFIG_LIMIT || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new SolFault('CONFIG_ERROR', 'Provider config changed while opening.');
    }
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(absolute);
    if (length > CONFIG_LIMIT || opened.size !== after.size || opened.size !== current.size
      || opened.mtimeMs !== after.mtimeMs || opened.mtimeMs !== current.mtimeMs
      || opened.ino !== after.ino || opened.ino !== current.ino) {
      throw new SolFault('CONFIG_ERROR', 'Provider config changed or exceeded 64 KiB while reading.');
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
    catch { throw new SolFault('CONFIG_ERROR', 'Provider config must be UTF-8 JSON.'); }
    try { return JSON.parse(text); }
    catch { throw new SolFault('CONFIG_ERROR', 'Provider config must be valid JSON.'); }
  } finally { await file.close(); }
}

function recallSchema() {
  return z.object({
    handle: z.string(),
    selector: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('lines'), start: z.number().int(), end: z.number().int() }).strict(),
      z.object({ kind: z.literal('keyword'), literal: z.string(), context_lines: z.number().int().min(0).max(10).optional() }).strict(),
      z.object({ kind: z.literal('bytes'), start: z.number().int(), end: z.number().int() }).strict(),
    ]),
    cursor: z.string().optional(),
  }).strict();
}

/**
 * Create the discovery-only MCP server. The workspace root must already exist;
 * options require a safe architecture_path, an operator-owned discovery_scope,
 * and a separate absolute cache_root. The returned server/store/policy are
 * caller-owned; close the server with server.close(). Query/read captures write
 * only to the explicit observation cache while using the normal workspace lock.
 */
export async function createProviderServer(workspaceRoot, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SolFault('CONFIG_ERROR', 'Provider options are invalid.');
  if (!Object.hasOwn(input, 'cache_root')) throw new SolFault('CONFIG_ERROR', 'Provider options contain unsupported fields.');
  const { cache_root: cacheRoot, ...configInput } = input;
  const config = parseProviderConfig(configInput);
  const repositoryMode = config.mode === 'repository';
  const exclusionDigest = repositoryMode
    ? canonicalProviderDigest({ excluded_paths: config.excluded_paths, excluded_sha256: config.excluded_sha256 })
    : null;
  if (typeof cacheRoot !== 'string' || !cacheRoot) throw new SolFault('CONFIG_ERROR', 'An explicit provider cache root is required.');

  let canonicalWorkspace;
  try { canonicalWorkspace = await realpath(resolve(workspaceRoot)); }
  catch { throw new SolFault('CONFIG_ERROR', 'Provider workspace root must exist.'); }
  const rootInfo = await lstat(canonicalWorkspace);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new SolFault('CONFIG_ERROR', 'Provider workspace root must be a regular directory.');

  if (repositoryMode) {
    const expectedWorkspaceId = sha(process.platform === 'win32' ? canonicalWorkspace.toLowerCase() : canonicalWorkspace);
    if (!isAbsolute(config.workspace_root) || config.workspace_root !== canonicalWorkspace || config.workspace_id !== expectedWorkspaceId) {
      throw new SolFault('CONFIG_ERROR', 'Repository provider workspace_root and workspace_id must match the startup workspace.');
    }
  }

  const policy = createProviderPolicy(canonicalWorkspace, config.discovery_scope, { mode: repositoryMode ? 'repository' : 'architecture' });
  await validateProviderRoots(canonicalWorkspace, config.discovery_scope);
  if (!repositoryMode) await policy.assertReadPath(config.architecture_path);
  const store = await createObservationStore(canonicalWorkspace, { cacheRoot });
  if (repositoryMode && store.workspaceId !== config.workspace_id) throw new SolFault('CONFIG_ERROR', 'Repository workspace identity differs from the observation store.');
  const declaration = repositoryMode ? null : await withWorkspaceLock(store, async () => {
    const declarationBytes = await readWorkspaceBytes(canonicalWorkspace, config.architecture_path, 256 * 1024);
    return { path: config.architecture_path, sha256: sha(declarationBytes) };
  });
  const experimental = repositoryMode ? {
    protocol: PROVIDER_V2_PROTOCOL,
    mode: 'repository',
    workspace_id: store.workspaceId,
    scope_digest: config.scope_digest,
    exclusion_digest: exclusionDigest,
    product_write: false,
    observation_cache: true,
  } : {
    protocol: PROTOCOL,
    workspace_id: store.workspaceId,
    declaration,
    product_write: false,
    observation_cache: true,
  };
  const server = new McpServer({ name: 'codex-sol-provider', version: '0.1.0' }, {
    capabilities: {
      tools: {},
      experimental: {
        'sol-component-discovery': experimental,
      },
    },
  });

  server.registerTool('sol_architecture_query', {
    title: 'Query registered architecture and static import facts',
    description: 'Select declared owners and capabilities from the configured index. The raw response manifest includes every indexed source path and SHA-256 fact; recall it before treating the bounded view as complete.',
    inputSchema: architectureQuerySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (inputArgs, context) => {
    const signal = context.mcpReq.signal;
    try {
      const args = architectureQuerySchema.parse(inputArgs);
      for (const path of args.paths) policy.assertScoped(path);
      const result = await withWorkspaceLock(store, async () => {
        if (repositoryMode) {
          const index = new RepositoryIndex(canonicalWorkspace, {
            policy,
            workspaceId: store.workspaceId,
            scopeDigest: config.scope_digest,
            budgets: config.budgets,
            excludedPaths: config.excluded_paths,
            excludedSha256: config.excluded_sha256,
          });
          const inventory = await index.load(args, { signal });
          const rawRecord = {
            schema_version: 2,
            kind: 'repository_query_v2',
            protocol: PROVIDER_V2_PROTOCOL,
            mode: 'repository',
            workspace_id: store.workspaceId,
            scope_digest: config.scope_digest,
            exclusion_digest: exclusionDigest,
            inventory_digest: inventory.inventory_digest,
            path_inventory: inventory.path_inventory,
            path_inventory_digest: inventory.path_inventory_digest,
            collection_stable: inventory.collection_stable,
            query: args,
            versions: inventory.versions,
            sources: inventory.sources,
            candidates: inventory.candidates,
            coverage: inventory.coverage,
            relations: inventory.relations,
            unresolved: inventory.unresolved,
            exclusions: inventory.exclusions,
          };
          const bytes = Buffer.from(JSON.stringify(rawRecord), 'utf8');
          const captured = await readObservation(store, captureMeta(store, randomUUID(), 'sol_architecture_query', 'response_json'),
            () => bufferChunks(bytes), { signal });
          if (captured.isError) return { value: captured.value, isError: true };
          const pack = captured.value.observation ?? captured.value;
          const raw = pack.raw?.[0] ?? null;
          if (!raw) throw new SolFault('STORAGE_ERROR', 'Provider observation did not publish a raw reference.');
          return { value: boundedRepositoryPacket(rawRecord, raw, pack), isError: false };
        }
        const index = new ArchitectureIndex(canonicalWorkspace, config.architecture_path);
        const snapshot = await index.load(signal, {
          validateReadPath: (path) => policy.assertReadPath(path, { allowMissing: true }),
        });
        const selected = index.select(snapshot, args);
        const declarationVersion = snapshot.versions.find((version) => version.path === config.architecture_path);
        const rawRecord = {
          schema_version: 1,
          kind: 'sol_component_discovery_query',
          protocol: PROTOCOL,
          workspace_id: store.workspaceId,
          declaration: { path: config.architecture_path, sha256: declarationVersion?.sha256 ?? null },
          query: args,
          versions: snapshot.versions,
          selected,
        };
        const bytes = Buffer.from(JSON.stringify(rawRecord), 'utf8');
        const captured = await readObservation(store, captureMeta(store, randomUUID(), 'sol_architecture_query', 'response_json'),
          () => bufferChunks(bytes), { signal });
        if (captured.isError) return { value: captured.value, isError: true };
        const pack = captured.value.observation ?? captured.value;
        const raw = pack.raw?.[0] ?? null;
        if (!raw) throw new SolFault('STORAGE_ERROR', 'Provider observation did not publish a raw reference.');
        return { value: boundedQueryPacket(selected, {
          protocol: PROTOCOL,
          workspaceId: store.workspaceId,
          declaration: rawRecord.declaration,
          query: args,
          raw,
          pack,
        }), isError: false };
      }, { signal });
      return reply(result.value, result.isError);
    } catch (error) { return errorReply(error); }
  });

  server.registerTool('sol_read_file', {
    title: 'Read one scoped workspace file with an observation record',
    description: 'Read an exact file inside the configured provider discovery scope. Its original bytes are archived and can be retrieved with sol_recall.',
    inputSchema: z.object({ path: z.string() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ path }, context) => {
    const signal = context.mcpReq.signal;
    const callId = randomUUID();
    try {
      const result = await withWorkspaceLock(store, async () => {
        const full = await policy.assertReadPath(path);
        if (repositoryMode) {
          const pathKey = process.platform === 'win32' ? path.toLowerCase() : path;
          if (config.excluded_paths.some((excluded) => (process.platform === 'win32' ? excluded.toLowerCase() : excluded) === pathKey)) {
            throw new SolFault('SECURITY_DENIED', 'Provider cannot deliver an authority document.');
          }
          const bytes = await readWorkspaceBytes(canonicalWorkspace, path, config.budgets.max_file_bytes, { signal });
          const digest = sha(bytes);
          if (config.excluded_sha256.includes(digest)) {
            throw new SolFault('SECURITY_DENIED', 'Provider cannot deliver an implementation verdict.');
          }
          return readObservation(store, captureMeta(store, callId, 'sol_read_file'),
            () => bufferChunks(bytes), { signal });
        }
        return readObservation(store, captureMeta(store, callId, 'sol_read_file'),
          ({ signal: readSignal }) => createReadStream(full, { signal: readSignal, highWaterMark: 64 * 1024 }), { signal });
      }, { signal });
      return reply(result.value, result.isError);
    } catch (error) { return errorReply(error); }
  });

  server.registerTool('sol_recall', {
    title: 'Recall exact archived response bytes or lines',
    description: 'Recall the exact original bytes from an opaque raw handle. Lines are 1-based inclusive; bytes are 0-based with an exclusive end. Follow next_cursor using the same selector.',
    inputSchema: recallSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ handle, selector, cursor }, context) => {
    const signal = context.mcpReq.signal;
    try {
      const value = await withWorkspaceLock(store, () => recall(store, {
        schema_version: 1,
        handle,
        selector,
        ...(cursor ? { cursor } : {}),
      }, { signal }), { signal });
      return reply(value);
    } catch (error) { return errorReply(error); }
  });

  return { server, store, policy };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--workspace', '--config', '--cache-root'].includes(flag) || !value || value.startsWith('--') || values.has(flag)) {
      throw new Error('Usage: node src/provider-server.mjs --workspace <root> --config <bounded JSON file> --cache-root <root>');
    }
    values.set(flag, value);
  }
  if (values.size !== 3) throw new Error('Usage: node src/provider-server.mjs --workspace <root> --config <bounded JSON file> --cache-root <root>');
  return { workspace: resolve(values.get('--workspace')), config: resolve(values.get('--config')), cache_root: resolve(values.get('--cache-root')) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const config = await readBoundedConfig(args.config);
    const { server } = await createProviderServer(args.workspace, { ...config, cache_root: args.cache_root });
    serveStdio(() => server, { onerror: (error) => process.stderr.write(`${error.message}\n`) });
  } catch (error) {
    process.stderr.write(`SoL provider failed: ${error.message ?? String(error)}\n`);
    process.exitCode = 2;
  }
}
