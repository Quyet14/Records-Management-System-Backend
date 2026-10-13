import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DocumentType,
  RetentionBasis,
} from '../entities/document-type.entity';
import { CreateDocumentTypeDto } from './dto/create-document-type.dto';
import { UpdateDocumentTypeDto } from './dto/update-document-type.dto';

/** 7 loại danh mục hồ sơ */
interface SeedItem {
  code: string;
  name: string;
  retentionYears: number | undefined;
  isPermanent: boolean;
  retentionBasis: RetentionBasis;
  group: string;
  description: string | undefined;
  isBuiltin: boolean;
}

const SEED_DOCUMENT_TYPES: SeedItem[] = [
  { code: 'QD',  name: 'Quyết định',  retentionYears: undefined, isPermanent: true,  retentionBasis: RetentionBasis.PERMANENT,      group: 'Hành chính', description: 'Văn bản quyết định của cơ quan, tổ chức',         isBuiltin: true },
  { code: 'TT',  name: 'Tờ trình',   retentionYears: 10,        isPermanent: false, retentionBasis: RetentionBasis.DOCUMENT_DATE,  group: 'Hành chính', description: 'Tờ trình đề xuất, kiến nghị lên cấp trên',         isBuiltin: true },
  { code: 'BB',  name: 'Biên bản',   retentionYears: 10,        isPermanent: false, retentionBasis: RetentionBasis.DOCUMENT_DATE,  group: 'Hành chính', description: 'Biên bản cuộc họp, biên bản kiểm tra, xác nhận',    isBuiltin: true },
  { code: 'HD',  name: 'Hợp đồng',   retentionYears: 20,        isPermanent: false, retentionBasis: RetentionBasis.DOCUMENT_DATE,  group: 'Hành chính', description: 'Hợp đồng lao động, hợp đồng dịch vụ, kinh tế',     isBuiltin: true },
  { code: 'TB',  name: 'Thông báo',  retentionYears: 5,         isPermanent: false, retentionBasis: RetentionBasis.DOCUMENT_DATE,  group: 'Hành chính', description: 'Thông báo nội bộ, thông báo tới người dùng',        isBuiltin: true },
  { code: 'DN',  name: 'Đề nghị',    retentionYears: 5,         isPermanent: false, retentionBasis: RetentionBasis.DOCUMENT_DATE,  group: 'Hành chính', description: 'Công văn đề nghị, đơn đề nghị',                     isBuiltin: true },
  { code: 'BC',  name: 'Báo cáo',    retentionYears: 10,        isPermanent: false, retentionBasis: RetentionBasis.DOCUMENT_DATE,  group: 'Hành chính', description: 'Báo cáo định kỳ, báo cáo tổng kết, báo cáo chuyên đề', isBuiltin: true },
];

@Injectable()
export class DocumentTypesService implements OnModuleInit {
  constructor(
    @InjectRepository(DocumentType)
    private repo: Repository<DocumentType>,
  ) {}

  /** Seed danh mục hồ sơ khi module khởi động — xóa cũ và seed lại */
  async onModuleInit() {
    try {
      const existing = await this.repo.find({ where: { isBuiltin: true } });
      const existingCodes = new Set(existing.map(d => d.code));
      const newCodes = new Set(SEED_DOCUMENT_TYPES.map(d => d.code));

      // Xóa các record cũ không còn trong danh sách mới
      const toDelete = existing.filter(d => !newCodes.has(d.code));
      if (toDelete.length > 0) {
        await this.repo.remove(toDelete);
      }

      // Thêm các record mới chưa có.
      // Bọc trong try/catch từng phần tử để tránh race condition giữa các PM2 worker
      // cùng khởi động đồng thời và cùng cố insert "QD", "TT", ...
      const toInsert = SEED_DOCUMENT_TYPES.filter(d => !existingCodes.has(d.code));
      for (const item of toInsert) {
        try {
          await this.repo.save(this.repo.create(item));
        } catch (err: any) {
          // Bỏ qua duplicate do worker khác đã insert trước đó.
          if (err?.code !== 'ER_DUP_ENTRY') {
            throw err;
          }
        }
      }
    } catch (err: any) {
      console.error('Seed document types failed (non-fatal):', err?.message ?? err);
      // Không ném tiếp để không chặn app khởi động.
    }
  }

  // ─── CRUD ──────────────────────────────────────────────────

  findAll(): Promise<DocumentType[]> {
    return this.repo.find({ order: { code: 'ASC' } });
  }

  async findOne(id: string): Promise<DocumentType> {
    const dt = await this.repo.findOne({ where: { id } });
    if (!dt) throw new NotFoundException('Không tìm thấy loại hồ sơ');
    return dt;
  }

  async create(dto: CreateDocumentTypeDto): Promise<DocumentType> {
    const existing = await this.repo.findOne({ where: { code: dto.code } });
    if (existing) throw new ConflictException(`Mã "${dto.code}" đã tồn tại`);

    this.validateRetention(dto.isPermanent, dto.retentionYears);

    const entity = this.repo.create({
      ...dto,
      isPermanent: dto.isPermanent ?? false,
      retentionBasis: dto.retentionBasis ?? RetentionBasis.DOCUMENT_DATE,
      // Nếu vĩnh viễn thì xóa retentionYears dù frontend có gửi
      retentionYears: dto.isPermanent ? (null as any) : dto.retentionYears,
      isBuiltin: false,
    });
    return this.repo.save(entity);
  }

  async update(id: string, dto: UpdateDocumentTypeDto): Promise<DocumentType> {
    const dt = await this.findOne(id);

    const effectiveIsPermanent = dto.isPermanent ?? dt.isPermanent;
    const effectiveRetentionYears = dto.retentionYears !== undefined
      ? dto.retentionYears
      : dt.retentionYears;

    this.validateRetention(effectiveIsPermanent, effectiveRetentionYears);
    Object.assign(dt, dto);

    // Nếu vĩnh viễn thì xóa retentionYears
    if (effectiveIsPermanent) {
      dt.retentionYears = null as any;
    }

    return this.repo.save(dt);
  }

  async remove(id: string): Promise<void> {
    const dt = await this.findOne(id);
    if (dt.isBuiltin) {
      throw new BadRequestException('Không thể xóa loại hồ sơ mặc định của hệ thống');
    }
    await this.repo.remove(dt);
  }

  // ─── Helper ────────────────────────────────────────────────

  /**
   * Validation theo TT 33/2025/TT-BYT:
   * hồ sơ chưa có trong danh mục không được đặt thời hạn thấp hơn
   * nhóm tương đương — ở đây chỉ enforce: nếu không vĩnh viễn thì phải có retentionYears > 0.
   */
  private validateRetention(isPermanent?: boolean, retentionYears?: number) {
    if (isPermanent) {
      // Vĩnh viễn — bỏ qua retentionYears, không throw lỗi
      // (frontend có thể gửi giá trị cũ, tự động bị overwrite bên dưới)
    } else {
      // Có thời hạn — bắt buộc có retentionYears >= 1
      if (!retentionYears || retentionYears < 1) {
        throw new BadRequestException(
          'Loại hồ sơ không phải vĩnh viễn phải có thời hạn lưu trữ tối thiểu 1 năm',
        );
      }
    }
  }
}
