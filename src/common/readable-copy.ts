import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { archiveChunks, rawChecksum, within } from './archive-crypto';
import { normalizeUploadFilename } from './upload-filename';

/** Optional plaintext copies, explicitly enabled by the administrator. */
export function readableRoot(): string | undefined {
  const configured = process.env.DOCUMENT_READABLE_DIR?.trim();
  if (!configured) return undefined;
  if (!path.isAbsolute(configured)) throw new Error('DOCUMENT_READABLE_DIR must be absolute.');
  const root = path.resolve(configured);
  const excluded = [process.cwd(), process.env.WEB_ROOT,
    process.env.UPLOAD_ARCHIVE_DIR || './storage/archive',
    process.env.UPLOAD_STAGING_DIR || './storage/staging',
    process.env.PERSONAL_STORAGE_DIR || './storage/personal',
    process.env.BACKUP_DIR, process.env.DESTRUCTION_STATE_DIR,
    process.env.DESTRUCTION_BACKUP_STAGING_ROOT].filter(Boolean) as string[];
  if (excluded.some(value => within(value, root) || within(root, value)))
    throw new Error('DOCUMENT_READABLE_DIR must be separate from project, web, storage and backup roots.');
  if (process.env.ARCHIVE_KEY_FILE && within(root, process.env.ARCHIVE_KEY_FILE))
    throw new Error('Archive keys must be outside DOCUMENT_READABLE_DIR.');
  checked(root);
  return root;
}

/** Reject symlinks/junctions at every existing path component, including the root. */
function checked(filename: string): string {
  const absolute = path.resolve(filename);
  let cursor = path.parse(absolute).root;
  for (const part of path.relative(cursor, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Readable copies cannot use symbolic links or junctions.');
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return absolute;
}

function documentDirectory(root: string, id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
    throw new Error('Invalid document ID for readable copy.');
  return checked(path.join(root, id));
}

export interface ReadableDocument {
  id: string;
  originalFilename: string;
  storagePath: string;
  sha256Checksum?: string | null;
  file?: { storageKey: string; fileHash?: string } | null;
}

export function readableDocumentExists(id: string): boolean {
  const root = readableRoot();
  return !!root && fs.existsSync(documentDirectory(root, id));
}

/** Returns true only when this call publishes a new verified copy. */
export async function writeReadableDocument(doc: ReadableDocument): Promise<boolean> {
  const root = readableRoot();
  if (!root) return false;
  const checksum = doc.sha256Checksum || doc.file?.fileHash;
  if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum)) throw new Error('Readable copy requires a trusted checksum.');
  let name = normalizeUploadFilename(doc.originalFilename).replace(/[. ]+$/, '');
  if (!name) throw new Error('Invalid readable filename.');
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  const directory = documentDirectory(root, doc.id);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = checked(path.join(directory, name));
  if (fs.existsSync(destination)) {
    if (await rawChecksum(destination) !== checksum) throw new Error('Existing readable copy has changed; it was not overwritten.');
    return false;
  }
  const temporary = checked(path.join(directory, `${randomUUID()}.partial`));
  const output = await fs.promises.open(temporary, 'wx', 0o600);
  try {
    for await (const chunk of archiveChunks(doc.file?.storageKey || doc.storagePath, checksum))
      await output.writeFile(chunk);
    await output.sync();
    await output.close();
    checked(destination);
    // Atomic publication without replacing a file written by another process.
    try { await fs.promises.link(checked(temporary), destination); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      checked(destination);
      if (await rawChecksum(destination) !== checksum) throw new Error('Conflicting readable copy.');
      return false;
    }
    return true;
  } finally {
    await output.close().catch(() => undefined);
    await fs.promises.unlink(checked(temporary));
  }
}

/** The document directory is application-owned; never follow links or recurse. */
export async function removeReadableDocument(id: string): Promise<void> {
  const root = readableRoot();
  if (!root) return;
  const directory = documentDirectory(root, id);
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const filename = checked(path.join(directory, entry.name));
    if (!entry.isFile() || !fs.lstatSync(filename).isFile()) throw new Error('Unexpected object in readable document directory.');
    await fs.promises.unlink(filename);
  }
  await fs.promises.rmdir(checked(directory));
}
