import { z } from 'zod';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { SolFault } from './store.mjs';
import { validateWorkspacePath, workspaceFile } from './workspace-read.mjs';

export const PROVIDER_V1_PROTOCOL = 'sol-component-discovery/1';
export const PROVIDER_V2_PROTOCOL = 'sol-component-discovery/2';

const v1ScopeSchema = z.object({
  roots: z.array(z.string().min(1).max(256)).max(128),
  files: z.array(z.string().min(1).max(256)).max(256),
}).strict();

const repositoryScopeSchema = z.object({
  roots: z.array(z.string().min(1).max(256)).max(128),
  files: z.array(z.string().min(1).max(256)).max(256),
}).strict();

const configSchema = z.object({
  architecture_path: z.string().min(1).max(256),
  discovery_scope: v1ScopeSchema,
}).strict();

const repositoryConfigSchema = z.object({
  protocol: z.literal(PROVIDER_V2_PROTOCOL),
  mode: z.literal('repository'),
  workspace_root: z.string().min(1).max(4096),
  workspace_id: z.string().regex(/^[a-f0-9]{64}$/u),
  discovery_scope: repositoryScopeSchema,
  scope_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  budgets: z.object({
    max_sources: z.number().int().min(1).max(128),
    max_file_bytes: z.number().int().min(1).max(262144),
    max_total_bytes: z.number().int().min(1).max(1048576),
    timeout_ms: z.number().int().min(100).max(30000),
  }).strict(),
  excluded_paths: z.array(z.string().min(1).max(256)).max(64).default([]),
  excluded_sha256: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(128).default([]),
}).strict();

const CONTROL_DIRECTORIES = new Set(['.git', '.codex', '.hg', '.svn']);
const SECRET_DIRECTORIES = new Set(['.aws', '.azure', '.docker', '.gnupg', '.kube', '.ssh', 'keyrings']);
const SECRET_FILES = new Set([
  '.git-credentials', '.netrc', '.npmrc', '.pypirc', 'credentials', 'credentials.json',
  'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_rsa', 'secrets', 'secrets.json', 'token', 'token.json',
]);
const SECRET_EXTENSIONS = new Set(['.jks', '.kdbx', '.key', '.keystore', '.p12', '.pfx', '.pem']);
const SAFE_ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template', '.env.test.example']);

