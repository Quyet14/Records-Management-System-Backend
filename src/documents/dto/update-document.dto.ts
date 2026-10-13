import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';

export class UpdateDocumentDto {
  @IsOptional()
  @IsString()
  title?: string;

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
  @IsString()
  documentNumber?: string;

  @IsOptional()
  @IsDateString()
  receivedDate?: string;

  @IsOptional()
  @IsString()
  securityLevel?: string;

  @IsOptional()
  @IsString()
  authorName?: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Gán lại khoa/phòng ban */
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}
