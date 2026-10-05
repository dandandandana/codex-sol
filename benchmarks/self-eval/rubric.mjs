import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { registrySchema } from './schema.mjs';
import { workspaceFile } from '../../src/workspace.mjs';

export const complianceIds = ['scope', 'protected_files', 'dependencies', 'syntax', 'safe_imports', 'no_dynamic_execution', 'no_debug_output', 'no_embedded_secrets_or_addresses', 'component_registry', 'no_copied_component', 'source_stability'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function snapshot(root) {
  const files = new Map(), problems = [];
  let total = 0;
  async function walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix + name, full = resolve(directory, name), info = await lstat(full);
      // Repository metadata and host observations do not contain candidate source.
      if (['.git', '.codex/sol'].includes(path) && info.isDirectory() && !info.isSymbolicLink()) continue;
      if (info.isSymbolicLink()) { problems.push({ path, code: 'LINKED_INPUT' }); continue; }
      if (info.isDirectory()) await walk(full, path + '/');
      else if (info.isFile()) {
        if (info.size > 256 * 1024 || (total += info.size) > 2 * 1024 * 1024 || files.size >= 128) throw new Error('Candidate exceeds fixture file limits');
        files.set(path, { path, sha256: sha(await readFile(full)), bytes: info.size });
      } else problems.push({ path, code: 'NON_REGULAR_INPUT' });
    }
  }
  await walk(root);
  return { files, problems };
}
function visit(node, action, parent = null, key = '') {
  if (!node || typeof node !== 'object') return;
  if (node.type) action(node, parent, key);
  for (const [name, value] of Object.entries(node)) {
    if (Array.isArray(value)) for (const child of value) visit(child, action, node, name);
    else if (value && typeof value === 'object') visit(value, action, node, name);
  }
}
function exportsOf(ast) {
  const result = [];
  for (const node of ast.body) {
    if (node.type === 'ExportDefaultDeclaration') result.push('default');
    // A wildcard cannot satisfy this corpus's fixed explicit API registry.
    if (node.type === 'ExportAllDeclaration') result.push(node.exported?.name ?? '*');
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration?.id) result.push(node.declaration.id.name);
      for (const declaration of node.declaration?.declarations ?? []) if (declaration.id.type === 'Identifier') result.push(declaration.id.name);
      for (const specifier of node.specifiers ?? []) result.push(specifier.exported.name ?? specifier.exported.value);
    }
  }
  return result.sort();
}
// A limited clone heuristic, not a general semantic equivalence detector.
function shape(node, parent = null, key = '') {
  if (Array.isArray(node)) return node.map(value => shape(value, parent, key));
  if (!node || typeof node !== 'object') return node;
  if (node.type === 'Identifier') {
    const property = (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) || (parent?.type === 'Property' && key === 'key' && !parent.computed);
    return { type: node.type, name: property ? node.name : '<binding>' };
  }
  return Object.fromEntries(Object.entries(node).filter(([name]) => !['start', 'end', 'loc', 'raw'].includes(name)).map(([name, value]) => [name, shape(value, node, name)]));
}
function bodies(ast) {
  const found = [];
  visit(ast, node => { if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type) && node.body.end - node.body.start >= 80) found.push({ line: node.loc.start.line, fingerprint: sha(JSON.stringify(shape(node.body))) }); });
  return found;
}
function sortedRegistry(value) { return value.modules.map(m => ({ ...m, exports: [...m.exports].sort(), ...(m.options ? { options: [...m.options].sort() } : {}) })).sort((a, b) => a.id.localeCompare(b.id)); }

