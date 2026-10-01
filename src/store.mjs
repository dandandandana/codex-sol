import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertContract } from './schema.mjs';

const HANDLE_RE = /^[A-Za-z0-9_-]{16,128}$/u;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const CHUNK_BYTES = 64 * 1024;

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

async function requireRegular(path) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new SolFault('CORRUPT', 'Observation object is not a regular file.');
  return stats;
}

async function hashFile(file) {
  const digest = createHash('sha256');
  const block = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = 0;
  while (true) {
    const { bytesRead } = await file.read(block, 0, block.length, position);
    if (bytesRead === 0) break;
    digest.update(block.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { sha256: digest.digest('hex'), bytes: position };
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
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.workspaceId = createHash('sha256').update(process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot).digest('hex');
    this.solRoot = join(workspaceRoot, '.codex', 'sol');
    this.observationsRoot = join(this.solRoot, 'observations');
  }

  async initialize() {
    await safeDirectory(join(this.workspaceRoot, '.codex'));
    await safeDirectory(this.solRoot);
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

  async openVerified(handle) {
    if (!HANDLE_RE.test(handle)) throw new SolFault('NOT_FOUND', 'Observation handle was not found.');
    const directory = join(this.observationsRoot, handle);
    let raw;
    let index;
    try {
      const dirStats = await lstat(directory);
      if (!dirStats.isDirectory() || dirStats.isSymbolicLink()) throw new SolFault('CORRUPT', 'Observation directory is not regular.');
      await requireRegular(join(directory, 'meta.json'));
      await requireRegular(join(directory, 'raw'));
      await requireRegular(join(directory, 'lines.idx'));
      const metaFile = await open(join(directory, 'meta.json'), READ_FLAGS);
      let meta;
      try {
        meta = JSON.parse(await metaFile.readFile('utf8'));
      } finally {
        await metaFile.close();
      }
      if (meta.handle !== handle || meta.workspace_id !== this.workspaceId || !Number.isSafeInteger(meta.bytes) || meta.bytes < 0 || !/^[a-f0-9]{64}$/u.test(meta.sha256) || !/^[a-f0-9]{64}$/u.test(meta.index_sha256) || !Number.isSafeInteger(meta.line_count) || meta.line_count < 0) {
        throw new SolFault('CORRUPT', 'Observation metadata is invalid.');
      }
      raw = await open(join(directory, 'raw'), READ_FLAGS);
      index = await open(join(directory, 'lines.idx'), READ_FLAGS);
      const rawHash = await hashFile(raw);
      const indexHash = await hashFile(index);
      const endsWithLf = meta.bytes > 0 && (await readExact(raw, meta.bytes - 1, 1))[0] === 0x0a;
      const indexEntries = meta.bytes === 0 ? 1 : meta.line_count + (endsWithLf ? 1 : 0);
      if (rawHash.bytes !== meta.bytes || rawHash.sha256 !== meta.sha256 || indexHash.sha256 !== meta.index_sha256 || indexHash.bytes !== indexEntries * 8) {
        throw new SolFault('CORRUPT', 'Observation content or line index failed verification.');
      }
      return { meta, raw, index, close: async () => { await Promise.allSettled([raw.close(), index.close()]); } };
    } catch (error) {
      await Promise.allSettled([raw?.close(), index?.close()]);
      throw ioFault(error);
    }
  }

  async readVerified(handle) {
    const opened = await this.openVerified(handle);
    try {
      return { meta: opened.meta, buffer: await readExact(opened.raw, 0, opened.meta.bytes) };
    } finally {
      await opened.close();
    }
  }
}

export async function createObservationStore(workspaceRoot) {
  const canonical = await realpath(resolve(workspaceRoot));
  const stats = await lstat(canonical);
  if (!stats.isDirectory()) throw new SolFault('STORAGE_ERROR', 'Workspace root is not a directory.');
  return new ObservationStore(canonical).initialize();
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
