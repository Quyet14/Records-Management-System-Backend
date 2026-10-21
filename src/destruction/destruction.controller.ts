import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res, UploadedFiles, UseGuards, UseInterceptors, Header,
  Injectable, CanActivate, ExecutionContext, Catch, ExceptionFilter, ArgumentsHost, HttpException, UseFilters } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DestructionService } from './destruction.service';
import { fail, MAX_PDF_BYTES } from './destruction.rules';
import { pdfContentDisposition } from '../common/upload-filename';

@Injectable()
export class DestructionBearerGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (!/^Bearer\s+\S+$/i.test(req.headers.authorization ?? '') || ['file-download', 'file-view'].includes(req.user?.tokenType))
      fail(401, 'UNAUTHORIZED', 'Cần đăng nhập bằng phiên hợp lệ.');
    return true;
  }
}
@Catch()
export class DestructionExceptionFilter implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const body: any = error instanceof HttpException ? error.getResponse() : null;
    response.status(status).set('Cache-Control', 'no-store').json({ code: body?.code ?? (status === 413 ? 'PDF_TOO_LARGE' : 'DESTRUCTION_ERROR'),
      message: body?.code ? body.message : status === 413 ? 'Chứng từ vượt dung lượng cho phép.' : 'Không thể thực hiện thao tác hủy hồ sơ. Vui lòng kiểm tra lại.' });
  }
}
const upload = (fields: { name: string; maxCount: number }[]) => FileFieldsInterceptor(fields, {
  storage: memoryStorage(), limits: { fileSize: MAX_PDF_BYTES, files: 2, fields: 10, fieldSize: 65536, parts: 12 },
});

@Controller('destruction')
@UseGuards(JwtAuthGuard, DestructionBearerGuard)
@UseFilters(DestructionExceptionFilter)
export class DestructionController {
  constructor(private readonly service: DestructionService) {}
  @Get('capabilities') @Header('Cache-Control', 'no-store')
  capabilities(@Req() req: any) { return this.service.capabilities(req.user); }
  @Get('eligible-documents') @Header('Cache-Control', 'no-store')
  eligible(@Query() query: any, @Req() req: any) { return this.service.eligibleDocuments(query, req.user); }
  @Get('destroyed-documents') @Header('Cache-Control', 'no-store')
  destroyed(@Query() query: any, @Req() req: any) { return this.service.destroyedDocuments(query, req.user); }
  @Get('requests') @Header('Cache-Control', 'no-store')
  list(@Query() query: any, @Req() req: any) { return this.service.list(query, req.user); }
  @Get('requests/:id') @Header('Cache-Control', 'no-store')
  detail(@Param('id') id: string, @Req() req: any) { return this.service.detail(id, req.user); }
  @Post('requests') @Header('Cache-Control', 'no-store')
  @UseInterceptors(upload([{ name: 'decisionFile', maxCount: 1 }, { name: 'councilMinutesFile', maxCount: 1 }]))
  create(@Body() body: any, @UploadedFiles() files: any, @Req() req: any, @Headers('idempotency-key') key?: string) {
    return this.service.create(body, files, req.user, key);
  }
  @Get('requests/:id/attachments/:attachmentId/content')
  async content(@Param('id') id: string, @Param('attachmentId') attachmentId: string, @Req() req: any, @Res() res: Response) {
    const file = await this.service.content(id, attachmentId, req.user);
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/pdf', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': pdfContentDisposition(file.filename) }).send(file.bytes);
  }
  @Post('requests/:id/otp-challenges') @Header('Cache-Control', 'no-store')
  challenge(@Param('id') id: string, @Body() body: any, @Req() req: any, @Headers('if-match') version?: string) {
    return this.service.challenge(id, body, version, req.user);
  }
  @Post('requests/:id/approve') @Header('Cache-Control', 'no-store')
  approve(@Param('id') id: string, @Body() body: any, @Req() req: any, @Headers('if-match') version?: string, @Headers('idempotency-key') key?: string) {
    return this.service.approve(id, body, version, key, req.user);
  }
  @Post('requests/:id/reject') @Header('Cache-Control', 'no-store')
  reject(@Param('id') id: string, @Body() body: any, @Req() req: any, @Headers('if-match') version?: string, @Headers('idempotency-key') key?: string) {
    return this.service.transition(id, 'reject', body, version, key, req.user);
  }
  @Post('requests/:id/withdraw') @Header('Cache-Control', 'no-store')
  withdraw(@Param('id') id: string, @Body() body: any, @Req() req: any, @Headers('if-match') version?: string, @Headers('idempotency-key') key?: string) {
    return this.service.transition(id, 'withdraw', body, version, key, req.user);
  }
  @Post('requests/:id/complete') @Header('Cache-Control', 'no-store')
  @UseInterceptors(upload([{ name: 'destructionMinutesFile', maxCount: 1 }]))
  complete(@Param('id') id: string, @Body() body: any, @UploadedFiles() files: any, @Req() req: any,
    @Headers('if-match') version?: string, @Headers('idempotency-key') key?: string) {
    return this.service.complete(id, body, files, version, key, req.user);
  }
}
