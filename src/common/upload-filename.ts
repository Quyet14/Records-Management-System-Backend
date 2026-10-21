import { UnprocessableEntityException } from '@nestjs/common';
import { TextDecoder } from 'util';

/** Decode the UTF-8 bytes that legacy multipart parsers expose as Latin-1. */
export function normalizeUploadFilename(original: string): string {
  let value = typeof original === 'string' ? original : '';
  if (/[\u0080-\u00ff]/.test(value) && Array.from(value).every(char => char.codePointAt(0)! <= 255)) {
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'latin1')); }
    catch { /* A genuine Latin-1 name must not be decoded with replacement characters. */ }
  }
  value = value.split(/[\\/]/).pop()!.normalize('NFC')
    .replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '_').trim();
  value = Array.from(value).slice(0, 240).join('');
  if (!value || value === '.' || value === '..')
    throw new UnprocessableEntityException({ code: 'INVALID_FILENAME', message: 'Tên tệp không hợp lệ. Vui lòng chọn lại tệp có tên đầy đủ.' });
  return value;
}

export function pdfContentDisposition(original: string): string {
  const filename = normalizeUploadFilename(original);
  const fallback = filename.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
