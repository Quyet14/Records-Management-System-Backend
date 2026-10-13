import { diskStorage } from 'multer';
import { extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { BadRequestException } from '@nestjs/common';

export const multerOptions = {
  storage: diskStorage({
    destination: process.env.UPLOAD_STAGING_DIR || './storage/staging',
    filename: (req, file, callback) => {
      const uniqueName = `${uuidv4()}${extname(file.originalname)}`;
      callback(null, uniqueName);
    },
  }),
  fileFilter: (req: any, file: Express.Multer.File, callback: any) => {
    // Chỉ kiểm tra đuôi + mimetype ở tầng multer.
    // Kiểm tra magic bytes thực sự nên bổ sung ở service (đọc vài byte đầu file) trước khi Approve.
    const isPdf =
      file.mimetype === 'application/pdf' &&
      extname(file.originalname).toLowerCase() === '.pdf';
    if (!isPdf) {
      return callback(
        new BadRequestException('Chỉ chấp nhận file định dạng PDF'),
        false,
      );
    }
    callback(null, true);
  },
  limits: {
    fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10)) * 1024 * 1024,
  },
};
