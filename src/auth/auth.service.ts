import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User } from '../entities/user.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { OtpCode } from '../entities/otp-code.entity';
import { LoginConfirmation } from '../entities/login-confirmation.entity';
import { PasswordResetToken } from '../entities/password-reset-token.entity';

const ACCESS_TOKEN_TTL      = '8h';
const REFRESH_TOKEN_TTL_DAYS = 30;
/** OTP hết hạn sau 5 phút */
const OTP_TTL_MINUTES = 5;
/** Tối đa 5 lần nhập sai OTP thì khóa */
const OTP_MAX_ATTEMPTS = 5;
const CONFIRM_TTL_MINUTES = 15;
const RESET_TOKEN_TTL_MINUTES = 15;
const CAPTCHA_TTL_MINUTES = 5;
const CAPTCHA_MAX_ATTEMPTS = 5;

type CaptchaChallenge = {
  codeHash: string;
  expiresAt: number;
  attempts: number;
};

@Injectable()
export class AuthService {
  private mailer: Transporter | null = null;
  private readonly captchaChallenges = new Map<string, CaptchaChallenge>();

  constructor(
    @InjectRepository(User)         private usersRepo: Repository<User>,
    @InjectRepository(RefreshToken) private rtRepo: Repository<RefreshToken>,
    @InjectRepository(OtpCode)      private otpRepo: Repository<OtpCode>,
    @InjectRepository(LoginConfirmation) private confirmRepo: Repository<LoginConfirmation>,
    @InjectRepository(PasswordResetToken) private resetTokenRepo: Repository<PasswordResetToken>,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {
    this.initMailer();
  }

  private initMailer() {
    const host = this.configService.get<string>('SMTP_HOST');
    if (!host) return;
    this.mailer = createTransport({
      host,
      port: parseInt(this.configService.get<string>('SMTP_PORT') || '587'),
      secure: this.configService.get<string>('SMTP_SECURE') === 'true',
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });
  }

  createCaptcha() {
    this.removeExpiredCaptchas();

    const id = crypto.randomUUID();
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let index = 0; index < 5; index += 1) {
      code += alphabet[crypto.randomInt(alphabet.length)];
    }

    this.captchaChallenges.set(id, {
      codeHash: crypto.createHash('sha256').update(code).digest('hex'),
      expiresAt: Date.now() + CAPTCHA_TTL_MINUTES * 60 * 1000,
      attempts: 0,
    });

    const chars = [...code].map((character, index) => {
      const x = 22 + index * 27;
      const rotation = crypto.randomInt(-16, 17);
      return `<text x="${x}" y="48" transform="rotate(${rotation} ${x} 48)">${character}</text>`;
    }).join('');
    const lines = Array.from({ length: 4 }, () => {
      const x1 = crypto.randomInt(0, 150);
      const y1 = crypto.randomInt(12, 68);
      const x2 = crypto.randomInt(0, 150);
      const y2 = crypto.randomInt(12, 68);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="80" viewBox="0 0 150 80" role="img" aria-label="Mã xác nhận"><rect width="150" height="80" rx="8" fill="#f3f4f6"/><g stroke="#9ca3af" stroke-width="1">${lines}</g><g fill="#111827" font-family="monospace" font-size="30" font-weight="700">${chars}</g></svg>`;

    return {
      captcha_id: id,
      image: `data:image/svg+xml,${encodeURIComponent(svg)}`,
      expires_in: CAPTCHA_TTL_MINUTES * 60,
    };
  }

  verifyCaptcha(captchaId: string, rawCode: string) {
    const challenge = this.captchaChallenges.get(captchaId);
    const codeHash = crypto.createHash('sha256').update((rawCode || '').trim().toUpperCase()).digest('hex');

    if (!challenge || challenge.expiresAt < Date.now()) {
      this.captchaChallenges.delete(captchaId);
      throw new UnauthorizedException('Mã xác nhận đã hết hạn. Vui lòng tải mã mới.');
    }
    if (challenge.attempts >= CAPTCHA_MAX_ATTEMPTS) {
      this.captchaChallenges.delete(captchaId);
      throw new UnauthorizedException('Mã xác nhận đã bị khóa. Vui lòng tải mã mới.');
    }
    if (challenge.codeHash !== codeHash) {
      challenge.attempts += 1;
      throw new UnauthorizedException('Mã xác nhận không đúng.');
    }

    this.captchaChallenges.delete(captchaId);
  }

  private removeExpiredCaptchas() {
    const now = Date.now();
    for (const [captchaId, challenge] of this.captchaChallenges) {
      if (challenge.expiresAt < now) this.captchaChallenges.delete(captchaId);
    }
  }

  // ─── Bước 1: Xác thực email/password → gửi OTP ──────────
  async validateUser(email: string, password: string): Promise<User> {
    const user = await this.usersRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .leftJoinAndSelect('user.department', 'department')
      .where('user.email = :email', { email })
      .getOne();

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }

    return user;
  }

  /**
   * Login bước 1: nếu OTP_ENABLED=true → gửi OTP, trả pending.
   * Nếu OTP_ENABLED=false → trả token thẳng (tương thích frontend cũ).
   */
  async loginStep1(user: User, ipAddress?: string) {
    if (user.mustChangePassword) {
      return { must_change_password: true, user_id: user.id };
    }

    const otpEnabled = this.configService.get<string>('OTP_ENABLED') === 'true';
    // Chỉ bật OTP cho tài khoản có email thật (không phải email @bvhn.vn tự sinh)
    const isRealEmail = !user.email.endsWith('@bvhn.vn');

    if (!otpEnabled || !isRealEmail) {
      // OTP tắt hoặc email giả — trả token thẳng
      return this.login(user, ipAddress);
    }

    // Xóa OTP cũ chưa dùng của user này
    await this.otpRepo.delete({ user: { id: user.id }, isUsed: false, purpose: 'login' } as any);

    // Generate OTP 6 số
    const rawOtp = String(crypto.randomInt(100000, 999999));
    const codeHash = crypto.createHash('sha256').update(rawOtp).digest('hex');

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + OTP_TTL_MINUTES);

    await this.otpRepo.save(
      this.otpRepo.create({
        user: { id: user.id } as any,
        codeHash,
        expiresAt,
        isUsed: false,
        purpose: 'login',
        attempts: 0,
        ipAddress: ipAddress ?? undefined,
      }),
    );

    // Gửi OTP qua email
    await this.sendOtpEmail(user.email, user.fullName, rawOtp);

    // Che email: van***@gmail.com
    const [local, domain] = user.email.split('@');
    const emailHint = local.slice(0, 3) + '***@' + domain;

    return {
      requires_otp: true,
      user_id: user.id,
      email_hint: emailHint,
      expires_in: OTP_TTL_MINUTES * 60,
    };
  }

  /** Login bước 2: OTP đúng thì cấp token ngay. */
  async verifyOtp(
    userId: string,
    rawOtp: string,
    ipAddress?: string,
  ) {
    const codeHash = crypto.createHash('sha256').update(rawOtp.trim()).digest('hex');

    const otp = await this.otpRepo.findOne({
      where: { user: { id: userId }, isUsed: false, purpose: 'login' } as any,
      relations: ['user', 'user.department'],
      order: { createdAt: 'DESC' } as any,
    });

    if (!otp) {
      throw new UnauthorizedException('Mã OTP không đúng');
    }

    if (otp.expiresAt < new Date()) {
      throw new UnauthorizedException(
        `Mã OTP đã hết hạn. Vui lòng đăng nhập lại để nhận mã mới.`,
      );
    }

    if ((otp.attempts ?? 0) >= OTP_MAX_ATTEMPTS) {
      throw new UnauthorizedException('Bạn đã nhập sai quá số lần cho phép. Vui lòng đăng nhập lại để nhận mã mới.');
    }
    if (otp.codeHash !== codeHash) {
      otp.attempts = (otp.attempts ?? 0) + 1;
      await this.otpRepo.save(otp);
      throw new UnauthorizedException('Mã OTP không đúng');
    }

    // Đánh dấu đã dùng
    otp.isUsed = true;
    await this.otpRepo.save(otp);

    return this.login(otp.user, ipAddress);
  }

  async forceChangePassword(
    userId: string,
    newPassword: string,
    confirmPassword: string,
    ipAddress?: string,
  ) {
    this.assertNewPassword(newPassword, confirmPassword);
    const user = await this.usersRepo.findOne({ where: { id: userId }, relations: ['department'] });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Tài khoản không tồn tại hoặc đã bị vô hiệu hoá');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.usersRepo.update(userId, { passwordHash, mustChangePassword: false } as any);
    user.passwordHash = passwordHash;
    user.mustChangePassword = false;
    return this.loginStep1(user, ipAddress);
  }

  async forgotPassword(email: string, ipAddress?: string) {
    const result = { message: 'Nếu email tồn tại trong hệ thống, mã xác nhận đã được gửi.' };
    const user = await this.usersRepo.findOne({ where: { email } });
    if (!user || !user.isActive) return result;

    await this.otpRepo.delete({ user: { id: user.id }, isUsed: false, purpose: 'reset_password' } as any);
    const rawOtp = String(crypto.randomInt(100000, 999999));
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + OTP_TTL_MINUTES);
    await this.otpRepo.save(this.otpRepo.create({
      user: { id: user.id } as any,
      codeHash: crypto.createHash('sha256').update(rawOtp).digest('hex'),
      expiresAt,
      isUsed: false,
      purpose: 'reset_password',
      attempts: 0,
      ipAddress: ipAddress ?? undefined,
    }));
    await this.sendOtpEmail(user.email, user.fullName, rawOtp, 'reset_password');
    return result;
  }

  async verifyResetOtp(email: string, rawOtp: string) {
    const user = await this.usersRepo.findOne({ where: { email } });
    if (!user) throw new UnauthorizedException('Mã xác nhận không đúng hoặc đã hết hạn');
    const otp = await this.otpRepo.findOne({
      where: { user: { id: user.id }, isUsed: false, purpose: 'reset_password' } as any,
      order: { createdAt: 'DESC' } as any,
    });
    const codeHash = crypto.createHash('sha256').update(rawOtp.trim()).digest('hex');
    if (!otp || otp.expiresAt < new Date()) throw new UnauthorizedException('Mã xác nhận không đúng hoặc đã hết hạn');
    if ((otp.attempts ?? 0) >= OTP_MAX_ATTEMPTS) throw new UnauthorizedException('Bạn đã nhập sai quá số lần cho phép');
    if (otp.codeHash !== codeHash) {
      otp.attempts = (otp.attempts ?? 0) + 1;
      await this.otpRepo.save(otp);
      throw new UnauthorizedException('Mã xác nhận không đúng');
    }
    otp.isUsed = true;
    await this.otpRepo.save(otp);

    await this.resetTokenRepo.delete({ user: { id: user.id }, isUsed: false } as any);
    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + RESET_TOKEN_TTL_MINUTES);
    await this.resetTokenRepo.save(this.resetTokenRepo.create({
      user: { id: user.id } as any,
      tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      isUsed: false,
      expiresAt,
    }));
    return { reset_token: rawToken, expires_in: RESET_TOKEN_TTL_MINUTES * 60 };
  }

  async resetPassword(rawToken: string, newPassword: string, confirmPassword: string) {
    this.assertNewPassword(newPassword, confirmPassword);
    const record = await this.resetTokenRepo.findOne({
      where: { tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex') },
      relations: ['user'],
    });
    if (!record || record.isUsed || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Yêu cầu đặt lại mật khẩu không hợp lệ hoặc đã hết hạn');
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.usersRepo.update(record.user.id, { passwordHash, mustChangePassword: false } as any);
    record.isUsed = true;
    await this.resetTokenRepo.save(record);
    await this.revokeAllSessions(record.user.id);
    return { success: true, message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại.' };
  }

  private assertNewPassword(newPassword: string, confirmPassword: string) {
    if (newPassword !== confirmPassword) throw new BadRequestException('Mật khẩu xác nhận không khớp');
    if (!newPassword || newPassword.length < 8) throw new BadRequestException('Mật khẩu phải có ít nhất 8 ký tự');
  }

  private async createPendingConfirmation(user: User, ipAddress?: string) {
    await this.confirmRepo.delete({ user: { id: user.id }, isConsumed: false } as any);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + CONFIRM_TTL_MINUTES);

    const record = await this.confirmRepo.save(this.confirmRepo.create({
      user: { id: user.id } as any,
      tokenHash,
      isConfirmed: false,
      isConsumed: false,
      ipAddress: ipAddress ?? null,
      expiresAt,
    }));

    const baseUrl = this.configService.get<string>('APP_BASE_URL') || 'http://localhost:3000';
    const confirmUrl = `${baseUrl}/auth/confirm-login?token=${rawToken}`;
    await this.sendConfirmationEmail(user.email, user.fullName, confirmUrl);

    return {
      requires_email_confirmation: true,
      pending_login_id: record.id,
      expires_in: CONFIRM_TTL_MINUTES * 60,
    };
  }

  async confirmLoginByToken(rawToken: string) {
    const tokenHash = crypto.createHash('sha256').update(rawToken || '').digest('hex');
    const record = await this.confirmRepo.findOne({ where: { tokenHash } });
    if (!record) return { ok: false, message: 'Liên kết không hợp lệ.' };
    if (record.isConsumed) return { ok: false, message: 'Liên kết này đã được sử dụng.' };
    if (record.expiresAt < new Date()) return { ok: false, message: 'Liên kết đã hết hạn.' };

    record.isConfirmed = true;
    await this.confirmRepo.save(record);
    return { ok: true, message: 'Xác nhận thành công. Bạn có thể quay lại tab đăng nhập.' };
  }

  async getConfirmationStatus(pendingLoginId: string) {
    const record = await this.confirmRepo.findOne({ where: { id: pendingLoginId } });
    if (!record || record.isConsumed || record.expiresAt < new Date()) {
      return { confirmed: false };
    }
    return { confirmed: record.isConfirmed };
  }

  async completeLogin(pendingLoginId: string, ipAddress?: string) {
    const record = await this.confirmRepo.findOne({
      where: { id: pendingLoginId },
      relations: ['user', 'user.department'],
    });
    if (!record || record.isConsumed || record.expiresAt < new Date() || !record.isConfirmed) {
      throw new UnauthorizedException('Phiên xác nhận không hợp lệ hoặc đã hết hạn');
    }

    record.isConsumed = true;
    await this.confirmRepo.save(record);
    return this.login(record.user, ipAddress);
  }

  // ─── Phát hành token (internal) ──────────────────────────
  async login(user: User, ipAddress?: string) {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      departmentId: user.department?.id ?? null,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: ACCESS_TOKEN_TTL,
    });

    const rawRefreshToken = crypto.randomBytes(40).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_TTL_DAYS);

    const rt = this.rtRepo.create({
      tokenHash,
      user: { id: user.id } as any,
      ipAddress: ipAddress ?? undefined,
      expiresAt,
      isRevoked: false,
    });
    await this.rtRepo.save(rt);

    return {
      access_token: accessToken,
      refresh_token: rawRefreshToken,
      expires_in: 8 * 60 * 60, // 8 giờ tính bằng giây
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        department: user.department
          ? { id: user.department.id, name: user.department.name }
          : null,
      },
    };
  }

  /** Đổi refresh token cũ lấy access token mới */
  async refresh(rawRefreshToken: string, ipAddress?: string) {
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

    const rt = await this.rtRepo.findOne({
      where: { tokenHash },
      relations: ['user', 'user.department'],
    });

    if (!rt || rt.isRevoked || rt.expiresAt < new Date()) {
      if (rt) {
        await this.rtRepo.update({ user: { id: rt.user.id } }, { isRevoked: true });
      }
      throw new UnauthorizedException('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
    }

    if (!rt.user.isActive) {
      throw new UnauthorizedException('Tài khoản đã bị vô hiệu hoá');
    }

    rt.isRevoked = true;
    await this.rtRepo.save(rt);

    return this.login(rt.user, ipAddress);
  }

  async logout(rawRefreshToken: string): Promise<void> {
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    await this.rtRepo.update({ tokenHash }, { isRevoked: true });
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.rtRepo.update({ user: { id: userId }, isRevoked: false }, { isRevoked: true });
  }

  async purgeExpired(): Promise<number> {
    const result = await this.rtRepo
      .createQueryBuilder()
      .delete()
      .where('expires_at < :now', { now: new Date() })
      .execute();
    return result.affected ?? 0;
  }

  /** Dọn OTP hết hạn */
  async purgeExpiredOtp(): Promise<number> {
    const result = await this.otpRepo
      .createQueryBuilder()
      .delete()
      .where('expires_at < :now OR is_used = 1', { now: new Date() })
      .execute();
    return result.affected ?? 0;
  }

  // ─── Helper gửi email ────────────────────────────────────
  private async sendOtpEmail(to: string, name: string, otp: string, purpose = 'login') {
    const subject = purpose === 'reset_password'
      ? '[LTHS] Mã xác nhận đặt lại mật khẩu'
      : '[LTHS] Mã xác thực đăng nhập';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
        <h2 style="color:#1a365d">Xác thực đăng nhập</h2>
        <p>Xin chào <strong>${name}</strong>,</p>
        <p>Mã OTP đăng nhập của bạn là:</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;
                    color:#c05621;background:#fff3e0;padding:20px;
                    text-align:center;border-radius:8px;margin:20px 0">
          ${otp}
        </div>
        <p>Mã có hiệu lực trong <strong>${OTP_TTL_MINUTES} phút</strong>.</p>
        <p style="color:#718096;font-size:13px">
          Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua email này.<br>
          Không chia sẻ mã này cho bất kỳ ai.
        </p>
        <hr style="border:none;border-top:1px solid #e2e8f0">
        <p style="color:#a0aec0;font-size:12px">Hệ thống LTHS Lưu Trữ</p>
      </div>`;

    if (this.mailer) {
      try {
        await this.mailer.sendMail({
          from: this.configService.get<string>('SMTP_FROM') || 'LTHS <no-reply@lths.local>',
          to,
          subject,
          html,
        });
      } catch (err) {
        // Log nhưng không crash — dev mode không có SMTP vẫn chạy được
        console.warn(`[OTP] Không gửi được email tới ${to}:`, (err as Error).message);
        console.warn(`[OTP] Mã OTP (debug): ${otp}`);
      }
    } else {
      // Không có SMTP — in ra console để test
      console.log(`\n[OTP DEBUG] Gửi tới: ${to}`);
      console.log(`[OTP DEBUG] Mã OTP: ${otp}\n`);
    }
  }

  private async sendConfirmationEmail(to: string, name: string, confirmUrl: string) {
    const subject = '[LTHS] Xác nhận đăng nhập';
    const html = `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
      <h2 style="color:#1a365d">Xác nhận đăng nhập</h2>
      <p>Xin chào <strong>${name}</strong>,</p>
      <p>Nếu đây là bạn, hãy bấm nút bên dưới để hoàn tất đăng nhập:</p>
      <p style="text-align:center;margin:24px 0"><a href="${confirmUrl}" style="background:#2b6cb0;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold">Đây là tôi, xác nhận đăng nhập</a></p>
      <p>Liên kết có hiệu lực trong <strong>${CONFIRM_TTL_MINUTES} phút</strong>.</p>
    </div>`;

    if (this.mailer) {
      try {
        await this.mailer.sendMail({
          from: this.configService.get<string>('SMTP_FROM') || 'LTHS <no-reply@lths.local>',
          to,
          subject,
          html,
        });
      } catch (err) {
        console.warn(`[Confirm] Không gửi được email tới ${to}:`, (err as Error).message);
        console.warn(`[Confirm] Link (debug): ${confirmUrl}`);
      }
    } else {
      console.log(`\n[CONFIRM DEBUG] Link: ${confirmUrl}\n`);
    }
  }
}
