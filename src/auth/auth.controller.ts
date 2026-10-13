import {
  Body,
  Controller,
  Post,
  Get,
  Query,
  Res,
  Param,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
  Header,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { IsString, IsUUID, Length } from 'class-validator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  ForceChangePasswordDto,
  ForgotPasswordDto,
  VerifyResetOtpDto,
  ResetPasswordDto,
} from './dto/password.dto';

class VerifyOtpDto {
  @IsUUID()
  user_id: string;

  @IsString()
  @Length(6, 6, { message: 'Mã OTP phải đúng 6 ký tự số' })
  otp: string;
}

class CompleteLoginDto {
  @IsUUID()
  pending_login_id: string;
}

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  /** GET /auth/captcha - trả ảnh CAPTCHA và mã định danh dùng cho login. */
  @Get('captcha')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  getCaptcha() {
    return this.authService.createCaptcha();
  }

  /**
   * POST /auth/login — Bước 1: xác thực password, gửi OTP về email.
   * Response: { requires_otp: true, user_id, email_hint, expires_in }
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    this.authService.verifyCaptcha(dto.captcha_id, dto.captcha_code);
    const user = await this.authService.validateUser(dto.email, dto.password);
    return this.authService.loginStep1(user, req.ip);
  }

  @Post('force-change-password')
  @HttpCode(HttpStatus.OK)
  async forceChangePassword(@Body() dto: ForceChangePasswordDto, @Req() req: Request) {
    return this.authService.forceChangePassword(
      dto.user_id,
      dto.new_password,
      dto.confirm_password,
      req.ip,
    );
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.authService.forgotPassword(dto.email, req.ip);
  }

  @Post('reset-password/verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyResetOtp(@Body() dto: VerifyResetOtpDto) {
    return this.authService.verifyResetOtp(dto.email, dto.otp);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(
      dto.reset_token,
      dto.new_password,
      dto.confirm_password,
    );
  }

  /**
   * POST /auth/verify-otp — Bước 2: xác thực OTP, trả về token thật.
   * Body: { user_id, otp }
   */
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    return this.authService.verifyOtp(dto.user_id, dto.otp, req.ip);
  }

  @Get('confirm-login')
  async confirmLogin(@Query('token') token: string, @Res() res: Response) {
    const result = await this.authService.confirmLoginByToken(token);
    const color = result.ok ? '#2f855a' : '#c53030';
    res.status(200).send(`<!DOCTYPE html>
      <html lang="vi"><head><meta charset="utf-8"><title>Xác nhận đăng nhập</title></head>
      <body style="font-family:Arial,sans-serif;text-align:center;padding:60px 20px">
        <h2 style="color:${color}">${result.message}</h2>
        ${result.ok ? '<p>Bạn có thể đóng tab này và quay lại tab đăng nhập.</p>' : ''}
      </body></html>`);
  }

  @Get('login-status/:pendingLoginId')
  getLoginStatus(@Param('pendingLoginId') pendingLoginId: string) {
    return this.authService.getConfirmationStatus(pendingLoginId);
  }

  @Post('complete-login')
  @HttpCode(HttpStatus.OK)
  async completeLogin(@Body() dto: CompleteLoginDto, @Req() req: Request) {
    return this.authService.completeLogin(dto.pending_login_id, req.ip);
  }

  /** POST /auth/refresh — đổi refresh token lấy access token mới */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body('refresh_token') refreshToken: string,
    @Req() req: Request,
  ) {
    return this.authService.refresh(refreshToken, req.ip);
  }

  /** POST /auth/logout — revoke refresh token hiện tại */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body('refresh_token') refreshToken: string) {
    if (refreshToken) {
      await this.authService.logout(refreshToken);
    }
  }

  /** POST /auth/logout-all — thu hồi TẤT CẢ phiên */
  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(@CurrentUser() user) {
    await this.authService.revokeAllSessions(user.id);
  }
}
