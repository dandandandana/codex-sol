import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { assertOutputSafe, collectInventoryFiles, copyChecked, physicalTarget } from './package-plugin.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const ENTRY = 'src/provider-server.mjs';
const MANIFEST = 'provider-manifest.json';
const PROTOCOL = 'sol-component-discovery/1';
const PROTOCOLS = ['sol-component-discovery/1', 'sol-component-discovery/2'];
const MODES = ['registered', 'repository'];
const ASSETS = ['runtime.schema.json'];
const SOURCE_ALLOWLIST = new Set([
  'src/architecture/index.mjs',
  'src/pack.mjs',
  'src/provider-policy.mjs',
  'src/provider-server.mjs',
  'src/repository-index.mjs',
  'src/read.mjs',
  'src/recall.mjs',
  'src/schema.mjs',
  'src/store.mjs',
  'src/workspace-lock.mjs',
  'src/workspace-read.mjs',
  'vendor/normify/engine/changes.js',
  'vendor/normify/engine/compile.js',
  'vendor/normify/engine/diag.js',
  'vendor/normify/engine/frontmatter.js',
  'vendor/normify/engine/ids.js',
  'vendor/normify/engine/layout.js',
  'vendor/normify/engine/policy.js',
  'vendor/normify/engine/store.js',
  'vendor/normify/engine/types.js',
  'vendor/normify/engine/validate.js',
]);
const DEPENDENCY_ALLOWLIST = new Set([
  '@modelcontextprotocol/core', '@modelcontextprotocol/server', 'acorn', 'ajv',
  'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string', 'uri-js', 'yaml', 'zod',
]);

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path));
}

function repoPath(path) { return relative(REPO_ROOT, path).replaceAll('\\', '/'); }

function assertAllowedSource(path) {
  const relativePath = repoPath(path);
  if (!SOURCE_ALLOWLIST.has(relativePath)) throw new Error('Provider source is outside the independent runtime allowlist: ' + relativePath);
  return relativePath;
}

function packageName(specifier) {
  if (specifier.startsWith('node:') || builtinModules.includes(specifier)) return null;
  if (specifier.startsWith('.') || isAbsolute(specifier)) return null;
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function staticSpecifiers(source, path) {
  let ast;
  try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); }
  catch (error) { throw new Error('Provider source cannot be parsed for import closure: ' + path + ' (' + error.message + ')'); }
  const found = new Set();
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      found.add(node.source.value);
    } else if (node.type === 'ImportExpression') {
      if (node.source?.type !== 'Literal' || typeof node.source.value !== 'string') {
        throw new Error('Provider runtime contains an unresolved dynamic import: ' + path);
      }
      found.add(node.source.value);
    } else if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') {
      if (node.arguments.length !== 1 || node.arguments[0]?.type !== 'Literal' || typeof node.arguments[0].value !== 'string') {
        throw new Error('Provider runtime contains an unresolved dynamic require: ' + path);
      }
      found.add(node.arguments[0].value);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue;
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === 'object') stack.push(value);
    }
  }
  return [...found];
}

async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Provider input must be a regular file: ' + repoPath(path));
  return info;
}

async function resolveLocalImport(fromPath, specifier) {
  const base = resolve(dirname(fromPath), specifier);
  const candidates = [base];
  if (!extname(base)) candidates.push(base + '.mjs', base + '.js', base + '.cjs', base + '.json', join(base, 'index.mjs'), join(base, 'index.js'), join(base, 'index.cjs'));
  for (const candidate of candidates) {
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error('Provider import traverses a symbolic link: ' + repoPath(candidate));
      if (info.isFile()) return candidate;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('Provider local import could not be resolved: ' + specifier + ' from ' + repoPath(fromPath));
}

async function collectSourceClosure(repoRoot) {
  const files = new Set();
  const dependencies = new Set();
  const pending = [join(repoRoot, ENTRY)];
  while (pending.length) {
    const path = pending.pop();
    const relativePath = assertAllowedSource(path);
    if (files.has(relativePath)) continue;
    const info = await regularFile(path);
    const source = await readFile(path, 'utf8');
    files.add(relativePath);
    if (!/\.(?:mjs|js|cjs)$/u.test(relativePath)) continue;
    for (const specifier of staticSpecifiers(source, relativePath)) {
      if (specifier.startsWith('.') || isAbsolute(specifier)) {
        const resolvedPath = await resolveLocalImport(path, specifier);
        if (!isWithin(repoRoot, resolvedPath)) throw new Error('Provider local import escapes its repository: ' + specifier);
        pending.push(resolvedPath);
      } else {
        const name = packageName(specifier);
        if (name) dependencies.add(name);
      }
    }
    if (info.size < 0) throw new Error('Provider input file has an invalid size.');
  }
  return { files: [...files].sort(), dependencies: [...dependencies].sort() };
}

async function findInstalledPackage(name, fromDirectory, repoRoot) {
  let current = fromDirectory;
  while (isWithin(repoRoot, current)) {
    const candidate = join(current, 'node_modules', ...name.split('/'));
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Provider dependency is not a regular package directory: ' + name);
      return candidate;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === repoRoot) break;
    current = dirname(current);
  }
  throw new Error('Provider runtime dependency is not installed: ' + name);
}

