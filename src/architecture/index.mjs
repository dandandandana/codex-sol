import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { parse } from 'acorn';
import { z } from 'zod';
import { l1Validate } from '../../vendor/normify/engine/frontmatter.js';
import { writeModuleFile } from '../../vendor/normify/engine/store.js';
import { evaluatePolicy, l1ValidatePolicy, writePolicyFile } from '../../vendor/normify/engine/policy.js';
import { buildProject } from '../../vendor/normify/engine/compile.js';
import { readWorkspaceBytes, workspaceFile } from '../workspace-read.mjs';
import { interruptionFault, SolFault } from '../store.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const key = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
const schema = z.object({ schema_version: z.literal(1), modules: z.array(z.record(z.string(), z.unknown())).min(1).max(100), policy: z.record(z.string(), z.unknown()) }).strict();
export const architectureQuerySchema = z.object({ paths: z.array(z.string().min(1).max(256)).max(16).default([]), capability: z.string().max(256).default('') }).strict();
const fault = (code, message, diagnostics) => { const error = new SolFault(code, message); error.diagnostics = diagnostics; throw error; };
const check = (signal) => { if (signal?.aborted) throw interruptionFault(signal, 'Architecture operation was interrupted.'); };

/** Validate a declaration without reading its sources or invoking the compiler. */
export function validateArchitectureDeclaration(input) {
  let config;
  try { config = schema.parse(input); }
  catch { fault('ARCHITECTURE_CONFIG', 'Architecture declaration must be bounded valid JSON.'); }
  // Bound nested policy input before passing it to the upstream YAML serializer.
  const stack = [[config, 0]]; let count = 0;
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (++count > 20000 || depth > 20) fault('ARCHITECTURE_LIMIT', 'Architecture input is too deeply nested or complex.');
    if (value && typeof value === 'object') for (const child of Object.values(value)) stack.push([child, depth + 1]);
  }
  const modules = [];
  for (const module of config.modules) {
    const validation = l1Validate(module, 'architecture.json');
    if (!validation.module || validation.errors.length) fault('ARCHITECTURE_CONFIG', 'Normify rejected a module declaration.', validation.errors);
    if (module.source.length > 32 || (module.apis?.length ?? 0) > 32 || (module.deps?.length ?? 0) > 64) fault('ARCHITECTURE_LIMIT', 'Module declarations exceed the supported limits.');
    modules.push(validation.module);
  }
  const validation = l1ValidatePolicy(config.policy, 'architecture.json/policy');
  if (validation.errors.length || (config.policy.rules?.length ?? 0) > 64) fault('ARCHITECTURE_CONFIG', 'Normify rejected the architecture policy.', validation.errors);
  return { schema_version: config.schema_version, modules, policy: validation.policy };
}

function facts(text, path) {
  const result = { imports: [], exports: [], uncovered: [] };
  let ast;
  try { ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); }
  catch (error) { fault('ARCHITECTURE_PARSE', 'JavaScript source could not be parsed.', [{ path, line: error.loc?.line }]); }
  const names = (node) => {
    if (!node) return [];
    if (node.type === 'Identifier') return [node.name];
    if (node.type === 'RestElement') return names(node.argument);
    if (node.type === 'AssignmentPattern') return names(node.left);
    if (node.type === 'ArrayPattern') return node.elements.flatMap(names);
    if (node.type === 'ObjectPattern') return node.properties.flatMap((p) => names(p.value ?? p.argument));
    return [];
  };
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration' || node.source && ['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) {
      result.imports.push({ path, line: node.loc.start.line, specifier: node.source.value,
        names: (node.specifiers ?? []).map((s) => s.imported?.name ?? s.imported?.value ?? (s.type === 'ImportDefaultSpecifier' ? 'default' : '*')) });
    }
    if (node.type === 'ExportDefaultDeclaration') result.exports.push({ name: 'default', line: node.loc.start.line });
    if (node.type === 'ExportNamedDeclaration') {
      const declared = node.declaration?.type === 'VariableDeclaration' ? node.declaration.declarations.flatMap((d) => names(d.id)) : names(node.declaration?.id);
      for (const name of declared) result.exports.push({ name, line: node.loc.start.line });
      for (const specifier of node.specifiers) result.exports.push({ name: specifier.exported.name ?? specifier.exported.value, line: node.loc.start.line });
    }
    if (node.type === 'ExportAllDeclaration') result.uncovered.push({ path, line: node.loc.start.line, reason: 'export_star_resolution' });
  }
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'ImportExpression' || node.type === 'CallExpression' && node.callee?.name === 'require') result.uncovered.push({ path, line: node.loc.start.line, reason: node.type === 'ImportExpression' ? 'dynamic_import' : 'commonjs_require' });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) stack.push(...value.filter((item) => item?.type));
      else if (value?.type) stack.push(value);
    }
  }
  return result;
}

