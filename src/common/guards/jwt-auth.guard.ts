import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = any>(error: any, user: any, info: any, context: ExecutionContext, status?: any): TUser {
    const actor = super.handleRequest<TUser>(error, user, info, context, status);
    if (['file-download', 'file-view'].includes((actor as any).tokenType)) {
      const req = context.switchToHttp().getRequest();
      const purpose = (actor as any).tokenType === 'file-view' ? 'view' : 'download';
      if (!['GET', 'HEAD'].includes(req.method) || req.params?.id !== (actor as any).fileId
        || typeof req.route?.path !== 'string' || !new RegExp(`(?:^|/)documents/:id/${purpose}/?$`).test(req.route.path))
        throw new UnauthorizedException('Token tải file không được dùng làm phiên đăng nhập.');
    }
    return actor;
  }
}
