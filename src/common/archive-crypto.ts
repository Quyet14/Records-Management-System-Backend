import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';

// v1: magic(8), key id(32), salt(16), plaintext length(8), SHA-256(32).
// Each 1 MiB chunk has its own 16-byte GCM tag. The entire header and chunk
// index are AAD; size/count prevent truncation, index prevents reordering.
const MAGIC = Buffer.from('LTHSAE01');
const HEADER_SIZE = 96;
const CHUNK_SIZE = 1024 * 1024;
const TAG_SIZE = 16;
export const encryptionEnabled = () => process.env.ARCHIVE_ENCRYPTION_ENABLED !== 'false';
const allowLegacy = () => process.env.ARCHIVE_ALLOW_LEGACY_READ === 'true'
  || (!encryptionEnabled() && process.env.NODE_ENV !== 'production');
export function within(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
export function loadArchiveKeys(): { current: string; keys: Record<string, Buffer> } {
  const filename = process.env.ARCHIVE_KEY_FILE;
  if (!filename || !path.isAbsolute(filename)) throw new Error('ARCHIVE_KEY_FILE must be an absolute path outside the project and data roots.');
  const real = fs.realpathSync(filename);
  const excluded = [process.cwd(), process.env.UPLOAD_ARCHIVE_DIR, process.env.UPLOAD_STAGING_DIR,
    process.env.PERSONAL_STORAGE_DIR, process.env.BACKUP_DIR, process.env.DESTRUCTION_STATE_DIR,
    process.env.DESTRUCTION_BACKUP_STAGING_ROOT, process.env.WEB_ROOT,
    process.env.DOCUMENT_READABLE_DIR].filter(Boolean) as string[];
  if (excluded.some(root => within(root, filename) || within(fs.existsSync(root) ? fs.realpathSync(root) : root, real)))
    throw new Error('Archive keys must be outside the project, web root, storage, journals and backup roots.');
  const stat = fs.statSync(real);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077)))
    throw new Error('Archive key file must be private to the service account (0600; Windows: restrictive ACL).');
  let ring: any;
  try { ring = JSON.parse(fs.readFileSync(real, 'utf8')); }
  catch { throw new Error('Invalid archive keyring JSON.'); }
  const keys: Record<string, Buffer> = Object.create(null);
  for (const [id, value] of Object.entries(ring.keys ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value))
      throw new Error('Invalid archive key id or base64 AES-256 key.');
    keys[id] = Buffer.from(value, 'base64');
    if (keys[id].length !== 32) throw new Error('Archive keys must contain exactly 32 random bytes.');
  }
  if (!Object.hasOwnProperty.call(keys, ring.current)) throw new Error('Missing active archive key.');
  return { current: ring.current, keys };
}
export function validateArchiveConfiguration() {
  if (process.env.NODE_ENV === 'production') {
    if (!encryptionEnabled()) throw new Error('Archive encryption cannot be disabled in production.');
    const webRoot = process.env.WEB_ROOT;
    if (!webRoot || !path.isAbsolute(webRoot)) throw new Error('Set an absolute WEB_ROOT to validate private storage isolation.');
    for (const name of ['UPLOAD_ARCHIVE_DIR', 'UPLOAD_STAGING_DIR', 'PERSONAL_STORAGE_DIR']) {
      const root = process.env[name];
      if (!root || !path.isAbsolute(root) || within(process.cwd(), root) || within(webRoot, root))
        throw new Error(`${name} must be absolute and outside the project and WEB_ROOT.`);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const real = fs.realpathSync(root);
      if (within(fs.realpathSync(process.cwd()), real) || within(fs.existsSync(webRoot) ? fs.realpathSync(webRoot) : webRoot, real))
        throw new Error(`${name} resolves inside a public/project directory.`);
    }
  }
  if (encryptionEnabled()) loadArchiveKeys();
}
function integrityError(): never {
  throw new ConflictException({ code: 'FILE_INTEGRITY_FAILED', message: 'Không thể xác minh tính toàn vẹn của file. Vui lòng liên hệ quản trị viên.' });
}
export function privateContentPath(filename: string): string {
  const absolute = path.resolve(filename);
  const roots = [process.env.UPLOAD_ARCHIVE_DIR || './storage/archive', process.env.UPLOAD_STAGING_DIR || './storage/staging',
    process.env.PERSONAL_STORAGE_DIR || './storage/personal'];
  const root = roots.map(value => path.resolve(value)).find(value => within(value, absolute) && value !== absolute);
  if (!root) integrityError();
  const realRoot = fs.realpathSync(root);
  let cursor = root;
  for (const component of path.relative(root, absolute).split(path.sep)) {
    cursor = path.join(cursor, component);
    if (fs.lstatSync(cursor).isSymbolicLink() || !within(realRoot, fs.realpathSync(cursor))) integrityError();
  }
  return absolute;
}
async function readExactly(handle: fs.promises.FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) integrityError();
    offset += bytesRead;
  }
  return buffer;
}
const chunkCount = (size: number) => Math.max(1, Math.ceil(size / CHUNK_SIZE));
function nonce(index: number): Buffer { const value = Buffer.alloc(12); value.writeUInt32BE(index, 8); return value; }
function fileKey(key: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', key, salt, Buffer.from('lths-archive-v1'), 32));
}
export async function rawChecksum(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export async function encryptArchiveFile(source: string, destination: string, expectedHash: string): Promise<void> {
  if (!encryptionEnabled()) {
    if (process.env.NODE_ENV === 'production') throw new Error('Encryption required.');
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    return;
  }
  const ring = loadArchiveKeys(), input = await fs.promises.open(source, 'r');
  const partial = `${destination}.partial`;
  let output: fs.promises.FileHandle | undefined;
  try {
    const size = (await input.stat()).size;
    if (!Number.isSafeInteger(size) || chunkCount(size) > 0x100000000 || !/^[a-f0-9]{64}$/i.test(expectedHash)) integrityError();
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(header); header.write(ring.current, 8, 32, 'ascii');
    randomBytes(16).copy(header, 40); header.writeBigUInt64BE(BigInt(size), 56);
    Buffer.from(expectedHash, 'hex').copy(header, 64);
    const key = fileKey(ring.keys[ring.current], header.subarray(40, 56));
    output = await fs.promises.open(partial, 'wx', 0o600);
    await output.writeFile(header);
    const hash = createHash('sha256');
    for (let index = 0; index < chunkCount(size); index++) {
      const bytes = await readExactly(input, Math.min(CHUNK_SIZE, size - index * CHUNK_SIZE), index * CHUNK_SIZE);
      hash.update(bytes);
      const iv = nonce(index), cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_SIZE });
      cipher.setAAD(Buffer.concat([header, iv]));
      await output.writeFile(Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]));
    }
    if (hash.digest('hex') !== expectedHash || (await input.stat()).size !== size) integrityError();
    await output.sync(); await output.close(); output = undefined;
    await fs.promises.rename(partial, destination);
  } catch (error) {
    await output?.close(); await fs.promises.unlink(partial).catch(() => undefined); throw error;
  } finally { await input.close(); }
}
// No plaintext chunk is released before its GCM tag has been verified.
export async function* archiveChunks(filename: string, expectedHash?: string): AsyncGenerator<Buffer> {
  filename = privateContentPath(filename);
  const handle = await fs.promises.open(filename, 'r');
  try {
    const stat = await handle.stat();
    const prefix = Buffer.alloc(8); await handle.read(prefix, 0, 8, 0);
    if (!prefix.equals(MAGIC)) {
      if (!allowLegacy()) throw new ServiceUnavailableException('File cũ chưa mã hóa. Cần chạy chuyển đổi kho trước khi cấp nội dung.');
      const actual = await rawChecksum(filename);
      if (expectedHash && actual !== expectedHash) integrityError();
      for (let offset = 0; offset < stat.size; offset += CHUNK_SIZE)
        yield await readExactly(handle, Math.min(CHUNK_SIZE, stat.size - offset), offset);
      return;
    }
    const header = await readExactly(handle, HEADER_SIZE, 0);
    const id = header.subarray(8, 40).toString('ascii').replace(/\0+$/, '');
    const key = loadArchiveKeys().keys[id];
    if (!key) throw new ServiceUnavailableException('Không có khóa giải mã phiên bản file này.');
    const size = Number(header.readBigUInt64BE(56)), storedHash = header.subarray(64, 96).toString('hex');
    if (!Number.isSafeInteger(size) || chunkCount(size) > 0x100000000
      || stat.size !== HEADER_SIZE + size + TAG_SIZE * chunkCount(size)
      || (expectedHash && expectedHash !== storedHash)) integrityError();
    const derived = fileKey(key, header.subarray(40, 56)), hash = createHash('sha256');
    for (let index = 0; index < chunkCount(size); index++) {
      const length = Math.min(CHUNK_SIZE, size - index * CHUNK_SIZE);
      const sealed = await readExactly(handle, length + TAG_SIZE, HEADER_SIZE + index * (CHUNK_SIZE + TAG_SIZE));
      const iv = nonce(index), decipher = createDecipheriv('aes-256-gcm', derived, iv, { authTagLength: TAG_SIZE });
      decipher.setAAD(Buffer.concat([header, iv])); decipher.setAuthTag(sealed.subarray(length));
      let bytes: Buffer;
      try { bytes = Buffer.concat([decipher.update(sealed.subarray(0, length)), decipher.final()]); }
      catch { integrityError(); }
      hash.update(bytes); yield bytes;
    }
    if (hash.digest('hex') !== storedHash) integrityError();
  } finally { await handle.close(); }
}
export async function archiveChecksum(filename: string, expectedHash?: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of archiveChunks(filename, expectedHash)) hash.update(bytes);
  return hash.digest('hex');
}
export async function readArchiveBuffer(filename: string, expectedHash: string, maxBytes = 100 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const bytes of archiveChunks(filename, expectedHash)) {
    size += bytes.length;
    if (size > maxBytes) throw new BadRequestException('File vượt giới hạn xử lý trong bộ nhớ.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
export const archiveStream = (filename: string, expectedHash: string) => Readable.from(archiveChunks(filename, expectedHash));
