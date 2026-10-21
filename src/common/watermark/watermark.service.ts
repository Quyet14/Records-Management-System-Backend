import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib';
import * as fs from 'fs';
import * as nodePath from 'path';

export interface WatermarkOptions {
  userName: string;
  userEmail: string;
  downloadedAt?: Date;
}

@Injectable()
export class WatermarkService {
  private readonly logger = new Logger(WatermarkService.name);

  /** Resolve đường dẫn — tương thích cả path cũ (relative) lẫn mới (absolute) */
  private resolvePath(filePath: string): string {
    return nodePath.isAbsolute(filePath)
      ? filePath
      : nodePath.resolve(process.cwd(), filePath);
  }

  async applyWatermark(filePath: string, options: WatermarkOptions): Promise<Buffer> {
    const absPath = this.resolvePath(filePath);
    try {
      const originalBytes = fs.readFileSync(absPath);
      return await this.embedWatermark(originalBytes, options);
    } catch (err) {
      this.logger.error(`Không thể chèn watermark cho ${absPath}: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Không thể tạo bản xem có watermark.');
    }
  }

  readOriginal(filePath: string): Buffer {
    return fs.readFileSync(this.resolvePath(filePath));
  }

  // ─── Private ─────────────────────────────────────────────

  async embedWatermark(
    pdfBytes: Uint8Array,
    options: WatermarkOptions,
  ): Promise<Buffer> {
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // Dùng Helvetica — font Latin không hỗ trợ tiếng Việt
    // Chuyển tên/email sang ASCII để tránh lỗi encode
    const toAscii = (str: string) =>
      str.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
         .replace(/đ/g, 'd').replace(/Đ/g, 'D')
         .replace(/[^\x00-\x7F]/g, '?');

    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();
    const downloadedAt = (options.downloadedAt ?? new Date()).toLocaleString('vi-VN');

    const lines = [
      toAscii(options.userName),
      toAscii(options.userEmail),
      `Tai luc: ${toAscii(downloadedAt)}`,
      'TAI LIEU NOI BO - KHONG PHAT TAN',
    ];

    for (const page of pages) {
      const { width, height } = page.getSize();
      const centerX = width / 2;
      const centerY = height / 2;
      const fontSize = Math.max(12, Math.min(width, height) * 0.03);
      const lineHeight = fontSize * 1.6;

      lines.forEach((line, index) => {
        const textWidth = font.widthOfTextAtSize(line, fontSize);
        const x = centerX - textWidth / 2;
        const y = centerY + ((lines.length / 2) - index) * lineHeight;

        page.drawText(line, {
          x,
          y,
          size: fontSize,
          font,
          color: rgb(0.6, 0.1, 0.1),
          opacity: 0.25,
          rotate: degrees(35),
        });
      });
    }

    const watermarkedBytes = await pdfDoc.save();
    return Buffer.from(watermarkedBytes);
  }
}
