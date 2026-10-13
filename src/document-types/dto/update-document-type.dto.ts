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

export class UpdateDocumentTypeDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9\-]{2,20}$/, {
    message: 'code chỉ gồm chữ hoa, số và dấu gạch ngang (2-20 ký tự)',
  })
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  group?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  retentionYears?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  maxViewDurationDays?: number;

  @IsOptional()
  @IsBoolean()
  isPermanent?: boolean;

  @IsOptional()
  @IsEnum(RetentionBasis)
  retentionBasis?: RetentionBasis;
}
