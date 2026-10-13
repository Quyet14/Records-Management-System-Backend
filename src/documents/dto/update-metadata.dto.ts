import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ClassificationValue, ReviewStatus } from '../../entities/document.entity';

export class UpdateMetadataDto {
  @IsOptional()
  @IsUUID()
  documentTypeId?: string;

  @IsOptional()
  @IsEnum(ClassificationValue)
  classificationValue?: ClassificationValue;

  @IsOptional()
  @IsDateString()
  documentDate?: string;

  /**
   * Ngày người bệnh qua đời — chỉ dùng cho loại hồ sơ
   * có retention_basis = patient_death_date (ví dụ: Sổ sức khỏe điện tử).
   */
  @IsOptional()
  @IsDateString()
  patientDeathDate?: string;

  /** Trạng thái chỉnh lý / xác định giá trị */
  @IsOptional()
  @IsEnum(ReviewStatus)
  reviewStatus?: ReviewStatus;
}
