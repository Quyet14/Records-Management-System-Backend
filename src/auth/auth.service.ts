import { Injectable, UnauthorizedException, BadRequestException, ServiceUnavailableException, HttpException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, MoreThan, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { DEFAULT_USER_PERMISSIONS, User, UserRole } from '../entities/user.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { OtpCode } from '../entities/otp-code.entity';
import { LoginConfirmation } from '../entities/login-confirmation.entity';
import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { AuthSession } from '../entities/auth-session.entity';
import { AuthCaptcha } from '../entities/auth-captcha.entity';
import { sessionIdle } from './session-policy';
import { AuditLog } from '../entities/audit-log.entity';

const ACCESS_TOKEN_SECONDS = 20 * 60;
const REFRESH_TOKEN_TTL_DAYS = 30;
/** OTP hết hạn sau 5 phút */
const OTP_TTL_MINUTES = 5;
/** Tối đa 5 lần nhập sai OTP thì khóa */
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_INTERVAL_MS = 60_000;
const OTP_MAX_REQUESTS_PER_HOUR = 10;
const CONFIRM_TTL_MINUTES = 15;
const RESET_TOKEN_TTL_MINUTES = 15;
const CAPTCHA_TTL_MINUTES = 5;
const CAPTCHA_MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  private mailer: Transporter | null = null;

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

  async createCaptcha() {
    const id = crypto.randomUUID();
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let index = 0; index < 5; index += 1) {
      code += alphabet[crypto.randomInt(alphabet.length)];
    }

    await this.usersRepo.manager.save(AuthCaptcha, {
      id,
      codeHash: crypto.createHash('sha256').update(code).digest('hex'),
      expiresAt: new Date(Date.now() + CAPTCHA_TTL_MINUTES * 60 * 1000),
      attempts: 0,
      usedAt: null,
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

  async verifyCaptcha(captchaId: string, rawCode: string) {
    const codeHash = crypto.createHash('sha256').update((rawCode || '').trim().toUpperCase()).digest('hex');
    const valid = await this.usersRepo.manager.transaction(async manager => {
      const challenge = await manager.findOne(AuthCaptcha, { where: { id: captchaId }, lock: { mode: 'pessimistic_write' } });
      if (!challenge || challenge.usedAt || challenge.expiresAt <= new Date() || challenge.attempts >= CAPTCHA_MAX_ATTEMPTS) return false;
      challenge.attempts++;
      const matches = challenge.codeHash === codeHash;
      if (matches) challenge.usedAt = new Date();
      await manager.save(AuthCaptcha, challenge);
      return matches;
    });
    if (!valid) throw new UnauthorizedException('Mã xác nhận không đúng, đã dùng hoặc hết hạn. Vui lòng tải mã mới.');
  }

  async validateLoginEmail(email: string): Promise<User> {
    const user = await this.usersRepo.findOne({ where: { email: email.trim().toLowerCase() }, relations: ['department'] });
    if (!user?.isActive) throw new UnauthorizedException('Email chưa được đăng ký hoặc tài khoản không hoạt động.');
    return user;
  }

  // ─── Bước 1: Xác thực email/password → gửi OTP ──────────
  async validateUser(email: string, password: string): Promise<User> {
    const result = await this.usersRepo.manager.transaction(async manager => {
      const user = await manager.getRepository(User).createQueryBuilder('user').addSelect('user.passwordHash')
        .leftJoinAndSelect('user.department', 'department').where('user.email = :email', { email: email.trim().toLowerCase() })
        .setLock('pessimistic_write').getOne();
      if (!user?.isActive || (user.authLockedUntil && user.authLockedUntil > new Date())) return null;
      const valid = await bcrypt.compare(password, user.passwordHash);
      await this.recordAuthAttempt(manager, user, valid, 'password');
      return valid ? user : null;
    });
    if (!result) throw new UnauthorizedException('Email hoặc mật khẩu không đúng, hoặc tài khoản đang tạm khóa.');
    return result;
  }

  private async recordAuthAttempt(manager: EntityManager, user: User, valid: boolean, purpose = 'login_otp') {
    const failures = valid ? 0 : (user.authLockedUntil && user.authLockedUntil <= new Date() ? 0 : user.failedAuthAttempts || 0) + 1;
    await manager.update(User, user.id, { failedAuthAttempts: failures,
      authLockedUntil: failures >= 5 ? new Date(Date.now() + 15 * 60000) : null });
    await manager.save(AuditLog, manager.create(AuditLog, { actor: { id: user.id }, action: 'auth_verification',
      metadata: { purpose, result: valid ? 'success' : 'failure', failedAttempts: failures, locked: failures >= 5 } }));
  }

  /** Every new browser/device must prove access to the registered mailbox. */
  async loginStep1(user: User, ipAddress?: string) {
    if (!this.mailer) throw new ServiceUnavailableException('Chưa cấu hình SMTP để gửi OTP đăng nhập.');
    const rawOtp = String(crypto.randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60000);
    const challenge = await this.otpRepo.manager.transaction(async manager => {
      const current = await manager.findOne(User, { where: { id: user.id }, lock: { mode: 'pessimistic_write' } });
      if (!current?.isActive) throw new UnauthorizedException('Tài khoản không hoạt động.');
      if (current.authLockedUntil && current.authLockedUntil > new Date()) throw new HttpException('Tài khoản tạm khóa do xác thực sai nhiều lần. Vui lòng thử lại sau.', 429);
      const recent = await manager.findOne(OtpCode, { where: { user: { id: user.id }, purpose: 'login' }, order: { createdAt: 'DESC' } });
      const count = await manager.count(OtpCode, { where: { user: { id: user.id }, purpose: 'login', createdAt: MoreThan(new Date(Date.now() - 3600000)) } });
      if (count >= OTP_MAX_REQUESTS_PER_HOUR)
        throw new HttpException('Bạn đã yêu cầu quá số mã OTP cho phép trong một giờ.', 429);
      if (recent) {
        const remainingMs = OTP_RESEND_INTERVAL_MS - (Date.now() - recent.createdAt.getTime());
        if (remainingMs > 0)
          throw new HttpException(`Vui lòng chờ ${Math.ceil(remainingMs / 1000)} giây trước khi yêu cầu OTP mới.`, 429);
      }
      await manager.update(OtpCode, { user: { id: user.id }, purpose: 'login', isUsed: false }, { isUsed: true });
      await manager.save(AuditLog, manager.create(AuditLog, { actor: { id: user.id }, action: 'otp_requested',
        metadata: { purpose: 'login', result: 'success', ip: ipAddress } }));
      return manager.save(OtpCode, manager.create(OtpCode, { user: { id: user.id },
        codeHash: this.loginOtpHash(user.id, rawOtp), expiresAt, isUsed: false, purpose: 'login', attempts: 0, ipAddress, createdAt: new Date() }));
    });
    try { await this.sendOtpEmail(user.email, user.fullName, rawOtp); }
    catch (error) { await this.otpRepo.update(challenge.id, { isUsed: true }); throw error; }

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
    userAgent?: string,
  ) {
    const codeHash = this.loginOtpHash(userId, String(rawOtp || '').trim());
    const result = await this.otpRepo.manager.transaction(async manager => {
      // User -> OTP lock order also serializes concurrent verifications across PM2 workers.
      const user = await manager.findOne(User, { where: { id: userId }, relations: ['department'], lock: { mode: 'pessimistic_write' } });
      if (!user?.isActive) return null;
      if (user.authLockedUntil && user.authLockedUntil > new Date()) return null;
      const otp = await manager.findOne(OtpCode, { where: { user: { id: userId }, isUsed: false, purpose: 'login' },
        order: { createdAt: 'DESC' }, lock: { mode: 'pessimistic_write' } });
      if (!otp || otp.expiresAt <= new Date() || otp.attempts >= OTP_MAX_ATTEMPTS) return null;
      otp.attempts++;
      const valid = /^\d{6}$/.test(rawOtp || '') && otp.codeHash === codeHash;
      if (valid) otp.isUsed = true;
      await manager.save(OtpCode, otp);
      await this.recordAuthAttempt(manager, user, valid);
      return valid ? this.login(user, ipAddress, manager, userAgent) : null;
    });
    if (!result) throw new UnauthorizedException('Mã OTP không đúng, đã dùng hoặc hết hạn.');
    return result;
  }

  private loginOtpHash(userId: string, otp: string): string {
    return crypto.createHmac('sha256', this.configService.get<string>('JWT_SECRET') || '')
      .update(`login:${userId}:${otp}`).digest('hex');
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
    await this.revokeAllSessions(userId);
    user.passwordHash = passwordHash;
    user.mustChangePassword = false;
    return this.loginStep1(user, ipAddress);
  }

  async forgotPassword(email: string, ipAddress?: string) {
    const result = { message: 'Nếu email tồn tại trong hệ thống, mã xác nhận đã được gửi.' };
    const user = await this.usersRepo.findOne({ where: { email } });
    if (!user || !user.isActive) return result;

    const rawOtp = String(crypto.randomInt(100000, 999999));
    const challenge = await this.otpRepo.manager.transaction(async manager => {
      const current = await manager.findOne(User, { where: { id: user.id }, lock: { mode: 'pessimistic_write' } });
      if (!current?.isActive || (current.authLockedUntil && current.authLockedUntil > new Date()))
        throw new HttpException('Tài khoản đang tạm khóa. Vui lòng thử lại sau.', 429);
      const recent = await manager.findOne(OtpCode, { where: { user: { id: user.id }, purpose: 'reset_password' }, order: { createdAt: 'DESC' } });
      const count = await manager.count(OtpCode, { where: { user: { id: user.id }, purpose: 'reset_password', createdAt: MoreThan(new Date(Date.now() - 3600000)) } });
      if (count >= OTP_MAX_REQUESTS_PER_HOUR || (recent && Date.now() - recent.createdAt.getTime() < OTP_RESEND_INTERVAL_MS))
        throw new HttpException('Vui lòng chờ trước khi yêu cầu OTP mới.', 429);
      await manager.update(OtpCode, { user: { id: user.id }, isUsed: false, purpose: 'reset_password' }, { isUsed: true });
      return manager.save(OtpCode, manager.create(OtpCode, { user: { id: user.id },
        codeHash: this.resetOtpHash(user.id, rawOtp), expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60000),
        isUsed: false, purpose: 'reset_password', attempts: 0, ipAddress, createdAt: new Date() }));
    });
    try { await this.sendOtpEmail(user.email, user.fullName, rawOtp, 'reset_password'); }
    catch (error) { await this.otpRepo.update(challenge.id, { isUsed: true }); throw error; }
    return result;
  }

  async verifyResetOtp(email: string, rawOtp: string) {
    const user = await this.usersRepo.findOne({ where: { email } });
    if (!user) throw new UnauthorizedException('Mã xác nhận không đúng hoặc đã hết hạn');
    const result = await this.otpRepo.manager.transaction(async manager => {
      const current = await manager.findOne(User, { where: { id: user.id }, lock: { mode: 'pessimistic_write' } });
      if (!current?.isActive) return null;
      if (current.authLockedUntil && current.authLockedUntil > new Date()) return null;
      const otp = await manager.findOne(OtpCode, { where: { user: { id: user.id }, isUsed: false, purpose: 'reset_password' },
        order: { createdAt: 'DESC' }, lock: { mode: 'pessimistic_write' } });
      if (!otp || otp.expiresAt <= new Date() || otp.attempts >= OTP_MAX_ATTEMPTS) return null;
      otp.attempts++;
      const valid = /^\d{6}$/.test(rawOtp) && otp.codeHash === this.resetOtpHash(user.id, rawOtp);
      if (valid) otp.isUsed = true;
      await manager.save(OtpCode, otp);
      await this.recordAuthAttempt(manager, current, valid, 'reset_otp');
      if (!valid) return null;
      await manager.update(PasswordResetToken, { user: { id: user.id }, isUsed: false }, { isUsed: true });
      const rawToken = crypto.randomBytes(32).toString('hex');
      await manager.save(PasswordResetToken, manager.create(PasswordResetToken, { user: { id: user.id },
        tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'), isUsed: false,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60000) }));
      return { reset_token: rawToken, expires_in: RESET_TOKEN_TTL_MINUTES * 60 };
    });
    if (!result) throw new UnauthorizedException('Mã xác nhận không đúng, đã dùng hoặc hết hạn.');
    return result;
  }

  private resetOtpHash(userId: string, otp: string): string {
    return crypto.createHmac('sha256', this.configService.get<string>('JWT_SECRET') || '').update(`reset:${userId}:${otp}`).digest('hex');
  }

  async resetPassword(rawToken: string, newPassword: string, confirmPassword: string) {
    this.assertNewPassword(newPassword, confirmPassword);
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const hint = await this.resetTokenRepo.findOne({ where: { tokenHash }, relations: ['user'] });
    if (!hint || hint.isUsed || hint.expiresAt <= new Date()) {
      throw new UnauthorizedException('Yêu cầu đặt lại mật khẩu không hợp lệ hoặc đã hết hạn');
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const changed = await this.resetTokenRepo.manager.transaction(async manager => {
      const user = await manager.findOne(User, { where: { id: hint.user.id }, lock: { mode: 'pessimistic_write' } });
      const record = await manager.findOne(PasswordResetToken, { where: { tokenHash }, relations: ['user'], lock: { mode: 'pessimistic_write' } });
      if (!user?.isActive || !record || record.user.id !== user.id || record.isUsed || record.expiresAt <= new Date()) return false;
      await manager.update(User, user.id, { passwordHash, mustChangePassword: false, failedAuthAttempts: 0, authLockedUntil: null });
      record.isUsed = true; await manager.save(PasswordResetToken, record);
      await manager.update(AuthSession, { userId: user.id, revokedAt: IsNull() }, { revokedAt: new Date() });
      await manager.update(RefreshToken, { user: { id: user.id }, isRevoked: false }, { isRevoked: true });
      await manager.save(AuditLog, manager.create(AuditLog, { actor: { id: user.id }, action: 'password_reset', metadata: { result: 'success' } }));
      return true;
    });
    if (!changed) throw new UnauthorizedException('Yêu cầu đặt lại mật khẩu đã dùng hoặc hết hạn.');
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
    return this.confirmRepo.manager.transaction(async manager => {
      const record = await manager.findOne(LoginConfirmation, { where: { id: pendingLoginId },
        relations: ['user', 'user.department'], lock: { mode: 'pessimistic_write' } });
      if (!record || record.isConsumed || record.expiresAt <= new Date() || !record.isConfirmed || !record.user.isActive)
        throw new UnauthorizedException('Phiên xác nhận không hợp lệ hoặc đã hết hạn');
      record.isConsumed = true;
      await manager.save(LoginConfirmation, record);
      return this.login(record.user, ipAddress, manager);
    });
  }

  // ─── Phát hành token (internal) ──────────────────────────
  async login(user: User, ipAddress?: string, manager?: EntityManager, userAgent?: string) {
    const create = async (m: EntityManager) => {
      if (!user.isActive) throw new UnauthorizedException('Tài khoản không hoạt động.');
      const session = await m.save(AuthSession, m.create(AuthSession, { id: crypto.randomUUID(), userId: user.id,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86400000), revokedAt: null, createdAt: new Date(),
        lastSeenAt: new Date(), ipAddress: ipAddress?.slice(0, 64) || null, userAgent: userAgent?.slice(0, 500) || null }));
      const rawRefreshToken = await this.createRefreshToken(m, user.id, session, ipAddress);
      await m.save(AuditLog, m.create(AuditLog, { actor: { id: user.id }, action: 'login',
        metadata: { sessionId: session.id, ip: ipAddress, result: 'success' } }));
      return this.tokenResponse(user, session, rawRefreshToken);
    };
    return manager ? create(manager) : this.rtRepo.manager.transaction(create);
  }

  private async createRefreshToken(manager: EntityManager, userId: string, session: AuthSession, ipAddress?: string) {
    const raw = crypto.randomBytes(40).toString('hex');
    await manager.save(RefreshToken, manager.create(RefreshToken, {
      tokenHash: crypto.createHash('sha256').update(raw).digest('hex'), sessionId: session.id,
      user: { id: userId }, ipAddress, expiresAt: session.expiresAt, isRevoked: false, consumedAt: null,
    }));
    return raw;
  }

  private tokenResponse(user: User, session: AuthSession, rawRefreshToken: string) {
    const payload = {
      sub: user.id,
      sid: session.id,
      jti: crypto.randomUUID(),
      auth_time: Math.floor(session.createdAt.getTime() / 1000),
      email: user.email,
      role: user.role,
      departmentId: user.department?.id ?? null,
      permissions:
        user.permissions ??
        (user.role === UserRole.USER ? DEFAULT_USER_PERMISSIONS : []),
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: ACCESS_TOKEN_SECONDS,
    });

    return {
      access_token: accessToken,
      refresh_token: rawRefreshToken,
      refresh_expires_at: session.expiresAt,
      expires_in: ACCESS_TOKEN_SECONDS,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        permissions:
          user.permissions ??
          (user.role === UserRole.USER ? DEFAULT_USER_PERMISSIONS : []),
        department: user.department
          ? { id: user.department.id, name: user.department.name }
          : null,
      },
    };
  }

  /** Đổi refresh token cũ lấy access token mới */
  async refresh(rawRefreshToken: string | undefined, ipAddress?: string) {
    if (typeof rawRefreshToken !== 'string' || !/^[a-f0-9]{80}$/i.test(rawRefreshToken)) {
      throw new UnauthorizedException('Thiếu refresh token hợp lệ, vui lòng đăng nhập lại');
    }
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

    const hint = await this.rtRepo.findOne({ where: { tokenHash } });
    if (!hint?.sessionId) throw new UnauthorizedException('Phiên cũ không còn hợp lệ. Vui lòng đăng nhập bằng OTP.');
    const result = await this.rtRepo.manager.transaction(async manager => {
      // Always lock family before token: reuse revokes descendants even across workers.
      const session = await manager.findOne(AuthSession, { where: { id: hint.sessionId! }, lock: { mode: 'pessimistic_write' } });
      const token = await manager.findOne(RefreshToken, { where: { tokenHash }, lock: { mode: 'pessimistic_write' } });
      if (!session || !token || session.revokedAt || session.expiresAt <= new Date() || sessionIdle(session)) return null;
      if (token.isRevoked || token.consumedAt) {
        await this.revokeSession(manager, session, 'refresh_token_reuse');
        return null; // Commit revocation before returning 401.
      }
      if (token.sessionId !== session.id || token.expiresAt <= new Date()) return null;
      const user = await manager.findOne(User, { where: { id: session.userId }, relations: ['department'] });
      if (!user?.isActive) { await this.revokeSession(manager, session); return null; }
      token.isRevoked = true; token.consumedAt = new Date();
      session.lastSeenAt = new Date();
      await manager.save(AuthSession, session);
      await manager.save(RefreshToken, token);
      const raw = await this.createRefreshToken(manager, user.id, session, ipAddress);
      return this.tokenResponse(user, session, raw);
    });
    if (!result) throw new UnauthorizedException('Phiên hết hạn, đã đăng xuất hoặc phát hiện token bị dùng lại. Vui lòng đăng nhập bằng OTP.');
    return result;
  }

  private async revokeSession(manager: EntityManager, session: AuthSession, reason = 'logout'): Promise<void> {
    await manager.update(AuthSession, session.id, { revokedAt: new Date() });
    await manager.update(RefreshToken, { sessionId: session.id }, { isRevoked: true });
    await manager.save(AuditLog, manager.create(AuditLog, { actor: { id: session.userId }, action: 'session_revoked',
      metadata: { sessionId: session.id, reason, result: 'success' } }));
  }

  async listSessions(userId: string, currentId: string) {
    const sessions = await this.rtRepo.manager.find(AuthSession, { where: { userId, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'DESC' } });
    return sessions.filter(session => !sessionIdle(session)).map(session => ({ id: session.id, current: session.id === currentId,
      createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt,
      ipAddress: session.ipAddress, userAgent: session.userAgent }));
  }

  async logoutDevice(userId: string, sessionId: string) {
    await this.rtRepo.manager.transaction(async m => {
      const session = await m.findOne(AuthSession, { where: { id: sessionId, userId }, lock: { mode: 'pessimistic_write' } });
      if (!session) throw new UnauthorizedException('Không tìm thấy phiên thuộc tài khoản của bạn.');
      await this.revokeSession(m, session);
    });
    return { success: true };
  }

  async logout(rawRefreshToken?: string): Promise<void> {
    if (!rawRefreshToken || !/^[a-f0-9]{80}$/i.test(rawRefreshToken)) return;
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    const token = await this.rtRepo.findOne({ where: { tokenHash } });
    if (!token?.sessionId) return;
    await this.rtRepo.manager.transaction(async manager => {
      const session = await manager.findOne(AuthSession, { where: { id: token.sessionId! }, lock: { mode: 'pessimistic_write' } });
      if (session) await this.revokeSession(manager, session);
    });
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.rtRepo.manager.transaction(async manager => {
      await manager.findOne(User, { where: { id: userId }, lock: { mode: 'pessimistic_write' } });
      await manager.update(AuthSession, { userId, revokedAt: IsNull() }, { revokedAt: new Date() });
      await manager.update(RefreshToken, { user: { id: userId }, isRevoked: false }, { isRevoked: true });
      await manager.save(AuditLog, manager.create(AuditLog, { actor: { id: userId }, action: 'logout_all', metadata: { result: 'success' } }));
    });
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

    if (!this.mailer) throw new ServiceUnavailableException('Chưa cấu hình SMTP để gửi mã OTP.');
    try {
      const result = await this.mailer.sendMail({
          from: this.configService.get<string>('SMTP_FROM') || 'LTHS <no-reply@lths.local>',
          to,
          subject,
          html,
      });
      if (!result.accepted?.some(address => String(address).toLowerCase() === to.toLowerCase()))
        throw Error('SMTP did not accept recipient');
    } catch { throw new ServiceUnavailableException('Không thể gửi OTP. Vui lòng kiểm tra dịch vụ email.'); }
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
