import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class ApproveViewRequestDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  approvedDuration: number;
}
