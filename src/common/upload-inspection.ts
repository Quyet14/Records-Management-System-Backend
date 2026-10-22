import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import { getNormalizedExt } from '../documents/allowed-file-types';
import { uploadLimitBytes } from './upload-policy';
import { scanUploadForViruses } from './upload-virus-scanner';

export async function inspectUpload(file: Express.Multer.File): Promise<void> {
  if (!file?.path) throw new BadRequestException('Thiếu file tải lên.');
  const stat = await fs.promises.stat(file.path);
  if (!stat.isFile() || stat.size === 0 || stat.size > uploadLimitBytes() || stat.size !== file.size)
    throw new BadRequestException('File rỗng, vượt dung lượng hoặc không khớp kích thước.');
  const handle = await fs.promises.open(file.path, 'r');
  const magic = Buffer.alloc(512);
  try { await handle.read(magic, 0, magic.length, 0); } finally { await handle.close(); }
  const ext = getNormalizedExt(file.originalname);
  const starts = (hex: string) => magic.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  const valid = ext === '.pdf' ? magic.subarray(0, 5).toString('ascii') === '%PDF-'
    : ext === '.zip' ? starts('504b0304') || starts('504b0506') || starts('504b0708')
    : ext === '.rar' ? starts('526172211a0700') || starts('526172211a070100')
    : ext === '.7z' ? starts('377abcaf271c')
    : ['.gz', '.tgz', '.tar.gz'].includes(ext) ? starts('1f8b')
    : ext === '.tar' ? magic.subarray(257, 262).toString('ascii') === 'ustar' : false;
  if (!valid) throw new BadRequestException('Nội dung file không khớp định dạng khai báo.');
  // Tests must opt out explicitly; production never accepts an unscanned upload.
  if (process.env.UPLOAD_SCAN_ENABLED === 'false') {
    if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('Quét virus bắt buộc trong production.');
  } else {
    await scanUploadForViruses(file.path);
  }
  if (ext === '.pdf') {
    if (stat.size > 100 * 1024 * 1024) throw new BadRequestException('PDF vượt giới hạn phân tích 100 MiB.');
    try {
      const pdf = await PDFDocument.load(await fs.promises.readFile(file.path));
      if (pdf.isEncrypted || pdf.getPageCount() === 0) throw new Error('Invalid PDF');
    } catch { throw new BadRequestException('PDF không hợp lệ, bị mã hóa hoặc không có trang.'); }
  }
}
