import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ViewRequestStatus } from '../../entities/view-request.entity';

export class QueryViewRequestsDto {
  @IsEnum(ViewRequestStatus)
  @IsOptional()
  status?: ViewRequestStatus;

  @IsString()
  @IsOptional()
  scope?: 'my-department' | 'all';
}
