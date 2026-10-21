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
  ForbiddenException,
  Delete,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { IsString, IsUUID, Length } from 'class-validator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthOriginGuard } from './auth-origin.guard';
import { clearRefreshCookie, readRefreshCookie, REFRESH_COOKIE, refreshCookieOptions } from './auth-cookie';
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
@UseGuards(AuthOriginGuard)
export class AuthController {
  constructor(private authService: AuthService, private config: ConfigService) {}

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  @Header('Cache-Control', 'no-store')
  sessions(@CurrentUser() user) { return this.authService.listSessions(user.id, user.sessionId); }

  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  @Header('Cache-Control', 'no-store')
  logoutDevice(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user) {
    return this.authService.logoutDevice(user.id, id);
  }

  private deliverSession(result: any, res: Response) {
    res.set('Cache-Control', 'no-store');
    if (!result?.refresh_token) return result;
    const { refresh_token, refresh_expires_at, ...body } = result;
    res.cookie(REFRESH_COOKIE, refresh_token, { ...refreshCookieOptions(this.config),
      maxAge: Math.max(0, new Date(refresh_expires_at).getTime() - Date.now()) });
    return body;
  }

  /** GET /auth/captcha - trả ảnh CAPTCHA và mã định danh dùng cho login. */
  @Get('captcha')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  getCaptcha() {
    return this.authService.createCaptcha();
  }

  /**
   * POST /auth/login — email + CAPTCHA, always send OTP to the registered mailbox.
   * Response: { requires_otp: true, user_id, email_hint, expires_in }
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    await this.authService.verifyCaptcha(dto.captcha_id, dto.captcha_code);
    const user = await this.authService.validateLoginEmail(dto.email);
    return this.authService.loginStep1(user, req.ip);
  }

  @Post('force-change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async forceChangePassword(@Body() dto: ForceChangePasswordDto, @Req() req: Request) {
    const actor = req.user as any;
    if (['file-download', 'file-view'].includes(actor?.tokenType) || actor?.id !== dto.user_id || !actor.authTime
      || Date.now() / 1000 - actor.authTime > 300 || actor.authTime > Date.now() / 1000 + 30)
      throw new ForbiddenException('Cần xác thực OTP mới trước khi đổi mật khẩu của chính mình.');
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
  async verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.verifyOtp(dto.user_id, dto.otp, req.ip, req.headers['user-agent']);
    await this.authService.logout(readRefreshCookie(req));
    return this.deliverSession(result, res);
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
  async completeLogin(@Body() dto: CompleteLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.completeLogin(dto.pending_login_id, req.ip);
    await this.authService.logout(readRefreshCookie(req));
    return this.deliverSession(result, res);
  }

  /** POST /auth/refresh — đổi refresh token lấy access token mới */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.set('Cache-Control', 'no-store');
    try { return this.deliverSession(await this.authService.refresh(readRefreshCookie(req), req.ip), res); }
    catch (error) { if (error.getStatus?.() === 401) clearRefreshCookie(res, this.config); throw error; }
  }

  /** POST /auth/logout — revoke refresh token hiện tại */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(readRefreshCookie(req));
    clearRefreshCookie(res, this.config);
    res.set('Cache-Control', 'no-store');
  }

  /** POST /auth/logout-all — thu hồi TẤT CẢ phiên */
  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(@CurrentUser() user, @Res({ passthrough: true }) res: Response) {
    if (['file-download', 'file-view'].includes(user.tokenType)) throw new ForbiddenException('Cần phiên đăng nhập hợp lệ.');
    await this.authService.revokeAllSessions(user.id);
    clearRefreshCookie(res, this.config);
    res.set('Cache-Control', 'no-store');
  }
}