function pathKey(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalProviderDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function validatePathSyntax(path, { allowWorkspaceRoot = false } = {}) {
  if (allowWorkspaceRoot && path === '.') return path;
  try { validateWorkspacePath(path); }
  catch { throw new SolFault('PATH_ERROR', 'Provider path must be a safe workspace-relative path.'); }
  const segments = path.split('/');
  const lower = segments.map((part) => part.toLowerCase());
  if (lower.some((part) => CONTROL_DIRECTORIES.has(part))) {
    throw new SolFault('SECURITY_DENIED', 'Provider cannot read workspace control data.');
  }
  if (lower.some((part) => SECRET_DIRECTORIES.has(part))) {
    throw new SolFault('SECURITY_DENIED', 'Provider cannot read credential directories.');
  }
  const name = lower.at(-1);
  const extensionAt = name.lastIndexOf('.');
  const extension = extensionAt > 0 ? name.slice(extensionAt) : '';
  if (SECRET_FILES.has(name) || SECRET_EXTENSIONS.has(extension)
    || /^\.env(?:\..+)?$/u.test(name) && !SAFE_ENV_EXAMPLES.has(name)) {
    throw new SolFault('SECURITY_DENIED', 'Provider cannot read credential files.');
  }
  return path;
}

/** Explicitly excluded paths remain visible in repository inventory without opening them. */
export function providerPathExclusionReason(path) {
  const lower = path.split('/').map((part) => part.toLowerCase());
  if (lower.some((part) => CONTROL_DIRECTORIES.has(part))) return 'control_directory';
  if (lower.some((part) => SECRET_DIRECTORIES.has(part))) return 'secret_directory';
  const name = lower.at(-1);
  const extensionAt = name.lastIndexOf('.');
  const extension = extensionAt > 0 ? name.slice(extensionAt) : '';
  if (SECRET_FILES.has(name) || SECRET_EXTENSIONS.has(extension)
    || /^\.env(?:\..+)?$/u.test(name) && !SAFE_ENV_EXAMPLES.has(name)) return 'secret_file';
  return null;
}

function scopeContains(path, scope) {
  const candidate = pathKey(path);
  if (scope.files.has(candidate)) return true;
  return [...scope.roots].some((root) => root === '.' || candidate === root || candidate.startsWith(`${root}/`));
}

export function parseProviderConfig(input) {
  if (input && typeof input === 'object' && ('protocol' in input || 'mode' in input)) {
    const parsed = repositoryConfigSchema.safeParse(input);
    if (!parsed.success) throw new SolFault('CONFIG_ERROR', 'Repository provider config must match the bounded sol-component-discovery/2 repository contract.');
    const roots = parsed.data.discovery_scope.roots.map((path) => validatePathSyntax(path, { allowWorkspaceRoot: true }));
    const files = parsed.data.discovery_scope.files.map((path) => validatePathSyntax(path));
    const excludedPaths = parsed.data.excluded_paths.map((path) => {
      try { return validateWorkspacePath(path); }
      catch { throw new SolFault('CONFIG_ERROR', 'Provider excluded_paths must contain safe exact workspace-relative paths.'); }
    });
    const rootKeys = roots.map(pathKey);
    const fileKeys = files.map(pathKey);
    const excludedPathKeys = excludedPaths.map(pathKey);
    if (new Set(rootKeys).size !== rootKeys.length || new Set(fileKeys).size !== fileKeys.length) {
      throw new SolFault('CONFIG_ERROR', 'Provider discovery_scope contains duplicate paths.');
    }
    if (new Set(excludedPathKeys).size !== excludedPathKeys.length
      || new Set(parsed.data.excluded_sha256).size !== parsed.data.excluded_sha256.length) {
      throw new SolFault('CONFIG_ERROR', 'Provider exclusions contain duplicate paths or SHA-256 values.');
    }
    if (!roots.length && !files.length) throw new SolFault('CONFIG_ERROR', 'Provider discovery_scope must allow at least one read path.');
    const discoveryScope = { roots, files };
    if (canonicalProviderDigest(discoveryScope) !== parsed.data.scope_digest) {
      throw new SolFault('CONFIG_ERROR', 'Provider scope_digest does not match discovery_scope.');
    }
    return {
      ...parsed.data,
      discovery_scope: discoveryScope,
      excluded_paths: excludedPaths,
    };
  }
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new SolFault('CONFIG_ERROR', 'Provider config must contain only architecture_path and a bounded discovery_scope.');
  const architecturePath = validatePathSyntax(parsed.data.architecture_path);
  const roots = parsed.data.discovery_scope.roots.map(validatePathSyntax);
  const files = parsed.data.discovery_scope.files.map(validatePathSyntax);
  const rootKeys = roots.map(pathKey);
  const fileKeys = files.map(pathKey);
  if (new Set(rootKeys).size !== rootKeys.length || new Set(fileKeys).size !== fileKeys.length) {
    throw new SolFault('CONFIG_ERROR', 'Provider discovery_scope contains duplicate paths.');
  }
  if (!roots.length && !files.length) throw new SolFault('CONFIG_ERROR', 'Provider discovery_scope must allow at least one read path.');
  return {
    architecture_path: architecturePath,
    discovery_scope: { roots, files },
  };
}

export async function validateProviderRoots(workspaceRoot, discoveryScope) {
  const parsed = v1ScopeSchema.safeParse(discoveryScope);
  if (!parsed.success) throw new SolFault('CONFIG_ERROR', 'Provider discovery_scope is invalid.');
  for (const root of parsed.data.roots) {
    validatePathSyntax(root, { allowWorkspaceRoot: allowWorkspaceRootFor(root) });
    if (root === '.') continue;
    let current = workspaceRoot;
    for (const segment of root.split('/')) {
      current = join(current, segment);
      let info;
      try { info = await lstat(current); }
      catch { throw new SolFault('CONFIG_ERROR', 'Every configured discovery root must exist as a regular directory.'); }
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new SolFault('SECURITY_DENIED', 'Discovery roots may not traverse symbolic links or files.');
      }
    }
  }
}

function allowWorkspaceRootFor(root) { return root === '.'; }

export function createProviderPolicy(workspaceRoot, discoveryScope, { mode = 'architecture' } = {}) {
  const isRepository = mode === 'repository';
  const parsed = (isRepository ? repositoryScopeSchema : v1ScopeSchema).safeParse(discoveryScope);
  if (!parsed.success) throw new SolFault('CONFIG_ERROR', 'Provider discovery_scope is invalid.');
  const roots = new Set(parsed.data.roots.map((path) => pathKey(validatePathSyntax(path, { allowWorkspaceRoot: isRepository }))));
  const files = new Set(parsed.data.files.map((path) => pathKey(validatePathSyntax(path))));
  if (!roots.size && !files.size) throw new SolFault('CONFIG_ERROR', 'Provider discovery_scope must allow at least one read path.');
  const scope = { roots, files };

  function assertScoped(path) {
    validatePathSyntax(path);
    if (!scopeContains(path, scope)) throw new SolFault('DISCOVERY_SCOPE_DENIED', 'Provider path is outside the configured read scope.');
    return path;
  }

  return Object.freeze({
    mode,
    discovery_scope: parsed.data,
    assertScoped,
    async assertReadPath(path, { allowMissing = false } = {}) {
      assertScoped(path);
      return workspaceFile(workspaceRoot, path, { allowMissing });
    },
  });
}
