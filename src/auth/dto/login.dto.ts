import { IsEmail, IsOptional, IsString, IsUUID, Length, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  password: string;

  @IsUUID()
  captcha_id: string;

  @IsString()
  @Length(5, 5)
  captcha_code: string;
}
