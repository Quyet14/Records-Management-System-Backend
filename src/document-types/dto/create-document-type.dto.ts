import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { RetentionBasis } from '../../entities/document-type.entity';

export class CreateDocumentTypeDto {
  /** Mã loại hồ sơ, ví dụ: HS-001 */
  @IsString()
  @Matches(/^[A-Z0-9\-]{2,20}$/, {
    message: 'code chỉ gồm chữ hoa, số và dấu gạch ngang (2-20 ký tự)',
  })
  code: string;

  @IsString()
  @MaxLength(500)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  group?: string;

  /** Thời hạn lưu trữ (năm). Bắt buộc nếu isPermanent = false */
  @ValidateIf((o) => !o.isPermanent)
  @IsInt()
  @Min(1)
  @Max(200)
  retentionYears?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  maxViewDurationDays?: number;

  /** Lưu trữ vĩnh viễn */
  @IsOptional()
  @IsBoolean()
  isPermanent?: boolean;

  @IsOptional()
  @IsEnum(RetentionBasis)
  retentionBasis?: RetentionBasis;
}
