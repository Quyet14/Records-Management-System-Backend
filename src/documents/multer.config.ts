import { diskStorage } from 'multer';
import { extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { BadRequestException } from '@nestjs/common';
import { isAcceptedDocumentFile } from './allowed-file-types';
import { MAX_UPLOAD_FILE_SIZE_BYTES } from '../common/upload-limits';

export const multerOptions = {
  storage: diskStorage({
    destination: process.env.UPLOAD_STAGING_DIR || './storage/staging',
    filename: (req, file, callback) => {
      const uniqueName = `${uuidv4()}${extname(file.originalname)}`;
      callback(null, uniqueName);
    },
  }),
  fileFilter: (req: any, file: Express.Multer.File, callback: any) => {
    // Multer checks extension + mimetype early; service/download keeps the stored mimetype.
    if (!isAcceptedDocumentFile(file)) {
      return callback(
        new BadRequestException('Chi chap nhan file PDF hoac file nen: ZIP, RAR, 7Z, TAR, GZ, TGZ'),
        false,
      );
    }
    callback(null, true);
  },
  limits: {
    fileSize: MAX_UPLOAD_FILE_SIZE_BYTES,
    // Extracted PDF text can exceed 64 KiB, especially with Vietnamese UTF-8.
    // Keep a finite limit below the MEDIUMTEXT capacity used by description.
    files: 20, fields: 100, fieldSize: 8 * 1024 * 1024, parts: 121,
  },
};
