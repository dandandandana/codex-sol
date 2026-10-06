import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertContract } from './schema.mjs';
import { interruptionFault, SolFault } from './store.mjs';
import { fileFacts, fingerprintFileFacts, INPUT_FINGERPRINT_KIND, validateWorkspacePath } from './workspace.mjs';
export { INPUT_FINGERPRINT_KIND } from './workspace.mjs';

const pathKey = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
function check(signal) { if (signal?.aborted) throw interruptionFault(signal, 'Workspace snapshot was interrupted.'); }
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
export function matchesGlob(path, glob) { return globRegex(pathKey(glob)).test(pathKey(path)); }
/** Generated ancestors are excluded even for deleted seed paths. */
export function isGeneratedPath(path, patterns = []) {
  const parts = pathKey(path).split('/');
  return patterns.some((pattern) => {
    const normalized = pathKey(pattern);
    return parts.some((_, index) => {
      const ancestor = parts.slice(0, index + 1).join('/');
      return ancestor === normalized || ancestor.startsWith(`${normalized}/`) || matchesGlob(ancestor, normalized);
    });
  });
}
function excluded(path, generated) {
  const comparison = pathKey(path);
  return ['.git', '.codex/sol'].some((part) => comparison === part || comparison.startsWith(`${part}/`))
    || isGeneratedPath(path, generated);
}

/** Only fixed whole segments before the first wildcard justify pruning. A
 * directory need not match the file glob itself to contain matching descendants.
 * In particular a leading ** leaves every root eligible.
 */
function compileTraversal(globs) {
  const patterns = globs.map((glob) => {
    assertContract('WorkspaceGlob', glob);
    const segments = pathKey(glob).split('/');
    const wildcard = segments.findIndex((part) => /[*?]/u.test(part));
    return { regex: globRegex(pathKey(glob)), prefix: segments.slice(0, wildcard < 0 ? segments.length : wildcard).join('/') };
  });
  return {
    matches: (path) => patterns.some(({ regex }) => regex.test(pathKey(path))),
    descends: (path) => {
      const directory = pathKey(path);
      return patterns.some(({ prefix }) => !prefix || prefix === directory || prefix.startsWith(`${directory}/`) || directory.startsWith(`${prefix}/`));
    },
  };
}

async function listTree(root, plan, paths, prefix, generated, signal) {
  check(signal);
  const directory = prefix ? join(root, prefix) : root;
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new SolFault('SNAPSHOT_ERROR', `Input directory is not regular: ${prefix || '.'}`);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    check(signal);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (excluded(path, generated)) continue;
    const matches = plan.matches(path);
    const descends = plan.descends(path);
    if (!matches && !descends) continue;
    const stats = await lstat(join(root, path));
    if (stats.isSymbolicLink()) throw new SolFault('SNAPSHOT_ERROR', `Symlink in input tree: ${path}`);
    if (stats.isDirectory()) {
      if (descends) await listTree(root, plan, paths, path, generated, signal);
    } else if (stats.isFile()) {
      if (matches) paths.push(path);
    } else throw new SolFault('SNAPSHOT_ERROR', `Unsupported input type: ${path}`);
  }
  check(signal);
  const after = await lstat(directory, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino)
    throw new SolFault('WORKSPACE_CHANGED', 'Input directory changed during workspace traversal.');
}

export async function snapshotInputs(root, globs, generated = [], changedPaths = [], { signal } = {}) {
  const plan = compileTraversal(globs);
  generated.forEach((glob) => assertContract('WorkspaceGlob', glob));
  changedPaths.forEach(validateWorkspacePath);
  const all = [];
  await listTree(root, plan, all, '', generated, signal);
  const paths = [...new Set([...all, ...changedPaths])].filter((path) => !excluded(path, generated) && plan.matches(path)).sort();
  const items = [...(await fileFacts(root, paths, { signal })).values()];
  // Missing files found during traversal are drift; only explicit seeds can be missing.
  if (items.some((item) => item.type === 'missing' && !changedPaths.includes(item.path)))
    throw new SolFault('WORKSPACE_CHANGED', 'Input disappeared during workspace traversal.');
  check(signal);
  return { fingerprint_kind: INPUT_FINGERPRINT_KIND, items, sha256: fingerprintFileFacts(items) };
}

export async function digestChangedPaths(root, changedPaths, { signal } = {}) {
  changedPaths.forEach((path) => { assertContract('WorkspacePath', path); validateWorkspacePath(path); });
  const facts = await fileFacts(root, [...new Set(changedPaths)].sort(), { signal });
  return fingerprintFileFacts([...facts.values()]);
}

/** Verify the original body before interpretation. Legacy content-only snapshots
 * remain readable and keep their historical hashes; no mode is invented for them.
 * Consumers must deny new permission-sensitive reuse when the marker is absent.
 */
export function parseWorkspaceSnapshot(value) {
  const invalid = () => { throw new SolFault('CORRUPT', 'Workspace snapshot shape or fingerprint is invalid.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const modern = Object.hasOwn(value, 'fingerprint_kind');
  const keys = modern ? ['fingerprint_kind', 'items', 'sha256'] : ['items', 'sha256'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))
    || (modern && value.fingerprint_kind !== INPUT_FINGERPRINT_KIND) || !Array.isArray(value.items)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) invalid();
  const paths = new Set();
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid();
    try { validateWorkspacePath(item.path); } catch { invalid(); }
    if (paths.has(pathKey(item.path))) invalid();
    paths.add(pathKey(item.path));
    const expected = item.type === 'missing' ? ['path', 'type'] : modern ? ['path', 'type', 'sha256', 'mode'] : ['path', 'type', 'sha256'];
    if (!['file', 'missing'].includes(item.type) || Object.keys(item).length !== expected.length
      || Object.keys(item).some((key) => !expected.includes(key))) invalid();
    if (item.type === 'file' && (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)
      || (modern && item.mode !== null && (!Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777)))) invalid();
  }
  const digest = modern ? fingerprintFileFacts(value.items) : createHash('sha256').update(JSON.stringify(value.items)).digest('hex');
  if (value.sha256 !== digest) invalid();
  return value;
}
