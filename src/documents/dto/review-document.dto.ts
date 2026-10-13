import { IsDateString, IsNumberString, IsOptional, IsPositive, IsString, IsUUID, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class RejectDocumentDto {
  @IsString()
  reason: string;
}

export class PendingQueueDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  limit?: number;
}

export class SearchDocumentDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  // ─── Bộ lọc nâng cao ───────────────────────────────────────

  /** Ngày bắt đầu (ISO 8601: 2025-01-01) */
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  /** Ngày kết thúc (ISO 8601: 2025-12-31) */
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  /** Lọc theo người tải lên (UUID) — chỉ Admin/Trưởng Khoa dùng được */
  @IsOptional()
  @IsUUID()
  uploaderId?: string;

  /** Dung lượng tối thiểu (bytes) */
  @IsOptional()
  @IsNumberString()
  minSize?: string;

  /** Dung lượng tối đa (bytes) */
  @IsOptional()
  @IsNumberString()
  maxSize?: string;

  /** Trang hiện tại (bắt đầu từ 1) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  page?: number;

  /** Số bản ghi mỗi trang */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  limit?: number;
}
