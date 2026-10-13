import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ClassificationValue, DocumentVisibility } from '../../entities/document.entity';

export class UploadDocumentDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsString()
  referenceNo?: string;

  @IsOptional()
  @IsString()
  issuingUnit?: string;

  @IsOptional()
  @IsString()
  organizingBody?: string;

  @IsOptional()
  @IsDateString()
  receivedDate?: string;

  @IsOptional()
  @IsString()
  documentNumber?: string;

  @IsOptional()
  @IsString()
  securityLevel?: string;

  @IsOptional()
  @IsString()
  authorName?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;

  /**
   * UUID của loại hồ sơ (document_types.id).
   * User chọn khi upload; Admin có thể gán/sửa lại khi duyệt.
   */
  @IsOptional()
  @IsUUID()
  documentTypeId?: string;

  /**
   * Ngày hình thành tài liệu (ISO 8601: 2025-01-15).
   * Có thể khác ngày upload. Dùng để tính hạn lưu trữ.
   */
  @IsOptional()
  @IsDateString()
  documentDate?: string;

  /**
   * Mức giá trị tài liệu: permanent / timed / unclassified.
   * Mặc định là unclassified, Admin xác nhận khi duyệt.
   */
  @IsOptional()
  @IsEnum(ClassificationValue)
  classificationValue?: ClassificationValue;

  /**
   * Phạm vi hiển thị: public / department / private.
   * Mặc định: department (chỉ cùng khoa).
   */
  @IsOptional()
  @IsEnum(DocumentVisibility)
  visibility?: DocumentVisibility;

  /**
   * Tự động duyệt — frontend gửi true khi visibility=private.
   * Multipart gửi string "true"/"false" → transform sang boolean.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  autoApprove?: boolean;
}
