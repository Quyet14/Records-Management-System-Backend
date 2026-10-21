import { ConfigService } from '@nestjs/config';
import { CookieOptions, Request, Response } from 'express';

export const REFRESH_COOKIE = 'lths_refresh';
export function refreshCookieOptions(config: ConfigService): CookieOptions {
  const secure = config.get('AUTH_COOKIE_SECURE') !== 'false';
  if (config.get('NODE_ENV') === 'production' && !secure) throw Error('Production refresh cookies require HTTPS and Secure=true.');
  const sameSite = config.get<string>('AUTH_COOKIE_SAME_SITE') || 'lax';
  if (!['lax', 'strict', 'none'].includes(sameSite) || (sameSite === 'none' && !secure))
    throw Error('Invalid auth cookie settings: SameSite=None requires Secure=true.');
  return { httpOnly: true, secure, sameSite: sameSite as 'lax' | 'strict' | 'none', path: '/auth' };
}
export function readRefreshCookie(req: Request): string | undefined {
  const values = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${REFRESH_COOKIE}=`));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(REFRESH_COOKIE.length + 1);
  return /^[a-f0-9]{80}$/i.test(value) ? value : undefined;
}
export function clearRefreshCookie(res: Response, config: ConfigService): void {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(config));
}
