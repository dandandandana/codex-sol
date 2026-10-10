import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, statfs } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { assertContract } from './schema.mjs';

const HANDLE_RE = /^[A-Za-z0-9_-]{16,128}$/u;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const CHUNK_BYTES = 64 * 1024;
const META_BYTES = 64 * 1024;

export class SolFault extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = 'SolFault';
    this.code = code;
    this.retryable = retryable;
  }
}

export function interruptionFault(signal, message) {
  return signal?.reason?.code === 'HOST_STATE_ERROR' ? signal.reason : new SolFault('INTERRUPTED', message);
}

function isFsError(error, code) {
  return error && typeof error === 'object' && error.code === code;
}

function ioFault(error) {
  if (error instanceof SolFault) return error;
  if (isFsError(error, 'ENOENT')) return new SolFault('NOT_FOUND', 'Observation handle was not found.');
  if (error instanceof SyntaxError) return new SolFault('CORRUPT', 'Observation metadata is not valid JSON.');
  return new SolFault('IO_ERROR', `Could not read observation: ${error.message ?? String(error)}`, true);
}

async function safeDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isFsError(error, 'EEXIST')) throw error;
  }
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new SolFault('STORAGE_ERROR', 'Runtime storage path is not a regular directory.');
  }
}

async function safeDirectoryTree(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (!isFsError(error, 'EEXIST')) throw error; }
    const stats = await lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new SolFault('STORAGE_ERROR', 'Explicit cache root may not contain a symbolic link or non-directory path.');
    }
  }
  return absolute;
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isOperationObservationCache(workspaceRoot, cacheRoot, pathKey) {
  const relativePath = relative(workspaceRoot, cacheRoot).split(sep).join('/');
  const normalizedPath = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
  return /^\.codex\/engineering-cycle\/provider-cache\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/observations$/u.test(normalizedPath)
    && isWithin(pathKey(workspaceRoot), pathKey(cacheRoot));
}

function assertCacheLocation(workspaceRoot, cacheRoot, pathKey) {
  const workspaceKey = pathKey(workspaceRoot);
  const cacheKey = pathKey(cacheRoot);
  const insideWorkspace = isWithin(workspaceKey, cacheKey);
  const containsWorkspace = isWithin(cacheKey, workspaceKey);
  if ((insideWorkspace || containsWorkspace)
    && !(insideWorkspace && isOperationObservationCache(workspaceKey, cacheKey, pathKey))) {
    throw new SolFault('STORAGE_ERROR', 'Explicit observation cache root must be separate from the workspace or use the dedicated operation cache path.');
  }
}

async function validateCacheRoot(workspaceRoot, cacheRoot) {
  if (typeof cacheRoot !== 'string' || !isAbsolute(cacheRoot)) {
    throw new SolFault('STORAGE_ERROR', 'Explicit observation cache root must be an absolute path.');
  }
  const canonicalWorkspace = await realpath(resolve(workspaceRoot));
  const workspaceStats = await lstat(canonicalWorkspace);
  if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
    throw new SolFault('STORAGE_ERROR', 'Workspace root is not a regular directory.');
  }
  const resolvedCache = resolve(cacheRoot);
  const pathKey = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
  assertCacheLocation(canonicalWorkspace, resolvedCache, pathKey);
  const safeCache = await safeDirectoryTree(resolvedCache);
  const canonicalCache = await realpath(safeCache);
  assertCacheLocation(canonicalWorkspace, canonicalCache, pathKey);
  return { workspaceRoot: canonicalWorkspace, cacheRoot: canonicalCache };
}

async function requireRegular(path) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new SolFault('CORRUPT', 'Observation object is not a regular file.');
  return stats;
}