export async function inspectCandidate(root, baselineRoot, baseline, task) {
  const current = await snapshot(root);
  const checks = complianceIds.map(id => ({ id, status: 'passed', findings: [] }));
  const fail = (id, finding) => { const check = checks.find(c => c.id === id); check.status = 'failed'; check.findings.push(finding); };
  for (const p of current.problems) { fail('scope', p); fail('protected_files', p); }
  for (const path of new Set([...current.files.keys(), ...baseline.files.keys()])) {
    if (current.files.get(path)?.sha256 !== baseline.files.get(path)?.sha256 && !task.allowed_paths.includes(path)) fail('scope', { path, code: 'OUTSIDE_ALLOWED_PATHS' });
    if (baseline.files.has(path) && !task.allowed_paths.includes(path) && current.files.get(path)?.sha256 !== baseline.files.get(path).sha256) fail('protected_files', { path, code: 'BASELINE_MODIFIED' });
  }
  try {
    const actual = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const expected = JSON.parse(await readFile(resolve(baselineRoot, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'scripts', 'type']) assert.deepEqual(actual[field], expected[field]);
  } catch { fail('dependencies', { path: 'package.json', code: 'DEPENDENCY_OR_EXECUTION_CONFIG_CHANGED' }); }
  const asts = new Map(), cloneSources = new Set();
  if (!current.files.has(task.entry)) fail('syntax', { path: task.entry, code: 'ENTRY_SOURCE_MISSING' });
  for (const path of baseline.files.keys()) if (path.endsWith('.mjs') && !task.allowed_paths.includes(path)) {
    const ast = parse(await readFile(resolve(baselineRoot, path), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    for (const body of bodies(ast)) cloneSources.add(body.fingerprint);
  }
  for (const path of current.files.keys()) if (/\.(?:mjs|js|cjs)$/u.test(path)) {
    let ast;
    try { ast = parse(await readFile(await workspaceFile(root, path), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', locations: true }); asts.set(path, ast); }
    catch { fail('syntax', { path, code: 'SOURCE_PARSE_ERROR' }); continue; }
    if (current.files.get(path).sha256 !== baseline.files.get(path)?.sha256) for (const body of bodies(ast)) if (cloneSources.has(body.fingerprint)) fail('no_copied_component', { path, line: body.line, code: 'NORMALIZED_COMPONENT_BODY_COPY' });
    const imports = [];
    visit(ast, node => {
      const finding = code => ({ path, line: node.loc.start.line, code });
      if (node.type === 'ImportDeclaration' || (node.source && ['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type))) imports.push(node.source.value);
      if (node.type === 'ImportExpression') {
        if (node.source.type !== 'Literal' || typeof node.source.value !== 'string') fail('safe_imports', finding('COMPUTED_IMPORT'));
        else imports.push(node.source.value);
      }
      if (node.type === 'Identifier' && ['eval', 'Function', 'AsyncFunction', 'require', 'process', 'fetch', 'WebSocket'].includes(node.name)) fail('no_dynamic_execution', finding('FORBIDDEN_RUNTIME_IDENTIFIER'));
      if (node.type === 'MemberExpression' && node.property.type === 'Identifier' && ['eval', 'Function', 'process', 'fetch', 'WebSocket'].includes(node.property.name)) fail('no_dynamic_execution', finding('FORBIDDEN_RUNTIME_ACCESS'));
      if (node.type === 'Identifier' && node.name === 'console') fail('no_debug_output', finding('CONSOLE_IN_IMPLEMENTATION'));
      if (node.type === 'Literal' && typeof node.value === 'string' && /https?:\/\/|\bsk-[A-Za-z0-9]{16,}|\bAKIA[A-Z0-9]{16}|-----BEGIN .*PRIVATE KEY-----/u.test(node.value)) fail('no_embedded_secrets_or_addresses', finding('EMBEDDED_ADDRESS_OR_CREDENTIAL_SHAPE'));
    });
    for (const specifier of imports) {
      const target = typeof specifier === 'string' ? resolve(root, dirname(path), specifier) : '';
      const inside = relative(root, target).replaceAll(sep, '/');
      if (!specifier?.startsWith('.') || !current.files.has(inside) || !inside.startsWith('src/') || !inside.endsWith('.mjs')) fail('safe_imports', { path, code: 'IMPORT_OUTSIDE_FIXTURE_SOURCE' });
    }
  }
  for (const path of current.files.keys()) if (/(?:^|\/)\.env(?:\.|$)|(?:^|\/)(?:credentials|auth)\.json$/iu.test(path)) fail('no_embedded_secrets_or_addresses', { path, code: 'SECRET_FILE_PRESENT' });
  try {
    const actual = registrySchema.parse(JSON.parse(await readFile(await workspaceFile(root, 'components.json'), 'utf8')));
    const expected = registrySchema.parse(JSON.parse(await readFile(resolve(baselineRoot, 'components.json'), 'utf8')));
    const module = { id: task.api.module_id, path: task.api.path, exports: task.api.exports, ...(task.api.options ? { options: task.api.options } : {}) };
    const index = expected.modules.findIndex(m => m.id === module.id);
    if (index === -1) expected.modules.push(module); else expected.modules[index] = module;
    assert.deepEqual(sortedRegistry(actual), sortedRegistry(expected));
    for (const m of actual.modules) { assert.ok(asts.has(m.path)); assert.deepEqual(exportsOf(asts.get(m.path)), [...m.exports].sort()); }
    if (task.id === 'T08') {
      const consumer = asts.get('src/consumer.mjs');
      assert.ok(consumer.body.some(n => n.type === 'ImportDeclaration' && n.source.value === './gateway.mjs' && n.specifiers.some(s => s.imported?.name === 'listEntries')));
      assert.ok(!consumer.body.some(n => n.type === 'ImportDeclaration' && n.specifiers.some(s => s.imported?.name === 'listRecords')));
    }
  } catch { fail('component_registry', { path: 'components.json', code: 'PUBLIC_CONTRACT_NOT_SYNCHRONIZED' }); }
  const blocked = ['protected_files', 'dependencies', 'syntax', 'safe_imports', 'no_dynamic_execution', 'no_embedded_secrets_or_addresses'].some(id => checks.find(c => c.id === id).status !== 'passed') || current.problems.length > 0;
  return { current, checks, blocked };
}

export async function coverageCounts(directory, root, opportunities) {
  const counts = new Map(opportunities.map(o => [o.id + ':' + o.export_name, 0]));
  const identity = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const files = [];
  for (const name of (await readdir(directory)).sort()) if (name.endsWith('.json')) {
    const raw = await readFile(resolve(directory, name)), value = JSON.parse(raw);
    assert.ok(Array.isArray(value.result)); files.push({ path: name, sha256: sha(raw), bytes: raw.length });
    for (const script of value.result) {
      if (!script.url?.startsWith('file:')) continue;
      const path = fileURLToPath(script.url);
      for (const opportunity of opportunities) if (identity(path) === identity(resolve(root, opportunity.path))) {
        const functions = script.functions.filter(f => f.functionName === opportunity.export_name && f.ranges?.[0]);
        if (functions.length > 1) throw new Error('Ambiguous component coverage');
        if (functions.length) {
          const calls = functions[0].ranges[0].count;
          assert.ok(Number.isSafeInteger(calls) && calls >= 0);
          counts.set(opportunity.id + ':' + opportunity.export_name, counts.get(opportunity.id + ':' + opportunity.export_name) + calls);
        }
      }
    }
  }
  if (!files.length) throw new Error('No actual V8 coverage was produced');
  return { counts, files };
}
