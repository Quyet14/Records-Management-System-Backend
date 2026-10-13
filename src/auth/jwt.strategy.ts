import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
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
    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      departmentId: payload.departmentId,
      fileId: payload.fileId,
      tokenType: payload.type,
    };
  }
}
