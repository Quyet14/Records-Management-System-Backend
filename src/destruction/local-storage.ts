import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { fail } from './destruction.rules';

export function inside(root: string, candidate: string, allowRoot = false): boolean {
  const relative = path.relative(root, candidate);
  return (allowRoot || !!relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function distinctRoots(roots: string[]) {
  for (let a = 0; a < roots.length; a++) for (let b = a + 1; b < roots.length; b++) {
    if (inside(roots[a], roots[b], true) || inside(roots[b], roots[a], true))
      fail(503, 'OVERLAPPING_STORAGE', 'Các vùng lưu trữ hủy, chứng từ, staging và backup phải tách biệt.');
  }
}
export function relativeKey(root: string, filename: string): string {
  if (!inside(root, path.resolve(filename))) fail(409, 'UNSAFE_CONTENT_PATH', 'Đường dẫn nội dung nằm ngoài vùng lưu trữ cho phép.');
  return path.relative(root, path.resolve(filename)).split(path.sep).join('/');
}
/** Check every component, including Windows junctions. Recheck immediately before destructive I/O. */
export function safePath(root: string, key: string, missing = false): string {
  if (typeof key !== 'string' || !key || /[\\\0:]/.test(key) || key.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(key))
    fail(409, 'UNSAFE_CONTENT_PATH', 'Đường dẫn nội dung không hợp lệ.');
  const filename = path.resolve(root, ...key.split('/'));
  if (!inside(root, filename)) fail(409, 'UNSAFE_CONTENT_PATH', 'Đường dẫn nội dung không hợp lệ.');
  let cursor = root;
  for (const component of key.split('/')) {
    cursor = path.join(cursor, component);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) fail(409, 'UNSAFE_CONTENT_PATH', 'Không thể xử lý liên kết tượng trưng hoặc junction.');
      if (!inside(root, fs.realpathSync(cursor), true)) fail(409, 'UNSAFE_CONTENT_PATH', 'Đường dẫn thực nằm ngoài vùng lưu trữ.');
    } catch (error) {
      if (missing && error.code === 'ENOENT') return filename;
      throw error;
    }
  }
  return filename;
}
export async function hashFile(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export async function* walk(root: string, subdir = ''): AsyncGenerator<{ key: string; filename: string }> {
  const dir = subdir ? safePath(root, subdir) : root;
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const key = subdir ? `${subdir}/${entry.name}` : entry.name;
    const filename = safePath(root, key);
    if (entry.isDirectory()) yield* walk(root, key);
    else if (entry.isFile()) yield { key, filename };
    else fail(409, 'UNSUPPORTED_STORAGE_OBJECT', 'Kho chứa đối tượng không thể kiểm kê an toàn.');
  }
}

/** Separate SQLite WAL survives MySQL restore; FULL synchronization before each unlink intent/receipt. */
export class LocalDestructionJournal {
  private readonly db: any;
  constructor(readonly directory: string) {
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(path.join(directory, 'destruction.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=30000; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id))');
  }
  get(kind: string, id: string): any {
    const row = this.db.prepare('SELECT payload FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(row.payload, revive) : null;
  }
  put(kind: string, id: string, payload: any) {
    this.db.prepare('INSERT INTO records(kind,id,payload) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload')
      .run(kind, id, JSON.stringify(payload, encode));
  }
  all(kind: string): any[] {
    return this.db.prepare('SELECT payload FROM records WHERE kind=? ORDER BY id').all(kind).map(row => JSON.parse(row.payload, revive));
  }
  *iterate(kind: string): Generator<any> {
    for (const row of this.db.prepare('SELECT payload FROM records WHERE kind=? ORDER BY id').iterate(kind)) yield JSON.parse(row.payload, revive);
  }
  backup(filename: string) { this.db.prepare('VACUUM INTO ?').run(filename); }
  close() { this.db.close(); }
}
function encode(_key: string, value: any) {
  return value?.type === 'Buffer' && Array.isArray(value.data) ? { __lthsBytes: Buffer.from(value.data).toString('base64') } : value;
}
function revive(_key: string, value: any) {
  return value && typeof value.__lthsBytes === 'string' ? Buffer.from(value.__lthsBytes, 'base64') : value;
}