async function hashFile(file, signal) {
  const digest = createHash('sha256');
  const block = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = 0;
  while (true) {
    checkSignal(signal);
    const { bytesRead } = await file.read(block, 0, block.length, position);
    if (bytesRead === 0) break;
    digest.update(block.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { sha256: digest.digest('hex'), bytes: position };
}

function checkSignal(signal) {
  if (signal?.aborted) throw interruptionFault(signal, 'Observation reading was interrupted.');
}

function sameFile(before, after) {
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => before[key] === after[key]);
}

async function readMeta(directory) {
  const path = join(directory, 'meta.json');
  const before = await requireRegular(path);
  if (before.size > META_BYTES) throw new SolFault('CORRUPT', 'Observation metadata exceeds its storage limit.');
  const file = await open(path, READ_FLAGS);
  try {
    const opened = await file.stat();
    if (!sameFile(before, opened)) throw new SolFault('CORRUPT', 'Observation metadata changed while opening.');
    const bytes = await readExact(file, 0, opened.size);
    if (!sameFile(opened, await file.stat()) || !sameFile(opened, await requireRegular(path))) {
      throw new SolFault('CORRUPT', 'Observation metadata changed while reading.');
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { throw new SolFault('CORRUPT', 'Observation metadata is not valid UTF-8 JSON.'); }
  } finally { await file.close(); }
}

function validateStoredMeta(meta, handle, workspaceId) {
  try {
    const { handle: storedHandle, bytes, sha256, index_sha256, complete, line_count, ...capture } = meta;
    assertContract('CaptureMeta', capture);
    assertContract('RawRef', { schema_version: 1, handle: storedHandle, bytes, sha256, complete, media_type: meta.media_type });
    if (storedHandle !== handle || capture.workspace_id !== workspaceId || !/^[a-f0-9]{64}$/u.test(index_sha256)
      || !Number.isSafeInteger(bytes) || !Number.isSafeInteger(line_count) || line_count < 0) throw new Error('invalid metadata');
  } catch { throw new SolFault('CORRUPT', 'Observation metadata is invalid.'); }
}

async function readExact(file, start, length) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, start + filled);
    if (bytesRead === 0) throw new SolFault('CORRUPT', 'Observation object ended unexpectedly.');
    filled += bytesRead;
  }
  return buffer;
}

class CaptureWriter {
  constructor(store, meta, handle, tempDirectory, raw, index) {
    this.store = store;
    this.meta = meta;
    this.handle = handle;
    this.tempDirectory = tempDirectory;
    this.raw = raw;
    this.index = index;
    this.rawHash = createHash('sha256');
    this.indexHash = createHash('sha256');
    this.bytes = 0;
    this.newlineCount = 0;
    this.lastByte = null;
    this.state = 'open';
    this.busy = false;
  }

  async initialize() {
    const zero = Buffer.alloc(8);
    await this.index.writeFile(zero);
    this.indexHash.update(zero);
    return this;
  }

