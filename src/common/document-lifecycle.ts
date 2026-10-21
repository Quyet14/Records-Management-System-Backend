import { ConflictException, GoneException } from '@nestjs/common';
import { Document, DocumentStatus } from '../entities/document.entity';

export function assertDocumentContentAvailable(doc: Document): void {
  if (doc.status === DocumentStatus.DESTROYED || doc.destroyedAt || doc.destructionStartedAt)
    throw new GoneException({ code: 'DOCUMENT_CONTENT_UNAVAILABLE', message: 'Nội dung hồ sơ đã hủy hoặc đang được hủy.' });
}
export function assertDocumentMutable(doc: Document): void {
  if (doc.destructionRequestId || doc.status === DocumentStatus.DESTROYED || doc.destructionStartedAt)
    throw new ConflictException({ code: 'DOCUMENT_FROZEN', message: 'Hồ sơ đang thuộc quy trình hủy. Cần thu hồi đề nghị trước khi sửa.' });
}
