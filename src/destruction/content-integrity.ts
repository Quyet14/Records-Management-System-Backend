import * as fs from 'fs';
import * as path from 'path';
import { archiveChecksum, privateContentPath, rawChecksum } from '../common/archive-crypto';
import { fail } from './destruction.rules';

/** Trusted inventory/repair only. Does not serve bytes or relax the API's legacy-read policy. */
export async function inspectDestructionContent(filename: string, expectedHash: string) {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash || '')) fail(409, 'CHECKSUM_REQUIRED', 'Thiếu checksum tin cậy của nội dung.');
  filename = privateContentPath(filename);
  const handle = await fs.promises.open(filename, 'r');
  const prefix = Buffer.alloc(8);
  try { await handle.read(prefix, 0, prefix.length, 0); } finally { await handle.close(); }
  const encrypted = prefix.toString('ascii') === 'LTHSAE01';
  if (!encrypted && path.extname(filename).toLowerCase() === '.lths')
    fail(409, 'CONTENT_HASH_CHANGED', 'Container mã hóa không có header hợp lệ.');
  const checksum = encrypted ? await archiveChecksum(filename, expectedHash) : await rawChecksum(filename);
  if (checksum !== expectedHash) fail(409, 'CONTENT_HASH_CHANGED', 'Checksum nội dung không khớp snapshot tin cậy.');
  return { checksum, encrypted };
}
