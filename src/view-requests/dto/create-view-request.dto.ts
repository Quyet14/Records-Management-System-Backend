import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateViewRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requestedDuration?: number;
}
