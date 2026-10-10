import { createHash } from 'node:crypto';
import { opendir, lstat } from 'node:fs/promises';
import { extname, join, posix } from 'node:path';
import { parse } from 'acorn';
import { canonicalProviderDigest, providerPathExclusionReason } from './provider-policy.mjs';
import { readWorkspaceBytes } from './workspace-read.mjs';
import { interruptionFault, SolFault } from './store.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const key = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_ENUMERATED_ENTRIES = 8192;

const excludedDirectories = new Set([
  'node_modules', 'slop', '.git', '.codex', '.hg', '.svn', '.cache', 'cache',
  'build', 'dist', 'out', 'target', 'coverage', '.next', '.nuxt', '.turbo', '.vite',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '__pycache__',
]);
const binaryExtensions = new Set([
  '.7z', '.a', '.apk', '.avif', '.bin', '.bmp', '.class', '.dll', '.dylib', '.eot',
  '.exe', '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.lib', '.mp3', '.mp4',
  '.o', '.pdf', '.png', '.so', '.tar', '.ttf', '.wasm', '.webm', '.webp', '.woff',
  '.woff2', '.xz', '.zip',
]);
const sourceExtensions = new Set([
  '.c', '.cc', '.cjs', '.cpp', '.cs', '.cts', '.go', '.h', '.hh', '.hpp', '.html',
  '.htm', '.java', '.js', '.jsx', '.kt', '.mjs', '.mts', '.php', '.py', '.rb', '.rs',
  '.sass', '.scala', '.scss', '.sh', '.sql', '.svelte', '.swift', '.ts', '.tsx', '.vue',
]);
const sourceNames = new Set(['dockerfile', 'gnumakefile', 'justfile', 'makefile', 'procfile']);

function check(signal) {
  if (signal?.aborted) throw interruptionFault(signal, 'Repository discovery was interrupted.');
}

function statusReason(code, path = undefined) {
  return { code, ...(path ? { path } : {}) };
}

function statShape(info) {
  return { size: Number(info.size), mtime_ms: Number(info.mtimeMs), ctime_ms: Number(info.ctimeMs), dev: String(info.dev), ino: String(info.ino) };
}

function sameStat(a, b) {
  return a && b && a.size === b.size && a.mtime_ms === b.mtime_ms && a.ctime_ms === b.ctime_ms
    && a.dev === b.dev && a.ino === b.ino;
}

function isSourceLike(path) {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return sourceExtensions.has(extname(name)) || sourceNames.has(name) || !binaryExtensions.has(extname(name));
}

function excludedDirectoryPath(path) {
  return path.split('/').some((part) => excludedDirectories.has(part.toLowerCase()));
}

function hasPathAncestor(path, entries) {
  const parts = path.split('/');
  for (let length = 1; length < parts.length; length += 1) {
    if (entries.has(key(parts.slice(0, length).join('/')))) return true;
  }
  return false;
}

function lineCount(text) {
  if (!text) return 0;
  const breaks = text.match(/\r\n|\r|\n/gu)?.length ?? 0;
  return breaks + (/(?:\r\n|\r|\n)$/u.test(text) ? 0 : 1);
}

function namesFromPattern(node) {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'RestElement') return namesFromPattern(node.argument);
  if (node.type === 'AssignmentPattern') return namesFromPattern(node.left);
  if (node.type === 'ArrayPattern') return node.elements.flatMap(namesFromPattern);
  if (node.type === 'ObjectPattern') return node.properties.flatMap((property) => namesFromPattern(property.value ?? property.argument));
  return [];
}

