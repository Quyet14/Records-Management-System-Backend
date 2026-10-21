import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

export function authAllowedOrigins(config: ConfigService): string[] {
  return (config.get<string>('CORS_ORIGINS') || 'http://localhost:5000,http://127.0.0.1:5000')
    .split(',').map(value => value.trim()).filter(Boolean).map(value => {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
        throw Error('CORS_ORIGINS must contain exact http(s) origins, without paths or wildcards.');
      return url.origin;
    });
}

@Injectable()
export class AuthOriginGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    const origin = req.get('origin');
    const sameOrigin = `${req.protocol}://${req.get('host')}`;
    if ((origin && origin !== sameOrigin && !authAllowedOrigins(this.config).includes(origin))
      || (!origin && req.get('sec-fetch-site') === 'cross-site'))
      throw new ForbiddenException('Nguồn gửi yêu cầu xác thực không được phép.');
    return true;
  }
}