  async write(chunk) {
    if (this.state !== 'open' || this.busy) throw new SolFault('STORAGE_ERROR', 'Capture writer is closed or busy.');
    if (!(chunk instanceof Uint8Array)) throw new TypeError('Capture chunk must be bytes.');
    this.busy = true;
    try {
      const bytes = Buffer.from(chunk);
      await this.raw.writeFile(bytes);
      this.rawHash.update(bytes);
      const offsets = [];
      for (let i = 0; i < bytes.length; i += 1) {
        if (bytes[i] === 0x0a) offsets.push(this.bytes + i + 1);
      }
      if (offsets.length) {
        const encoded = Buffer.allocUnsafe(offsets.length * 8);
        offsets.forEach((offset, i) => encoded.writeBigUInt64LE(BigInt(offset), i * 8));
        await this.index.writeFile(encoded);
        this.indexHash.update(encoded);
      }
      this.bytes += bytes.length;
      this.newlineCount += offsets.length;
      if (bytes.length) this.lastByte = bytes[bytes.length - 1];
    } catch (error) {
      this.state = 'failed';
      await Promise.allSettled([this.raw.close(), this.index.close()]);
      throw new SolFault('STORAGE_ERROR', `Capture write failed: ${error.message ?? String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  async commit({ complete }) {
    if (this.state !== 'open' || this.busy) throw new SolFault('STORAGE_ERROR', 'Capture cannot be committed.');
    if (typeof complete !== 'boolean') throw new TypeError('complete must be boolean.');
    this.state = 'committing';
    let metaFile;
    try {
      await this.raw.sync();
      await this.index.sync();
      await this.raw.close();
      await this.index.close();
      const sha256 = this.rawHash.digest('hex');
      const indexSha256 = this.indexHash.digest('hex');
      const lineCount = this.bytes === 0 ? 0 : this.newlineCount + (this.lastByte === 0x0a ? 0 : 1);
      const storedMeta = {
        ...this.meta,
        handle: this.handle,
        bytes: this.bytes,
        sha256,
        index_sha256: indexSha256,
        complete,
        line_count: lineCount,
      };
      metaFile = await open(join(this.tempDirectory, 'meta.json'), 'wx', 0o600);
      await metaFile.writeFile(JSON.stringify(storedMeta), 'utf8');
      await metaFile.sync();
      await metaFile.close();
      metaFile = undefined;
      await rename(this.tempDirectory, join(this.store.observationsRoot, this.handle));
      this.state = 'committed';
      const ref = { schema_version: 1, handle: this.handle, sha256, bytes: this.bytes, media_type: this.meta.media_type, complete };
      return assertContract('RawRef', ref);
    } catch (error) {
      this.state = 'failed';
      await Promise.allSettled([this.raw.close(), this.index.close(), metaFile?.close()]);
      throw new SolFault('STORAGE_ERROR', `Capture commit failed: ${error.message ?? String(error)}`);
    }
  }

  async abort() {
    if (this.state === 'committed') return;
    this.state = 'failed';
    await Promise.allSettled([this.raw.close(), this.index.close()]);
  }
}

export class ObservationStore {
  constructor(workspaceRoot, { cacheRoot } = {}) {
    this.workspaceRoot = workspaceRoot;
    this.workspaceId = createHash('sha256').update(process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot).digest('hex');
    this.solRoot = join(workspaceRoot, '.codex', 'sol');
    this.cacheRoot = cacheRoot;
    this.observationsRoot = join(cacheRoot ?? this.solRoot, 'observations');
  }

  async initialize() {
    if (this.cacheRoot !== undefined) {
      const validated = await validateCacheRoot(this.workspaceRoot, this.cacheRoot);
      this.workspaceRoot = validated.workspaceRoot;
      this.workspaceId = createHash('sha256').update(process.platform === 'win32' ? this.workspaceRoot.toLowerCase() : this.workspaceRoot).digest('hex');
      this.solRoot = join(this.workspaceRoot, '.codex', 'sol');
      this.cacheRoot = validated.cacheRoot;
      this.observationsRoot = join(this.cacheRoot, 'observations');
    }
    await safeDirectory(join(this.workspaceRoot, '.codex'));
    await safeDirectory(this.solRoot);
    if (this.cacheRoot) await safeDirectory(this.cacheRoot);
    await safeDirectory(this.observationsRoot);
    return this;
  }

  async beginCapture(meta) {
    assertContract('CaptureMeta', meta);
    if (meta.workspace_id !== this.workspaceId) throw new SolFault('STORAGE_ERROR', 'Capture workspace does not match this store.');
    let disk;
    try {
      disk = await statfs(this.observationsRoot);
    } catch (error) {
      throw new SolFault('STORAGE_ERROR', `Cannot check free space: ${error.message ?? String(error)}`);
    }
    if (Number(disk.bavail) * Number(disk.bsize) < 1024 * 1024) {
      throw new SolFault('STORAGE_ERROR', 'Less than 1 MiB is available for capture.');
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const handle = randomBytes(24).toString('base64url');
      const tempDirectory = join(this.observationsRoot, `.${handle}.tmp`);
      try {
        await mkdir(tempDirectory, { mode: 0o700 });
      } catch (error) {
        if (isFsError(error, 'EEXIST')) continue;
        throw new SolFault('STORAGE_ERROR', `Cannot start capture: ${error.message ?? String(error)}`);
      }
      let raw;
      let index;
      try {
        raw = await open(join(tempDirectory, 'raw'), 'wx', 0o600);
        index = await open(join(tempDirectory, 'lines.idx'), 'wx', 0o600);
        return await new CaptureWriter(this, meta, handle, tempDirectory, raw, index).initialize();
      } catch (error) {
        await Promise.allSettled([raw?.close(), index?.close()]);
        throw new SolFault('STORAGE_ERROR', `Cannot create capture files: ${error.message ?? String(error)}`);
      }
    }
    throw new SolFault('STORAGE_ERROR', 'Could not allocate an observation handle.');
  }

  /**
   * Private collectors may retain bounded candidates, but must not publish chunks.
   * onChunk receives borrowed, read-only bytes, valid only during that callback.
   * finish runs only after complete raw/index verification and metadata recheck.
   * No raw descriptor escapes; success, failure and cancellation close every fd.
   */
  async withVerifiedRead(handle, createCollector = () => ({}), { signal, expectedMeta, validateMeta } = {}) {
    checkSignal(signal);
    if (!HANDLE_RE.test(handle)) throw new SolFault('NOT_FOUND', 'Observation handle was not found.');
    const directory = join(this.observationsRoot, handle);
    let raw;
    let index;
    let failed = false;
    try {
      const dirStats = await lstat(directory);
      if (!dirStats.isDirectory() || dirStats.isSymbolicLink()) throw new SolFault('CORRUPT', 'Observation directory is not regular.');
      const meta = await readMeta(directory);
      validateStoredMeta(meta, handle, this.workspaceId);
      Object.freeze(meta);
      const identity = JSON.stringify(meta);
      if (expectedMeta && identity !== JSON.stringify(expectedMeta)) throw new SolFault('CORRUPT', 'Observation identity changed between verified scans.');
      await validateMeta?.(meta);
      const collector = await createCollector(meta);
      const rawPath = join(directory, 'raw');
      const indexPath = join(directory, 'lines.idx');
      const rawBefore = await requireRegular(rawPath);
      const indexBefore = await requireRegular(indexPath);
      if (rawBefore.size !== meta.bytes) throw new SolFault('CORRUPT', 'Observation byte count does not match metadata.');
      raw = await open(rawPath, READ_FLAGS);
      index = await open(indexPath, READ_FLAGS);
      if (!sameFile(rawBefore, await raw.stat()) || !sameFile(indexBefore, await index.stat())) {
        throw new SolFault('CORRUPT', 'Observation files changed while opening.');
      }
      const digest = createHash('sha256');
      const expectedIndex = createHash('sha256').update(Buffer.alloc(8));
      const offsets = Buffer.allocUnsafe(CHUNK_BYTES);
      const block = Buffer.allocUnsafe(CHUNK_BYTES);
      let position = 0;
      let newlines = 0;
      let lastByte;
      while (true) {
        checkSignal(signal);
        const { bytesRead } = await raw.read(block, 0, block.length, position);
        if (!bytesRead) break;
        if (position + bytesRead > meta.bytes) throw new SolFault('CORRUPT', 'Observation grew during verification.');
        const chunk = block.subarray(0, bytesRead);
        digest.update(chunk);
        let filled = 0;
        for (let i = 0; i < bytesRead; i += 1) {
          if (chunk[i] !== 10) continue;
          offsets.writeBigUInt64LE(BigInt(position + i + 1), filled);
          filled += 8;
          newlines += 1;
          if (filled === offsets.length) { expectedIndex.update(offsets); filled = 0; }
        }
        if (filled) expectedIndex.update(offsets.subarray(0, filled));
        lastByte = chunk[bytesRead - 1];
        await collector.onChunk?.(chunk, position);
        position += bytesRead;
      }
      const indexHash = await hashFile(index, signal);
      const lineCount = position === 0 ? 0 : newlines + (lastByte === 10 ? 0 : 1);
      if (position !== meta.bytes || digest.digest('hex') !== meta.sha256
        || indexHash.sha256 !== meta.index_sha256 || expectedIndex.digest('hex') !== meta.index_sha256
        || indexHash.bytes !== (newlines + 1) * 8 || lineCount !== meta.line_count) {
        throw new SolFault('CORRUPT', 'Observation content or line index failed verification.');
      }
      checkSignal(signal);
      if (identity !== JSON.stringify(await readMeta(directory))
        || !sameFile(rawBefore, await raw.stat()) || !sameFile(rawBefore, await requireRegular(rawPath))
        || !sameFile(indexBefore, await index.stat()) || !sameFile(indexBefore, await requireRegular(indexPath))) {
        throw new SolFault('CORRUPT', 'Observation changed during verification.');
      }
      checkSignal(signal);
      const value = await collector.finish?.();
      checkSignal(signal);
      return { meta, value };
    } catch (error) {
      failed = true;
      throw ioFault(error);
    } finally {
      const closed = await Promise.allSettled([raw?.close(), index?.close()]);
      if (!failed && closed.some((entry) => entry.status === 'rejected')) {
        throw new SolFault('IO_ERROR', 'Could not close verified observation files.', true);
      }
      if (!failed) checkSignal(signal);
    }
  }

  async verify(handle, options = {}) {
    const { meta } = await this.withVerifiedRead(handle, undefined, options);
    return { meta };
  }

  /** Legacy full read. Production record callers must pass their own maxBytes. */
  async readVerified(handle, { maxBytes = Infinity, ...options } = {}) {
    if (!(maxBytes === Infinity || Number.isSafeInteger(maxBytes) && maxBytes >= 0)) throw new TypeError('maxBytes must be a nonnegative safe integer.');
    const { meta, value: buffer } = await this.withVerifiedRead(handle, (meta) => {
      if (meta.bytes > maxBytes) throw new SolFault('INPUT_LIMIT', 'Observation exceeds the verified read byte limit.');
      const candidate = Buffer.alloc(meta.bytes);
      return { onChunk: (chunk, start) => { chunk.copy(candidate, start); }, finish: () => candidate };
    }, options);
    return { meta, buffer };
  }

  async readVerifiedText(handle, { maxBytes = 256 * 1024, ...options } = {}) {
    const { meta, buffer } = await this.readVerified(handle, { maxBytes, ...options });
    try { return { meta, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer) }; }
    catch { throw new SolFault('UNSUPPORTED_ENCODING', 'Observation is not valid UTF-8 text.'); }
  }

  async readVerifiedJSON(handle, options = {}) {
    const { meta, text } = await this.readVerifiedText(handle, options);
    try { return { meta, value: JSON.parse(text) }; }
    catch { throw new SolFault('CORRUPT', 'Observation record is not valid JSON.'); }
  }

  /** @deprecated Bare handles do not guarantee any subsequent read is verified. */
  async openVerified(handle) {
    const { meta } = await this.verify(handle);
    let raw;
    let index;
    try {
      const directory = join(this.observationsRoot, handle);
      raw = await open(join(directory, 'raw'), READ_FLAGS);
      index = await open(join(directory, 'lines.idx'), READ_FLAGS);
      return { meta, raw, index, close: async () => { await Promise.allSettled([raw.close(), index.close()]); } };
    } catch (error) {
      await Promise.allSettled([raw?.close(), index?.close()]);
      throw ioFault(error);
    }
  }
}

export async function createObservationStore(workspaceRoot, { cacheRoot } = {}) {
  const canonical = await realpath(resolve(workspaceRoot));
  const stats = await lstat(canonical);
  if (!stats.isDirectory()) throw new SolFault('STORAGE_ERROR', 'Workspace root is not a directory.');
  return new ObservationStore(canonical, { cacheRoot }).initialize();
}

export async function readIndexOffset(index, position) {
  const raw = await readExact(index, position * 8, 8);
  const value = raw.readBigUInt64LE(0);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new SolFault('CORRUPT', 'Line offset exceeds supported file size.');
  return Number(value);
}

export async function readRawSlice(raw, start, length) {
  return readExact(raw, start, length);
}
