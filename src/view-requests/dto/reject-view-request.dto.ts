import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RejectViewRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  decisionNote: string;
}