function exportNames(ast) {
  const result = new Set();
  let complete = true;
  for (const node of ast.body) {
    if (node.type === 'ExportDefaultDeclaration') result.add('default');
    if (node.type !== 'ExportNamedDeclaration') continue;
    if (node.declaration?.type === 'VariableDeclaration') {
      for (const declaration of node.declaration.declarations) for (const name of namesFromPattern(declaration.id)) result.add(name);
    } else if (node.declaration?.id) {
      for (const name of namesFromPattern(node.declaration.id)) result.add(name);
    }
    for (const specifier of node.specifiers ?? []) result.add(specifier.exported?.name ?? specifier.exported?.value);
  }
  if (ast.body.some((node) => node.type === 'ExportAllDeclaration')) complete = false;
  return { symbols: [...result].filter((name) => typeof name === 'string').sort(), complete };
}

function parseJavaScript(path, text, sha256) {
  const extension = extname(path).toLowerCase();
  if (!['.js', '.mjs', '.cjs'].includes(extension)) {
    return { symbol_status: 'unknown', symbols: undefined, relations: [], unresolved: [
      { kind: 'relation', path, sha256, reason: 'unsupported_language' },
    ] };
  }
  let ast;
  let commonJs = extension === '.cjs';
  try { ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); }
  catch (moduleError) {
    if (extension !== '.cjs' && /\.(?:mjs)$/u.test(path)) {
      return { symbol_status: 'unknown', symbols: undefined, relations: [], unresolved: [
        { kind: 'relation', path, sha256, line: moduleError.loc?.line ?? null, reason: 'unsupported_syntax' },
      ] };
    }
    try {
      ast = parse(text, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, locations: true });
      commonJs = true;
    } catch (scriptError) {
      return { symbol_status: 'unknown', symbols: undefined, relations: [], unresolved: [
        { kind: 'relation', path, sha256, line: scriptError.loc?.line ?? moduleError.loc?.line ?? null, reason: 'unsupported_syntax' },
      ] };
    }
  }
  const exports = exportNames(ast);
  const relations = [];
  const unresolved = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportExpression') {
      const specifier = node.source?.type === 'Literal' && typeof node.source.value === 'string' ? node.source.value : null;
      if (specifier) relations.push({ specifier, kind: 'inferred', line: node.loc?.start.line ?? 1, end_line: node.loc?.end.line ?? node.loc?.start.line ?? 1 });
      else unresolved.push({ kind: 'relation', path, sha256, line: node.loc?.start.line ?? null, reason: 'dynamic_import' });
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') {
      commonJs = true;
      const specifier = node.arguments?.length === 1 && node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string'
        ? node.arguments[0].value : null;
      if (specifier) relations.push({ specifier, kind: 'inferred', line: node.loc?.start.line ?? 1, end_line: node.loc?.end.line ?? node.loc?.start.line ?? 1 });
      else unresolved.push({ kind: 'relation', path, sha256, line: node.loc?.start.line ?? null, reason: 'commonjs_require' });
    }
    if (node.type === 'MemberExpression') {
      const property = node.computed ? node.property?.value : node.property?.name;
      if (node.object?.type === 'Identifier' && node.object.name === 'exports'
        || node.object?.type === 'Identifier' && node.object.name === 'module' && property === 'exports') commonJs = true;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child);
      } else if (value?.type) visit(value);
    }
  };
  for (const node of ast.body) {
    if ((node.type === 'ImportDeclaration' || ['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) && node.source) {
      relations.push({ specifier: node.source.value, kind: 'static', line: node.loc.start.line, end_line: node.loc.end.line });
    }
    visit(node);
  }
  const status = commonJs ? 'unknown' : exports.complete ? 'parsed' : 'partial';
  return {
    symbol_status: status,
    symbols: commonJs ? undefined : exports.symbols,
    relations,
    unresolved: commonJs ? [...unresolved, { kind: 'relation', path, sha256, reason: 'commonjs_symbols_unresolved' }] : unresolved,
  };
}

function sourceDescriptor(record) {
  return { path: record.path, sha256: record.sha256, bytes: record.bytes };
}

function inventoryDigest({ sources, exclusions, unresolved, scopeDigest }) {
  const entries = [
    ...sources.map((item) => ({ kind: 'source', path: item.path, sha256: item.sha256, bytes: item.bytes })),
    ...exclusions.map((item) => ({ kind: 'excluded', ...item })),
    ...unresolved.filter((item) => item.kind !== 'relation').map(({ kind: unresolvedKind, ...item }) => ({
      kind: 'unresolved', unresolved_kind: unresolvedKind, ...item,
    })),
  ].sort((a, b) => compareText(a.path, b.path) || compareText(a.kind, b.kind) || compareText(JSON.stringify(a), JSON.stringify(b)));
  return canonicalProviderDigest({ scope_digest: scopeDigest, entries });
}

/** Bounded full-workspace inventory. It only reads after scope, secret, link and size checks. */
export class RepositoryIndex {
  constructor(root, { policy, workspaceId, scopeDigest, budgets, excludedPaths = [], excludedSha256 = [] }) {
    this.root = root;
    this.policy = policy;
    this.workspaceId = workspaceId;
    this.scopeDigest = scopeDigest;
    this.budgets = budgets;
    this.excludedPaths = new Set(excludedPaths.map(key));
    this.excludedSha256 = new Set(excludedSha256);
  }

  async load(query, { signal } = {}) {
    const deadline = Date.now() + this.budgets.timeout_ms;
    const first = await this.collect({ signal, deadline });
    let collectionStable = false;
    if (first.coverage.enumeration.status === 'complete' && first.coverage.candidates.status === 'complete'
      && Date.now() < deadline) {
      const verification = await this.collect({ signal, deadline });
      collectionStable = verification.coverage.enumeration.status === 'complete'
        && verification.coverage.candidates.status === 'complete'
        && verification.inventory_digest === first.inventory_digest
        && verification.path_inventory_digest === first.path_inventory_digest;
      if (!collectionStable) {
        const reasonCode = verification.coverage.enumeration.reasons.length || verification.coverage.candidates.reasons.length
          ? 'verification_incomplete' : 'collection_changed';
        const reason = statusReason(reasonCode, '.');
        first.unresolved.push({ kind: 'collection', path: '.', reason: reasonCode });
        first.coverage.enumeration.status = 'partial';
        first.coverage.enumeration.reasons.push(reason);
        first.coverage.candidates.status = first.sources.length ? 'partial' : 'blocked';
        first.coverage.candidates.reasons.push(reason);
        first.inventory_digest = inventoryDigest({ ...first, scopeDigest: this.scopeDigest });
      }
    } else {
      if (first.coverage.enumeration.status === 'complete' && Date.now() >= deadline) {
        const reason = statusReason('verification_timeout');
        first.coverage.candidates.status = first.sources.length ? 'partial' : 'blocked';
        first.coverage.candidates.reasons.push(reason);
      }
    }
    const relations = [];
    const relationUnresolved = [];
    const sourceTexts = new Map(first._sourceTexts);
    const sourcePathMap = new Map(first.sources.map((source) => [key(source.path), source.path]));
    for (const source of first.sources) {
      check(signal);
      const analysis = parseJavaScript(source.path, sourceTexts.get(source.path), source.sha256);
      source.symbol_status = analysis.symbol_status;
      if (analysis.symbols !== undefined) source.symbols = analysis.symbols;
      relationUnresolved.push(...analysis.unresolved);
      for (const relation of analysis.relations) {
        const resolved = this.resolveRelation(source.path, relation.specifier, sourcePathMap);
        if (!resolved.path) {
          relationUnresolved.push({ kind: 'relation', source: { path: source.path, sha256: source.sha256, line_start: relation.line, line_end: relation.end_line }, specifier: relation.specifier, reason: resolved.reason });
          continue;
        }
        relations.push({ kind: relation.kind, source: { path: source.path, sha256: source.sha256, line_start: relation.line, line_end: relation.end_line }, target: { path: resolved.path, specifier: relation.specifier } });
      }
    }
    const candidates = first.sources.map((source) => ({
      kind: 'source-file',
      candidate_id: canonicalProviderDigest({ workspace_id: this.workspaceId, path: source.path }),
      path: source.path,
      sha256: source.sha256,
      line_count: source.line_count,
      symbol_status: source.symbol_status,
      ...(source.symbols !== undefined ? { symbols: source.symbols } : {}),
    }));
    const ranked = this.rank(candidates, sourceTexts, query);
    const unresolved = [...first.unresolved, ...relationUnresolved]
      .sort((a, b) => compareText(String(a.path ?? a.source?.path ?? ''), String(b.path ?? b.source?.path ?? '')) || compareText(String(a.reason), String(b.reason)));
    const relationIssues = relationUnresolved.length > 0;
    const parsedFiles = first.sources.filter((source) => source.symbol_status !== 'unknown').length;
    const relationStatus = !relationIssues ? 'complete_static' : parsedFiles ? 'partial' : 'unknown';
    return {
      protocol: 'sol-component-discovery/2',
      mode: 'repository',
      workspace_id: this.workspaceId,
      scope_digest: this.scopeDigest,
      inventory_digest: first.inventory_digest,
      path_inventory: first.path_inventory,
      path_inventory_digest: first.path_inventory_digest,
      collection_stable: collectionStable,
      query,
      versions: first.sources.map(({ path, sha256 }) => ({ path, sha256 })),
      sources: first.sources.map(sourceDescriptor),
      candidates: ranked,
      coverage: {
        enumeration: first.coverage.enumeration,
        candidates: first.coverage.candidates,
        relations: { status: relationStatus, count: relations.length, reasons: relationUnresolved.map((item) => statusReason(item.reason, item.path ?? item.source?.path)) },
      },
      relations: relations.sort((a, b) => compareText(a.source.path, b.source.path) || a.source.line_start - b.source.line_start || compareText(a.target.path, b.target.path)),
      unresolved,
      exclusions: first.exclusions.sort((a, b) => compareText(a.path, b.path)),
    };
  }

  async collect({ signal, deadline }) {
    const entries = new Map();
    const exclusions = [];
    const unresolved = [];
    const sources = [];
    const sourceTexts = new Map();
    const pathInventoryFiles = new Map();
    const pathInventoryDirectories = new Map();
    const ambiguousPathKeys = new Set();
    const pathInventoryIssues = new Set();
    const roots = [...this.policy.discovery_scope.roots].sort(compareText);
    const explicitFiles = [...this.policy.discovery_scope.files].sort(compareText);
    let pathCount = 0;
    let timedOut = false;
    let enumerationLimited = false;

    const addExclusion = (path, reason, details = {}) => exclusions.push({ path, reason, ...details });
    const addPathInventoryEntry = (kind, path) => {
      const normalized = key(path);
      if (!path || ambiguousPathKeys.has(normalized)) return;
      const own = kind === 'file' ? pathInventoryFiles : pathInventoryDirectories;
      const other = kind === 'file' ? pathInventoryDirectories : pathInventoryFiles;
      const existing = own.get(normalized) ?? other.get(normalized);
      if (existing !== undefined) {
        if (existing !== path || other.has(normalized)) {
          pathInventoryFiles.delete(normalized);
          pathInventoryDirectories.delete(normalized);
          ambiguousPathKeys.add(normalized);
          const reason = existing === path ? 'path_inventory_type_collision' : 'path_case_collision';
          const issueKey = `${normalized}:${reason}`;
          if (!pathInventoryIssues.has(issueKey)) {
            pathInventoryIssues.add(issueKey);
            unresolved.push({ kind: 'enumeration', path, reason });
          }
        }
        return;
      }
      if (kind === 'file' && hasPathAncestor(path, pathInventoryDirectories)) {
        unresolved.push({ kind: 'enumeration', path, reason: 'path_inventory_under_skipped_directory' });
        return;
      }
      if (kind === 'directory' && hasPathAncestor(path, pathInventoryFiles)) {
        unresolved.push({ kind: 'enumeration', path, reason: 'path_inventory_type_collision' });
        return;
      }
      if (pathInventoryFiles.size + pathInventoryDirectories.size >= MAX_ENUMERATED_ENTRIES) {
        enumerationLimited = true;
        return;
      }
      own.set(normalized, path);
    };
    const addSkippedDirectory = (path, reason) => {
      if (!path) return;
      addPathInventoryEntry('directory', path);
      addExclusion(path, reason);
    };
    const expired = () => {
      check(signal);
      if (Date.now() <= deadline) return false;
      timedOut = true;
      return true;
    };
    const visit = async (full, relativePath, { exactFile = false } = {}) => {
      if (expired() || enumerationLimited) return;
      if (relativePath) {
        // Enumeration paths originate only from configured roots/files; byte reads re-check the full policy.
        const parts = relativePath.split('/');
        let parent = this.root;
        for (let index = 0; index < parts.length - 1; index += 1) {
          const part = parts[index];
          parent = join(parent, part);
          const parentRelative = parts.slice(0, index + 1).join('/');
          let parentInfo;
          try { parentInfo = await lstat(parent, { bigint: true }); }
          catch (error) {
            unresolved.push({ kind: 'enumeration', path: relativePath, reason: error.code === 'ENOENT' ? 'path_disappeared' : 'path_unreadable', code: error.code ?? 'IO_ERROR' });
            return;
          }
          if (parentInfo.isSymbolicLink()) { addExclusion(relativePath, 'symbolic_link_parent'); return; }
          if (!parentInfo.isDirectory()) { unresolved.push({ kind: 'enumeration', path: relativePath, reason: 'parent_not_directory' }); return; }
          const directoryReason = providerPathExclusionReason(parentRelative);
          if (excludedDirectoryPath(parentRelative) || directoryReason) {
            const reason = excludedDirectoryPath(parentRelative)
              ? 'excluded_directory'
              : directoryReason === 'secret_file' ? 'secret_directory' : directoryReason;
            addSkippedDirectory(parentRelative, reason);
            return;
          }
          if (this.excludedPaths.has(key(parentRelative))) {
            addSkippedDirectory(parentRelative, 'authority-document');
            return;
          }
        }
      }
      let info;
      try { info = await lstat(full, { bigint: true }); }
      catch (error) {
        if (error.code === 'ENOENT') { unresolved.push({ kind: 'enumeration', path: relativePath || '.', reason: 'path_disappeared' }); return; }
        unresolved.push({ kind: 'enumeration', path: relativePath || '.', reason: 'path_unreadable', code: error.code ?? 'IO_ERROR' });
        return;
      }
      if (info.isSymbolicLink()) { addExclusion(relativePath, 'symbolic_link', { size: Number(info.size) }); return; }
      if (info.isDirectory()) {
        if (exactFile) { unresolved.push({ kind: 'enumeration', path: relativePath, reason: 'file_scope_is_directory' }); return; }
        const excluded = relativePath && providerPathExclusionReason(relativePath);
        const directoryReason = excludedDirectoryPath(relativePath) ? 'excluded_directory'
          : excluded === 'secret_file' ? 'secret_directory' : excluded;
        if (relativePath && this.excludedPaths.has(key(relativePath))) {
          addSkippedDirectory(relativePath, 'authority-document');
          return;
        }
        if (directoryReason) {
          addSkippedDirectory(relativePath, directoryReason);
          return;
        }
        let directory;
        try { directory = await opendir(full); }
        catch (error) { unresolved.push({ kind: 'enumeration', path: relativePath || '.', reason: 'directory_unreadable', code: error.code ?? 'IO_ERROR' }); return; }
        try {
          for await (const item of directory) {
            if (expired() || enumerationLimited) break;
            const child = relativePath ? `${relativePath}/${item.name}` : item.name;
            pathCount += 1;
            if (pathCount > MAX_ENUMERATED_ENTRIES) { enumerationLimited = true; break; }
            await visit(join(full, item.name), child);
          }
        } finally { await directory.close().catch(() => {}); }
        return;
      }
      if (!info.isFile()) { addExclusion(relativePath, 'special_file'); return; }
      addPathInventoryEntry('file', relativePath);
      if (enumerationLimited) return;
      if (this.excludedPaths.has(key(relativePath))) { addExclusion(relativePath, 'authority-document'); return; }
      const excluded = providerPathExclusionReason(relativePath);
      if (excluded) { addExclusion(relativePath, excluded); return; }
      entries.set(key(relativePath), { path: relativePath, stat: statShape(info), sourceLike: isSourceLike(relativePath) });
    };

    for (const root of roots) {
      if (expired()) break;
      const full = root === '.' ? this.root : join(this.root, ...root.split('/'));
      const relativePath = root === '.' ? '' : root;
      await visit(full, relativePath);
    }
    for (const path of explicitFiles) {
      if (expired()) break;
      await visit(join(this.root, ...path.split('/')), path, { exactFile: true });
    }
    if (timedOut) unresolved.push({ kind: 'enumeration', path: '.', reason: 'timeout' });
    if (enumerationLimited) unresolved.push({ kind: 'enumeration', path: '.', reason: 'enumeration_limit', limit: MAX_ENUMERATED_ENTRIES });

    const orderedEntries = [...entries.values()].sort((a, b) => compareText(a.path, b.path));
    let sourceByteCount = 0;
    let inspectedSourceCount = 0;
    let byteLimited = false;
    for (const entry of orderedEntries) {
      check(signal);
      if (!entry.sourceLike) { addExclusion(entry.path, 'binary_resource', { stat: entry.stat }); continue; }
      if (inspectedSourceCount >= this.budgets.max_sources) {
        unresolved.push({ kind: 'source', path: entry.path, reason: 'max_sources', stat: entry.stat });
        continue;
      }
      inspectedSourceCount += 1;
      if (entry.stat.size > this.budgets.max_file_bytes) {
        unresolved.push({ kind: 'source', path: entry.path, reason: 'max_file_bytes', bytes: entry.stat.size, stat: entry.stat });
        continue;
      }
      if (byteLimited || sourceByteCount + entry.stat.size > this.budgets.max_total_bytes) {
        byteLimited = true;
        unresolved.push({ kind: 'source', path: entry.path, reason: 'max_total_bytes', bytes: entry.stat.size, stat: entry.stat });
        continue;
      }
      if (expired()) {
        unresolved.push({ kind: 'source', path: entry.path, reason: 'timeout', stat: entry.stat });
        continue;
      }
      try {
        const full = await this.policy.assertReadPath(entry.path);
        const before = statShape(await lstat(full, { bigint: true }));
        if (!sameStat(entry.stat, before)) throw new SolFault('WORKSPACE_CHANGED', 'Repository file changed during inventory.');
        const bytes = await readWorkspaceBytes(this.root, entry.path, this.budgets.max_file_bytes, { signal });
        const after = statShape(await lstat(full, { bigint: true }));
        if (!sameStat(before, after) || !sameStat(entry.stat, after)) throw new SolFault('WORKSPACE_CHANGED', 'Repository file changed during inventory.');
        sourceByteCount += bytes.length;
        const digest = sha(bytes);
        if (this.excludedSha256.has(digest)) {
          addExclusion(entry.path, 'implementation-verdict');
          continue;
        }
        if (bytes.includes(0)) { addExclusion(entry.path, 'binary_content', { bytes: bytes.length, sha256: digest }); continue; }
        let text;
        try { text = decoder.decode(bytes); }
        catch {
          unresolved.push({ kind: 'source', path: entry.path, reason: 'invalid_utf8', bytes: bytes.length, sha256: digest });
          continue;
        }
        const record = { path: entry.path, sha256: digest, bytes: bytes.length, line_count: lineCount(text), symbol_status: 'unknown' };
        entries.set(key(entry.path), { ...entry, sha256: digest });
        sourceTexts.set(entry.path, text);
        sources.push(record);
      } catch (error) {
        if (error.code === 'INTERRUPTED' || error.code === 'HOST_STATE_ERROR') throw error;
        unresolved.push({ kind: 'source', path: entry.path, reason: error.code === 'WORKSPACE_CHANGED' ? 'source_changed' : error.code === 'SECURITY_DENIED' || error.code === 'PATH_ERROR' ? 'source_rejected' : 'source_unreadable', code: error.code ?? 'IO_ERROR', stat: entry.stat });
      }
    }
    const enumerationReasons = unresolved.filter((item) => item.kind === 'enumeration').map((item) => statusReason(item.reason, item.path));
    const sourceReasons = unresolved.filter((item) => item.kind === 'source').map((item) => statusReason(item.reason, item.path));
    const enumerationStatus = enumerationReasons.length ? 'partial' : 'complete';
    const sourceStatus = sourceReasons.length || enumerationReasons.length ? sources.length ? 'partial' : 'blocked' : 'complete';
    const digest = inventoryDigest({ sources, exclusions, unresolved, scopeDigest: this.scopeDigest });
    const pathInventory = {
      files: [...pathInventoryFiles.values()].sort(compareText),
      skipped_directories: [...pathInventoryDirectories.values()].sort(compareText),
    };
    return {
      sources,
      exclusions,
      unresolved,
      inventory_digest: digest,
      path_inventory: pathInventory,
      path_inventory_digest: canonicalProviderDigest(pathInventory),
      coverage: {
        enumeration: { status: enumerationStatus, count: pathInventory.files.length, reasons: enumerationReasons },
        candidates: { status: sourceStatus, count: sources.length, reasons: sourceReasons },
      },
      _sourceTexts: sourceTexts,
    };
  }

  resolveRelation(sourcePath, specifier, sourcePathMap) {
    if (!specifier.startsWith('.')) return { path: null, reason: 'external_dependency' };
    const base = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
    if (base === '..' || base.startsWith('../') || base.startsWith('/')) return { path: null, reason: 'outside_workspace' };
    const choices = [base, ...['.mjs', '.js', '.cjs', '.jsx', '.ts', '.tsx', '.json'].map((suffix) => `${base}${suffix}`),
      ...['index.mjs', 'index.js', 'index.cjs', 'index.jsx', 'index.ts', 'index.tsx'].map((file) => `${base}/${file}`)];
    for (const choice of choices) {
      try { this.policy.assertScoped(choice); }
      catch (error) {
        if (error.code === 'DISCOVERY_SCOPE_DENIED') return { path: null, reason: 'outside_discovery_scope' };
        if (error.code === 'PATH_ERROR') return { path: null, reason: 'outside_workspace' };
        throw error;
      }
      const resolvedPath = sourcePathMap.get(key(choice));
      if (resolvedPath) return { path: resolvedPath };
    }
    return { path: null, reason: 'target_unresolved' };
  }

  rank(candidates, sourceTexts, query) {
    const tokens = query.capability.toLowerCase().split(/[\s,，。;；]+/u).filter(Boolean);
    const wantedPaths = new Set(query.paths.map(key));
    const score = (candidate) => {
      const haystack = `${candidate.path} ${sourceTexts.get(candidate.path) ?? ''}`.toLowerCase();
      return (wantedPaths.has(key(candidate.path)) ? 1000 : 0) + tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
    };
    return candidates.sort((a, b) => score(b) - score(a) || compareText(a.path, b.path));
  }
}
