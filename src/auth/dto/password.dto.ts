import { IsEmail, IsNotEmpty, IsString, Length, MinLength } from 'class-validator';

export class ForceChangePasswordDto {
  @IsNotEmpty()
  @IsString()
  user_id: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  new_password: string;

  @IsNotEmpty()
  @IsString()
  confirm_password: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email: string;
}

export class VerifyResetOtpDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 6)
  otp: string;
}

export class ResetPasswordDto {
  @IsNotEmpty()
  @IsString()
  reset_token: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  new_password: string;

  @IsNotEmpty()
  @IsString()
  confirm_password: string;
}
