import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';
import { Document, DocumentStatus } from '../entities/document.entity';
import { UserRole } from '../entities/user.entity';
import { applyDocumentSecurityScope } from '../common/document-security';

interface AuthUser {
  id: string;
  role: UserRole;
  departmentId?: string;
}

interface ExportFilter {
  status?: string;
  departmentId?: string;
  dateFrom?: string;
  dateTo?: string;
}

@Injectable()
export class ExportService {
  constructor(
    @InjectRepository(Document) private docRepo: Repository<Document>,
  ) {}

  // ─── Query chung (dùng lại cho cả Excel và PDF) ───────────
  private async getDocs(filter: ExportFilter, user: AuthUser): Promise<Document[]> {
    const qb = this.docRepo
      .createQueryBuilder('doc')
      .leftJoinAndSelect('doc.uploader', 'uploader')
      .leftJoinAndSelect('doc.department', 'department');

    // Phân quyền scope
    if (user.role === UserRole.DEPARTMENT_HEAD) {
      qb.andWhere('department.id = :deptId', { deptId: user.departmentId });
    } else if (user.role === UserRole.USER) {
      qb.andWhere('uploader.id = :uid', { uid: user.id });
    }

    if (filter.departmentId && user.role === UserRole.ADMIN) {
      qb.andWhere('department.id = :departmentId', { departmentId: filter.departmentId });
    }
    if (filter.status) {
      qb.andWhere('doc.status = :status', { status: filter.status });
    }
    if (filter.dateFrom) {
      qb.andWhere('doc.createdAt >= :dateFrom', { dateFrom: new Date(filter.dateFrom) });
    }
    if (filter.dateTo) {
      const end = new Date(filter.dateTo);
      end.setHours(23, 59, 59, 999);
      qb.andWhere('doc.createdAt <= :dateTo', { dateTo: end });
    }

    applyDocumentSecurityScope(qb, user);
    qb.orderBy('doc.createdAt', 'DESC');
    return qb.getMany();
  }

  // ─── Xuất Excel ───────────────────────────────────────────
  async exportExcel(filter: ExportFilter, user: AuthUser): Promise<Buffer> {
    const docs = await this.getDocs(filter, user);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'LTHS Lưu Trữ';
    wb.created = new Date();

    const ws = wb.addWorksheet('Tài liệu');

    // Header row
    ws.columns = [
      { header: 'STT',          key: 'stt',       width: 6  },
      { header: 'Tiêu đề',      key: 'title',     width: 36 },
      { header: 'Tên file gốc', key: 'filename',  width: 36 },
      { header: 'Khoa',         key: 'dept',      width: 24 },
      { header: 'Người gửi',    key: 'uploader',  width: 28 },
      { header: 'Trạng thái',   key: 'status',    width: 14 },
      { header: 'Dung lượng',   key: 'size',      width: 14 },
      { header: 'Ngày gửi',     key: 'createdAt', width: 20 },
    ];

    // Style header
    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8B6914' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    const statusLabel: Record<string, string> = {
      [DocumentStatus.PENDING]:  'Chờ duyệt',
      [DocumentStatus.STORED]:   'Đã lưu trữ',
      [DocumentStatus.REJECTED]: 'Bị từ chối',
      [DocumentStatus.APPROVED]: 'Đã duyệt',
    };

    docs.forEach((d, i) => {
      ws.addRow({
        stt:       i + 1,
        title:     d.title || d.originalFilename,
        filename:  d.originalFilename,
        dept:      (d.department as any)?.name ?? '—',
        uploader:  (d.uploader as any)?.fullName ?? '—',
        status:    statusLabel[d.status] ?? d.status,
        size:      d.fileSizeBytes ? `${(d.fileSizeBytes / 1024 / 1024).toFixed(2)} MB` : '—',
        createdAt: d.createdAt ? new Date(d.createdAt).toLocaleString('vi-VN') : '—',
      });
    });

    // Auto-filter
    ws.autoFilter = { from: 'A1', to: 'H1' };

    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // ─── Xuất PDF ─────────────────────────────────────────────
  exportPdf(filter: ExportFilter, user: AuthUser): Promise<Buffer> {
    return new Promise(async (resolve, reject) => {
      const docs = await this.getDocs(filter, user);

      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const pass = new PassThrough();
      const chunks: Buffer[] = [];

      pass.on('data', (chunk) => chunks.push(chunk));
      pass.on('end', () => resolve(Buffer.concat(chunks)));
      pass.on('error', reject);
      doc.pipe(pass);

      // Title
      doc
        .fontSize(16)
        .font('Helvetica-Bold')
        .text('LTHS Lưu Trữ — Danh sách tài liệu', { align: 'center' })
        .moveDown(0.5);

      doc
        .fontSize(9)
        .font('Helvetica')
        .text(`Xuất lúc: ${new Date().toLocaleString('vi-VN')}   |   Tổng: ${docs.length} tài liệu`, { align: 'center' })
        .moveDown(1);

      // Table header
      const cols = { stt: 30, title: 160, dept: 100, status: 70, size: 60, date: 90 };
      const startX = doc.page.margins.left;
      let y = doc.y;

      const drawRow = (
        stt: string, title: string, dept: string,
        status: string, size: string, date: string,
        isHeader = false,
      ) => {
        if (y > doc.page.height - doc.page.margins.bottom - 20) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        const rowH = 18;
        if (isHeader) {
          doc.rect(startX, y, Object.values(cols).reduce((a, b) => a + b, 0), rowH)
            .fill('#8B6914');
          doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
        } else {
          doc.fillColor('#000000').font('Helvetica').fontSize(8);
        }
        let x = startX;
        [
          [stt, cols.stt],
          [title, cols.title],
          [dept, cols.dept],
          [status, cols.status],
          [size, cols.size],
          [date, cols.date],
        ].forEach(([text, width]) => {
          doc.text(String(text), Number(x) + 4, y + 4, {
            width: Number(width) - 8,
            ellipsis: true,
            lineBreak: false,
          });
          x = Number(x) + Number(width);
        });
        if (!isHeader) {
          doc.moveTo(startX, y + rowH)
            .lineTo(startX + Object.values(cols).reduce((a, b) => a + b, 0), y + rowH)
            .strokeColor('#cccccc').stroke();
        }
        doc.fillColor('#000000');
        y += rowH;
      };

      drawRow('STT', 'Tiêu đề', 'Khoa', 'Trạng thái', 'Dung lượng', 'Ngày gửi', true);

      const statusLabel: Record<string, string> = {
        pending: 'Chờ duyệt', stored: 'Đã lưu trữ',
        rejected: 'Từ chối', approved: 'Đã duyệt',
      };

      docs.forEach((d, i) => {
        drawRow(
          String(i + 1),
          d.title || d.originalFilename,
          (d.department as any)?.name ?? '—',
          statusLabel[d.status] ?? d.status,
          d.fileSizeBytes ? `${(d.fileSizeBytes / 1024 / 1024).toFixed(1)}MB` : '—',
          d.createdAt ? new Date(d.createdAt).toLocaleDateString('vi-VN') : '—',
        );
      });

      doc.end();
    });
  }
}
