import { extname } from 'path';

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.tar.gz': 'application/gzip',
};

const ACCEPTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'multipart/x-zip',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/octet-stream',
  'application/x-7z-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
]);

export function getNormalizedExt(filename: string): string {
  const lowerName = filename.toLowerCase();
  if (lowerName.endsWith('.tar.gz')) return '.tar.gz';
  return extname(lowerName);
}

export function isPdfFile(filename: string, mimeType?: string): boolean {
  return getNormalizedExt(filename) === '.pdf' || mimeType === 'application/pdf';
}

export function isAcceptedDocumentFile(file: Express.Multer.File): boolean {
  const ext = getNormalizedExt(file.originalname);
  if (!Object.prototype.hasOwnProperty.call(MIME_BY_EXT, ext)) return false;

  if (ext === '.pdf') {
    return file.mimetype === 'application/pdf';
  }

  return ACCEPTED_MIME_TYPES.has(file.mimetype);
}

export function inferMimeType(filename: string, fallback?: string): string {
  const ext = getNormalizedExt(filename);
  return MIME_BY_EXT[ext] || fallback || 'application/octet-stream';
}