/** Fresh read-only architecture snapshot. Normify owns declaration/policy compilation;
 * this adapter owns workspace boundaries and JS import/export facts. No source edits,
 * persistent mutable index or completion state. Caller holds the workspace lock.
 */
export class ArchitectureIndex {
  constructor(root, path) { this.root = root; this.path = path; }

  async load(signal, { validateReadPath } = {}) {
    check(signal);
    const declaration = await readWorkspaceBytes(this.root, this.path, 256 * 1024, { signal });
    let parsedDeclaration;
    try { parsedDeclaration = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(declaration)); }
    catch { fault('ARCHITECTURE_CONFIG', 'Architecture declaration must be bounded valid JSON.'); }
    const config = validateArchitectureDeclaration(parsedDeclaration);
    const policy = config.policy;
    const declaredSourcePaths = [...new Set(config.modules.flatMap((module) => module.source.map((source) => source.path)))];
    for (const path of declaredSourcePaths) {
      check(signal);
      await workspaceFile(this.root, path, { allowMissing: true });
      await validateReadPath?.(path);
    }
    const sourceBytes = new Map(); const ownership = new Map(); let total = 0;
    const diagnostics = []; const uncovered = []; const parsed = new Map();
    for (const module of config.modules) {
      for (const source of module.source) {
        const owners = ownership.get(key(source.path)) ?? [];
        if (owners.some((o) => Math.max(o.line ?? 1, source.line ?? 1) <= Math.min(o.end_line ?? Infinity, source.end_line ?? Infinity))) diagnostics.push({ code: 'OWNERSHIP_CONFLICT', blocking: true, path: source.path, modules: [...owners.map((o) => o.id), module.id] });
        owners.push({ ...source, id: module.id, uid: module.uid }); ownership.set(key(source.path), owners);
        if (!sourceBytes.has(source.path)) {
          try {
            const bytes = await readWorkspaceBytes(this.root, source.path, 1024 * 1024, { signal });
            total += bytes.length; if (total > 8 * 1024 * 1024) fault('ARCHITECTURE_LIMIT', 'Architecture sources exceed 8 MiB.');
            sourceBytes.set(source.path, bytes);
          } catch (error) { if (error.code !== 'ENOENT') throw error; sourceBytes.set(source.path, null); }
        }
      }
    }
    if (sourceBytes.size > 256) fault('ARCHITECTURE_LIMIT', 'Architecture sources exceed 256 files.');
    const temporary = await mkdtemp(join(tmpdir(), 'sol-normify-'));
    let compiled;
    try {
      for (const module of config.modules) { check(signal); await writeModuleFile(temporary, module, ''); }
      await writePolicyFile(temporary, policy);
      const build = await buildProject(temporary, { repoRoot: this.root, requireBilingual: true });
      diagnostics.push(...build.errors.map((d) => ({ code: d.code, blocking: true, message: d.message, subject: d.subject, evidence: d.evidence })), ...build.warnings.map((d) => ({ code: d.code, blocking: false, message: d.message, subject: d.subject })));
      if (build.ok) compiled = JSON.parse(await readFile(join(temporary, 'tree.json'), 'utf8'));
    } finally { await rm(temporary, { recursive: true, force: true }); }
    const ownersAt = (path, line) => (ownership.get(key(path)) ?? []).filter((o) => line === undefined || line >= (o.line ?? 1) && line <= (o.end_line ?? Infinity));
    for (const [path, bytes] of sourceBytes) {
      if (!bytes) continue;
      if (!/\.(?:mjs|js)$/u.test(path)) { uncovered.push({ path, reason: 'non_javascript_source' }); continue; }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fault('UNSUPPORTED_ENCODING', 'Architecture source is not UTF-8.'); }
      parsed.set(path, facts(text, path));
    }
    const edges = []; const capabilities = [];
    for (const [path, fact] of parsed) {
      uncovered.push(...fact.uncovered);
      for (const dependency of fact.imports) {
        if (!dependency.specifier.startsWith('.')) { uncovered.push({ ...dependency, reason: 'external_import' }); continue; }
        const target = posix.normalize(posix.join(posix.dirname(path), dependency.specifier));
        try { await workspaceFile(this.root, target, { allowMissing: true }); }
        catch { diagnostics.push({ code: 'IMPORT_PATH_INVALID', path, line: dependency.line, blocking: true }); continue; }
        const from = ownersAt(path, dependency.line); const to = ownersAt(target);
        if (!to.length) uncovered.push({ ...dependency, target, reason: 'unregistered_import_target' });
        const targetFacts = parsed.get(target);
        if (targetFacts && !targetFacts.uncovered.some((u) => u.reason === 'export_star_resolution')) for (const name of dependency.names) {
          if (name !== '*' && !targetFacts.exports.some((e) => e.name === name)) diagnostics.push({ code: 'IMPORT_EXPORT_MISSING', blocking: true, path, line: dependency.line, target, symbol: name });
        }
        for (const a of from) for (const b of to) if (a.uid !== b.uid) edges.push({ from: a.id, from_uid: a.uid, to: b.id, to_uid: b.uid, kind: 'static_import', source: { path, line: dependency.line, sha256: sha(sourceBytes.get(path)) }, target, names: dependency.names });
      }
    }
    for (const module of config.modules) for (const api of module.apis ?? []) {
      const locations = module.source.flatMap((source) => (parsed.get(source.path)?.exports ?? []).filter((e) => e.name === api.path && ownersAt(source.path, e.line).some((o) => o.uid === module.uid)).map((e) => ({ path: source.path, line: e.line, sha256: sha(sourceBytes.get(source.path)) })));
      const verified = api.protocol === 'rpc' && locations.length > 0 && (module.state ?? 'active') === 'active';
      if (api.protocol === 'rpc' && !verified && (module.state ?? 'active') === 'active') diagnostics.push({ code: 'EXPORT_MISSING', blocking: true, module: module.id, capability: api.path });
      capabilities.push({ module: module.id, uid: module.uid, symbol: api.path, protocol: api.protocol, description: api.description, state: module.state ?? 'active', verification: verified ? 'static_export' : 'declaration_only', locations });
    }
    const files = config.modules.map((module) => ({ module: { ...module, deps: edges.filter((e) => e.from_uid === module.uid).map((e) => ({ kind: 'reference', to: e.to })) } }));
    for (const diagnostic of evaluatePolicy(policy, { files, byId: new Map(files.map((f) => [f.module.id, f])) })) {
      diagnostics.push({ code: diagnostic.code, blocking: diagnostic.severity === 'error', message: diagnostic.message, subject: diagnostic.subject,
        origin: 'static_import', evidence: diagnostic.evidence, sources: edges.filter((e) => e.from === diagnostic.subject?.module && (!diagnostic.subject?.to || e.to === diagnostic.subject.to)).map((e) => e.source) });
    }
    const versions = [{ path: this.path, sha256: sha(declaration) }, ...[...sourceBytes].map(([path, bytes]) => ({ path, sha256: bytes ? sha(bytes) : null })).sort((a, b) => a.path.localeCompare(b.path))];
    await this.fresh(versions, signal);
    return { schema_version: 1, kind: 'architecture_snapshot', version: sha(JSON.stringify(versions)), versions, status: diagnostics.some((d) => d.blocking) ? 'blocked' : 'ready',
      engine: { name: 'Normify', version: '0.5.4', commit: 'ed404e5b8db0010ff57ec8486ec8749421072545', compiled: !!compiled },
      tree: config.modules.map(({ id, uid, parent, name, description, state, source }) => ({ id, uid, parent, name, description, state: state ?? 'active', source })),
      capabilities, edges, declared_edges: compiled?.edges ?? [], diagnostics, uncovered,
      // Retain facts independently of declared APIs, including undeclared exports.
      // These fields are archived by maintenance callers; select keeps its existing shape.
      source_facts: [...sourceBytes].map(([path, bytes]) => ({ path, sha256: bytes ? sha(bytes) : null,
        exports: (parsed.get(path)?.exports ?? []).map((entry) => ({ ...entry,
          owners: ownersAt(path, entry.line).map(({ id, uid }) => ({ id, uid })) })) })).sort((a, b) => a.path.localeCompare(b.path)),
      declaration_facts: config.modules.map(({ id, uid, parent, state, name, description, fingerprint, apis, deps }) =>
        ({ id, uid, parent, state: state ?? 'active', name, description, fingerprint, apis: apis ?? [], deps: deps ?? [] })),
      coverage: 'JavaScript ESM file imports/exports only; no full call graph or task completion evidence' };
  }

  /** Synchronous analysis of captured snapshots, with no reads or declaration writes.
   * Caller supplies validated cumulative paths/scope after generated-path filtering.
   * impact_paths conservatively includes sources of transitive reverse static users
   * from both sides, not a complete call graph or a safe regression-test selection.
   * Suggestions are facts requiring review; fingerprints cannot approve semantics.
   */
  maintenance(before, current, { paths = [], scope = [] } = {}) {
    const suggestions = []; const uncovered = []; const blockers = [];
    const provenance = { before_version: before?.version ?? null, current_version: current.version };
    const affected = new Set(); const impacted = new Map();
    const addPath = (path) => { if (path && !impacted.has(key(path))) impacted.set(key(path), path); };
    const owners = (snapshot, path) => (snapshot?.tree ?? []).filter((module) => module.source.some((source) => key(source.path) === key(path)));
    const moduleMap = (snapshot) => new Map((snapshot?.tree ?? []).map((module) => [module.uid, module]));
    const oldModules = moduleMap(before); const newModules = moduleMap(current);
    const oldDeclarations = new Map((before?.declaration_facts ?? []).map((module) => [module.uid, module]));
    const newDeclarations = new Map((current.declaration_facts ?? []).map((module) => [module.uid, module]));
    const sourceMap = (snapshot) => new Map((snapshot?.source_facts ?? []).map((source) => [key(source.path), source]));
    const oldSources = sourceMap(before); const newSources = sourceMap(current);
    const suggest = (kind, detail, evidence = {}) => {
      if (detail.module_uid) affected.add(detail.module_uid);
      addPath(detail.path);
      suggestions.push(structuredClone({ kind, ...detail, evidence: { ...provenance,
        ...(detail.module_uid ? { declaration_location: { path: current.versions[0].path, module_uid: detail.module_uid } } : {}), ...evidence } }));
    };
    const block = (code, detail = {}) => blockers.push(structuredClone({ code, blocking: true, ...detail, evidence: { ...provenance, ...(detail.evidence ?? {}) } }));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const pathSet = new Set(paths.map(key));
    const declarationPaths = new Set([this.path, before?.versions[0]?.path, current.versions[0]?.path].filter(Boolean).map(key));
    const declarationChanged = before && !same(before.versions[0], current.versions[0]);
    if (declarationChanged || paths.some((path) => declarationPaths.has(key(path)))) {
      // A policy or ownership edit can affect any branch, even a source-less root.
      for (const uid of [...oldModules.keys(), ...newModules.keys()]) affected.add(uid);
      suggest('declaration_input_review', {}, { before: before?.versions[0] ?? null, current: current.versions[0],
        note: 'Declaration or policy input changed; conservatively review all previous and current modules.' });
    }
    for (const path of paths) {
      addPath(path);
      const oldOwners = owners(before, path); const newOwners = owners(current, path);
      for (const module of [...oldOwners, ...newOwners]) affected.add(module.uid);
      if (/\.(?:mjs|js|cjs)$/iu.test(path) && !newOwners.length) {
        // A scope assignment is intent, not a source registration. No file read is
        // needed to expose this gap, and no exports are invented for unknown files.
        if (!oldOwners.length) {
          block('UNREGISTERED_SOURCE', { path });
          suggest('register_source', { path, assigned_uids: scope.filter((item) => key(item.path) === key(path)).map((item) => item.module_uid) });
        } else {
          uncovered.push({ path, reason: 'removed_source_presence_unverified', ...provenance });
        }
      }
    }
    for (const item of scope.filter((item) => pathSet.has(key(item.path)))) {
      const module = newModules.get(item.module_uid) ?? oldModules.get(item.module_uid);
      if (!module) { block('SCOPE_MODULE_UNAVAILABLE', item); continue; }
      affected.add(module.uid);
      const registered = owners(current, item.path);
      if (registered.some((owner) => owner.uid !== item.module_uid)) block('SCOPE_OWNERSHIP_MISMATCH', { ...item, owner_uids: registered.map((owner) => owner.uid) });
      if (!registered.length && !/\.(?:mjs|js|cjs)$/iu.test(item.path)) suggest('scope_ownership_review', item,
        { note: 'Non-source scope assignment requires responsibility review, not automatic source registration.' });
    }
    if (!before) block('BEFORE_IMPACT_UNAVAILABLE', { message: 'No archived before snapshot; current facts cannot reconstruct historical users.' });
    else if (!before.source_facts) block('BEFORE_SOURCE_FACTS_UNAVAILABLE', { message: 'Archived snapshot lacks export facts; export removals cannot be inferred from declared APIs.' });
    if (before && !before.declaration_facts) block('BEFORE_DECLARATION_FACTS_UNAVAILABLE', { message: 'Archived snapshot lacks declaration facts; prior intended relations cannot be reconstructed.' });

    if (before) {
      for (const uid of [...new Set([...oldModules.keys(), ...newModules.keys()])].sort()) {
        const oldModule = oldModules.get(uid); const newModule = newModules.get(uid);
        if (!oldModule || !newModule) {
          suggest(oldModule ? 'module_removed' : 'module_added', { module_uid: uid }, { before: oldModule ?? null, current: newModule ?? null });
        } else {
          if (oldModule.id !== newModule.id) suggest('module_renamed', { module_uid: uid }, { before: oldModule.id, current: newModule.id });
          const parentUid = (snapshot, module) => snapshot.tree.find((candidate) => candidate.id === module.parent)?.uid ?? null;
          const oldParent = parentUid(before, oldModule); const newParent = parentUid(current, newModule);
          if (oldParent !== newParent) suggest('module_reparented', { module_uid: uid }, { before: oldParent, current: newParent });
          for (const field of ['name', 'description', 'state']) if (!same(oldModule[field], newModule[field]))
            suggest('module_declaration_changed', { module_uid: uid, field }, { before: oldModule[field], current: newModule[field] });
        }
        const sourceKey = (source) => JSON.stringify([key(source.path), source.line ?? 1, source.end_line ?? null]);
        const a = new Map((oldModule?.source ?? []).map((source) => [sourceKey(source), source]));
        const b = new Map((newModule?.source ?? []).map((source) => [sourceKey(source), source]));
        for (const sourceId of [...new Set([...a.keys(), ...b.keys()])].sort()) if (!a.has(sourceId) || !b.has(sourceId)) {
          const source = b.get(sourceId) ?? a.get(sourceId);
          suggest(a.has(sourceId) ? 'source_registration_removed' : 'source_registration_added', { module_uid: uid, path: source.path },
            { before: a.get(sourceId) ?? null, current: b.get(sourceId) ?? null });
        }
        const oldApis = oldDeclarations.get(uid)?.apis; const newApis = newDeclarations.get(uid)?.apis;
        if (oldApis && newApis && !same(oldApis, newApis)) suggest('api_declaration_changed', { module_uid: uid }, { before: oldApis, current: newApis });
      }
      for (const pathKey of [...new Set([...oldSources.keys(), ...newSources.keys()])].sort()) {
        const oldSource = oldSources.get(pathKey); const newSource = newSources.get(pathKey);
        if (oldSource?.sha256 === newSource?.sha256) continue;
        const path = (newSource ?? oldSource).path;
        const changedOwners = [...new Set([...owners(before, path), ...owners(current, path)].map((module) => module.uid))];
        const sourceEvidence = (source) => source ? { path: source.path, sha256: source.sha256 } : null;
        for (const uid of changedOwners) suggest('source_changed', { module_uid: uid, path }, { before: sourceEvidence(oldSource), current: sourceEvidence(newSource) });
      }
      if (before.source_facts && current.source_facts) {
        const exportMap = (snapshot) => {
          const result = new Map();
          for (const source of snapshot.source_facts) for (const entry of source.exports) for (const owner of entry.owners) {
            const id = JSON.stringify([owner.uid, entry.name]);
            const value = result.get(id) ?? { module_uid: owner.uid, symbol: entry.name, locations: [] };
            value.locations.push({ path: source.path, line: entry.line, sha256: source.sha256 }); result.set(id, value);
          }
          return result;
        };
        const a = exportMap(before); const b = exportMap(current);
        for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
          const oldExport = a.get(id); const newExport = b.get(id); const entry = newExport ?? oldExport;
          if (!oldExport || !newExport) suggest(oldExport ? 'export_removed' : 'export_added',
            { module_uid: entry.module_uid, path: entry.locations[0].path, symbol: entry.symbol }, { before: oldExport ?? null, current: newExport ?? null });
          else if (!same(oldExport.locations.map((location) => key(location.path)).sort(), newExport.locations.map((location) => key(location.path)).sort()))
            suggest('export_relocated', { module_uid: entry.module_uid, path: entry.locations[0].path, symbol: entry.symbol }, { before: oldExport, current: newExport });
        }
      }
      const capabilityMap = (snapshot) => new Map(snapshot.capabilities.map((capability) =>
        [JSON.stringify([capability.uid, capability.protocol, capability.symbol]), capability]));
      const oldCapabilities = capabilityMap(before); const newCapabilities = capabilityMap(current);
      for (const id of [...new Set([...oldCapabilities.keys(), ...newCapabilities.keys()])].sort()) {
        const a = oldCapabilities.get(id); const b = newCapabilities.get(id); const capability = b ?? a;
        const semantics = (value) => value && { description: value.description, state: value.state, verification: value.verification };
        if (!a || !b || !same(semantics(a), semantics(b))) suggest(!a ? 'capability_added' : !b ? 'capability_removed' : 'capability_changed',
          { module_uid: capability.uid, symbol: capability.symbol, ...(capability.locations[0] ? { path: capability.locations[0].path } : {}) },
          { before: a ?? null, current: b ?? null });
      }
      // Compare like with like across time. Normify reference deps are design
      // declarations, not static_import expectations; never overwrite either view.
      const relations = (snapshot, declared) => {
        if (!declared) return (snapshot.edges ?? []).filter((edge) => edge.kind === 'static_import');
        return (snapshot.declaration_facts ?? []).flatMap((module) => module.deps.map((dependency) => ({
          from_uid: module.uid, to_uid: snapshot.tree.find((target) => target.id === dependency.to)?.uid ?? null,
          from: module.id, ...dependency,
        })));
      };
      for (const declared of [false, true]) {
        if (declared && !before.declaration_facts) continue;
        const relationKey = (edge) => JSON.stringify([edge.from_uid, edge.to_uid ?? edge.to, edge.kind,
          ...(declared ? [edge.from_api ?? null, edge.to_api ?? null] : [key(edge.source.path), key(edge.target), [...edge.names].sort()])]);
        const a = new Map(relations(before, declared).map((edge) => [relationKey(edge), edge]));
        const b = new Map(relations(current, declared).map((edge) => [relationKey(edge), edge]));
        for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) if (!a.has(id) || !b.has(id) || declared && !same(a.get(id).label, b.get(id).label)) {
          const edge = b.get(id) ?? a.get(id);
          if (edge.to_uid) affected.add(edge.to_uid);
          const operation = a.has(id) && b.has(id) ? 'changed' : a.has(id) ? 'removed' : 'added';
          suggest(`${declared ? 'declared' : 'static'}_relation_${operation}`,
            { module_uid: edge.from_uid, ...(edge.source ? { path: edge.source.path } : {}) }, { before: a.get(id) ?? null, current: b.get(id) ?? null });
        }
      }
    }
    const staticEdges = [...(before?.edges ?? []), ...(current.edges ?? [])].filter((edge) => edge.kind === 'static_import');
    const reverse = new Map();
    for (const edge of staticEdges) { const users = reverse.get(edge.to_uid) ?? []; users.push(edge); reverse.set(edge.to_uid, users); }
    const queue = [...affected];
    for (let i = 0; i < queue.length; i++) for (const edge of reverse.get(queue[i]) ?? []) {
      addPath(edge.source.path); addPath(edge.target);
      if (!affected.has(edge.from_uid)) { affected.add(edge.from_uid); queue.push(edge.from_uid); }
    }
    for (const uid of affected) for (const module of [oldModules.get(uid), newModules.get(uid)]) for (const source of module?.source ?? []) addPath(source.path);
    for (const diagnostic of current.diagnostics.filter((diagnostic) => diagnostic.blocking)) {
      block(diagnostic.code, diagnostic);
      if (diagnostic.code === 'evidence/fingerprint-drift') {
        const module = current.tree.find((module) => module.id === diagnostic.subject?.module);
        if (module && affected.has(module.uid)) suggest('refresh_fingerprint', { module_uid: module.uid },
          { authored: diagnostic.evidence?.authored, actual: diagnostic.evidence?.actual, sources: module.source.map((source) => ({ ...source,
            sha256: newSources.get(key(source.path))?.sha256 ?? null })), note: 'Fresh fingerprint requires separate contract review.' });
      }
    }
    for (const [side, snapshot] of [['before', before], ['current', current]]) for (const item of snapshot?.uncovered ?? []) {
      if (impacted.has(key(item.path ?? '')) || impacted.has(key(item.target ?? '')) || item.uid && affected.has(item.uid))
        uncovered.push(structuredClone({ ...item, side, source_version: snapshot.version }));
    }
    for (const source of current.source_facts ?? []) if (impacted.has(key(source.path))) for (const entry of source.exports) {
      if (!entry.owners.length) uncovered.push({ reason: 'unowned_export', path: source.path, line: entry.line, symbol: entry.name,
        side: 'current', source_version: current.version });
    }
    if (affected.size || paths.length) uncovered.push({ reason: 'static_analysis_boundary', ...provenance,
      affected_uids: [...affected].sort(), coverage: current.coverage, note: 'Static reverse imports do not prove responsibility, behavioral compatibility or complete impact.' });
    return { affected_uids: [...affected].sort(), impact_paths: [...impacted.values()].sort(), suggestions, uncovered, blockers };
  }

  async fresh(versions, signal) {
    for (const version of versions) {
      check(signal); let bytes;
      try { bytes = await readWorkspaceBytes(this.root, version.path, version.path === this.path ? 256 * 1024 : 1024 * 1024, { signal }); }
      catch (error) { if (error.code === 'ENOENT' && version.sha256 === null) continue; if (error.code === 'INTERRUPTED' || error.code === 'HOST_STATE_ERROR') throw error; fault('CONTEXT_STALE', 'Architecture inputs are no longer readable; prepare again.'); }
      if (sha(bytes) !== version.sha256) fault('CONTEXT_STALE', 'Architecture declaration or source changed; prepare again.');
    }
  }

  select(snapshot, input) {
    const args = architectureQuerySchema.parse(input); const paths = new Set(args.paths.map(key));
    const tokens = args.capability.toLowerCase().split(/[\s,，。;；]+/u).filter(Boolean);
    const owners = snapshot.tree.filter((m) => m.source.some((s) => paths.has(key(s.path))));
    const candidates = snapshot.capabilities.filter((c) => !tokens.length || tokens.some((token) => `${c.symbol} ${c.description.zh} ${c.description.en}`.toLowerCase().includes(token)));
    const selected = new Set([...owners.map((o) => o.uid), ...candidates.map((c) => c.uid)]);
    return { schema_version: 1, kind: 'architecture_query', version: snapshot.version, status: snapshot.status, engine: snapshot.engine, owners, candidates,
      impact: snapshot.edges.filter((e) => selected.has(e.to_uid)), declared_impact: snapshot.declared_edges.filter((e) => owners.some((o) => o.id === e.to)),
      diagnostics: snapshot.diagnostics, uncovered: snapshot.uncovered, coverage: snapshot.coverage };
  }
}
