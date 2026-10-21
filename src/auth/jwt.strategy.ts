import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { DEFAULT_USER_PERMISSIONS, UserRole, User } from '../entities/user.entity';
import { AuthSession } from '../entities/auth-session.entity';
import { sessionIdle } from './session-policy';
import { LessThan } from 'typeorm';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService, @InjectRepository(User) private usersRepo: Repository<User>,
    @InjectRepository(AuthSession) private sessionsRepo: Repository<AuthSession>) {
    super({
      // Lấy token từ Authorization header HOẶC query string ?token=xxx
      // (cần cho trường hợp mở link trực tiếp từ Excel/email)
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: Request) => {
          // Query string: /documents/:id/view?token=xxx
          const token = req?.query?.token;
          if (typeof token !== 'string') return null;
          try {
            const hint = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
            // This only chooses an extractor. Passport still verifies signature and expiry.
            return ['file-download', 'file-view'].includes(hint.type) ? token : null;
          } catch { return null; }
        },
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  // Giá trị trả về ở đây sẽ được gán vào request.user
  async validate(payload: any) {
    if (!payload.sid) throw new UnauthorizedException('Cần đăng nhập lại bằng OTP.');
    const [user, session] = await Promise.all([this.usersRepo.findOne({
      where: { id: payload.sub },
      relations: ['department'],
      select: { id: true, fullName: true, email: true, role: true, isActive: true, permissions: true, department: { id: true } },
    }), payload.sid ? this.sessionsRepo.findOne({ where: { id: payload.sid, userId: payload.sub } }) : Promise.resolve(null)]);
    if (payload.sid && (!session || session.revokedAt || session.expiresAt <= new Date() || sessionIdle(session)))
      throw new UnauthorizedException('Phiên thiết bị không còn hợp lệ.');
    if (session && !['file-download', 'file-view'].includes(payload.type))
      await this.sessionsRepo.update({ id: session.id, lastSeenAt: LessThan(new Date(Date.now() - 60000)) }, { lastSeenAt: new Date() });
    const authTime = session ? Math.floor(session.createdAt.getTime() / 1000) : undefined;
    if (!user?.isActive) throw new UnauthorizedException('Tài khoản không hoạt động');
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      departmentId: user.department?.id,
      permissions:
        user.permissions ??
        (user.role === UserRole.USER ? DEFAULT_USER_PERMISSIONS : []),
      fileId: payload.fileId,
      tokenType: payload.type,
      sessionId: payload.sid,
      sessionExpiresAt: session?.expiresAt,
      authTime,
    };
  }
}
