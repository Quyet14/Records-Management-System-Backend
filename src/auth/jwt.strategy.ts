import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { DEFAULT_USER_PERMISSIONS, UserRole, User } from '../entities/user.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService, @InjectRepository(User) private usersRepo: Repository<User>) {
    super({
      // Lấy token từ Authorization header HOẶC query string ?token=xxx
      // (cần cho trường hợp mở link trực tiếp từ Excel/email)
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: Request) => {
          // Query string: /documents/:id/view?token=xxx
          return (req?.query?.token as string) ?? null;
        },
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  // Giá trị trả về ở đây sẽ được gán vào request.user
  async validate(payload: any) {
    const user = await this.usersRepo.findOne({
      where: { id: payload.sub },
      relations: ['department'],
      select: { id: true, email: true, role: true, isActive: true, permissions: true, department: { id: true } },
    });
    if (!user?.isActive) throw new UnauthorizedException('Tài khoản không hoạt động');
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      departmentId: user.department?.id,
      permissions:
        user.permissions ??
        (user.role === UserRole.USER ? DEFAULT_USER_PERMISSIONS : []),
      fileId: payload.fileId,
      tokenType: payload.type,
    };
  }
}