async function collectDependencyClosure(repoRoot, directDependencies, lock) {
  const packages = new Map();
  const pending = directDependencies.map((name) => ({ name, fromDirectory: repoRoot, optional: false }));
  while (pending.length) {
    const { name, fromDirectory, optional } = pending.pop();
    if (!DEPENDENCY_ALLOWLIST.has(name)) throw new Error('Provider dependency is outside the independent runtime allowlist: ' + name);
    let packageRoot;
    try { packageRoot = await findInstalledPackage(name, fromDirectory, repoRoot); }
    catch (error) { if (optional && /not installed/u.test(error.message)) continue; throw error; }
    const relativeDirectory = repoPath(packageRoot);
    const lockKey = relativeDirectory.replaceAll('\\', '/');
    const lockEntry = lock.packages?.[lockKey];
    if (!lockEntry) throw new Error('Provider dependency is not recorded in package-lock.json: ' + lockKey);
    const metaPath = join(packageRoot, 'package.json');
    await regularFile(metaPath);
    const metadata = JSON.parse(await readFile(metaPath, 'utf8'));
    if (metadata.name !== name || metadata.version !== lockEntry.version) throw new Error('Provider dependency does not match the locked package identity: ' + name);
    if (packages.has(lockKey)) continue;
    packages.set(lockKey, { root: packageRoot, name, lockKey, lockEntry, metadata });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) pending.push({ name: dependency, fromDirectory: packageRoot, optional: false });
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) pending.push({ name: dependency, fromDirectory: packageRoot, optional: true });
  }
  return [...packages.values()].sort((a, b) => a.lockKey.localeCompare(b.lockKey));
}

async function copyRuntimeFile(repoRoot, target, relativePath) {
  const source = join(repoRoot, ...relativePath.split('/'));
  await regularFile(source);
  await copyChecked(source, join(target, ...relativePath.split('/')), relativePath);
}

export async function packageProvider({ out } = {}) {
  if (typeof out !== 'string' || !out.trim()) throw new TypeError('out must name a new provider output directory.');
  const repoRoot = await realpath(REPO_ROOT);
  const target = await physicalTarget(resolve(out));
  assertOutputSafe(target, repoRoot);
  try { await lstat(target); throw new Error('Provider output already exists; choose a new path.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const closure = await collectSourceClosure(repoRoot);
  const sourcePackage = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const sourceLock = JSON.parse(await readFile(join(repoRoot, 'package-lock.json'), 'utf8'));
  const dependencies = Object.fromEntries(closure.dependencies.map((name) => {
    const rootKey = 'node_modules/' + name;
    const entry = sourceLock.packages?.[rootKey];
    if (!entry) throw new Error('Provider direct dependency is not recorded in package-lock.json: ' + name);
    return [name, entry.version];
  }).sort(([a], [b]) => a.localeCompare(b)));
  const runtimePackages = await collectDependencyClosure(repoRoot, closure.dependencies, sourceLock);
  const runtimeManifest = {
    name: 'codex-sol-provider',
    version: sourcePackage.version,
    private: true,
    type: 'module',
    engines: { node: '>=20.8' },
    dependencies,
  };
  const runtimeLock = {
    name: runtimeManifest.name,
    version: runtimeManifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: runtimeManifest.name, version: runtimeManifest.version, dependencies },
      ...Object.fromEntries(runtimePackages.map((item) => [item.lockKey, item.lockEntry])),
    },
  };

  await mkdir(dirname(target), { recursive: true });
  await mkdir(target, { recursive: false });
  for (const relativePath of closure.files) await copyRuntimeFile(repoRoot, target, relativePath);
  for (const relativePath of ASSETS) await copyRuntimeFile(repoRoot, target, relativePath);
  await writeFile(join(target, 'package.json'), JSON.stringify(runtimeManifest, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(target, 'package-lock.json'), JSON.stringify(runtimeLock, null, 2) + '\n', { flag: 'wx' });

  for (const item of runtimePackages) {
    const destination = join(target, ...item.lockKey.split('/'));
    try { await lstat(destination); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await copyChecked(item.root, destination, item.lockKey);
    }
  }

  const files = await collectInventoryFiles(target, { exclude: [MANIFEST] });
  const manifest = { schema_revision: 1, protocol: PROTOCOL, protocols: PROTOCOLS, modes: MODES, entry: ENTRY, files };
  await writeFile(join(target, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return target;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--out' || !process.argv[3] || process.argv[3].startsWith('--')) {
      throw new Error('Usage: node scripts/package-provider.mjs --out <new-directory>');
    }
    const out = await packageProvider({ out: process.argv[3] });
    process.stdout.write(JSON.stringify({ status: 'packaged', out }) + '\n');
  } catch (error) {
    process.stderr.write('Provider packaging failed: ' + (error.message ?? String(error)) + '\n');
    process.exitCode = 1;
  }
}
