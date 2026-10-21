import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { finalize } from 'rxjs/operators';
import * as fs from 'fs';
import * as path from 'path';
import { within } from '../common/archive-crypto';

@Injectable()
export class UploadCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest();
    return next.handle().pipe(finalize(() => {
      const staging = path.resolve(process.env.UPLOAD_STAGING_DIR || './storage/staging');
      const files = [req.file, ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat())];
      for (const file of files) if (file?.path && within(staging, file.path) && path.resolve(file.path) !== staging)
        fs.promises.unlink(file.path).catch(() => undefined);
    }));
  }
}
