import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { archiveChecksum, archiveStream, readArchiveBuffer } from '../common/archive-crypto';
import { DocumentsService } from './documents.service';
import { ExportService } from '../export/export.service';
import { IpWhitelistGuard } from '../common/guards/ip-whitelist.guard';
import { multerOptions } from './multer.config';
import { inferMimeType, isPdfFile } from './allowed-file-types';
import { UploadDocumentDto } from './dto/upload-document.dto';
import {
  RejectDocumentDto,
  SearchDocumentDto,
  PendingQueueDto,
} from './dto/review-document.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateMetadataDto } from './dto/update-metadata.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DocumentAccessGuard } from '../common/guards/document-access.guard';
import { UserPermission, UserRole } from '../entities/user.entity';
import { ReviewStatus } from '../entities/document.entity';
import { ConfigService } from '@nestjs/config';
import { authAllowedOrigins } from '../auth/auth-origin.guard';

@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, IpWhitelistGuard)
@Controller('documents')
export class DocumentsController {
  constructor(
    private service: DocumentsService,
    private exportService: ExportService,
  ) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', multerOptions))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
    @CurrentUser() user,
  ) {
    return this.service.upload(file, dto, user);
  }

  /** Upload nhiều file cùng lúc (tối đa 20 file).
   *  Mỗi file xử lý độc lập — file lỗi không chặn file còn lại.
   *  Body: departmentId (tùy chọn), title sẽ lấy từ tên file nếu không truyền.
   */
  @Post('upload-multiple')
  @UseInterceptors(FilesInterceptor('files', 20, multerOptions))
  uploadMultiple(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('departmentId') departmentId: string,
    @CurrentUser() user,
    @Body('securityLevel') securityLevel?: string,
  ) {
    return this.service.uploadMultiple(files, departmentId, user, securityLevel);
  }

  @Get('pending')
  @Permissions(UserPermission.APPROVE_DOCUMENTS)
  pendingQueue(@Query() query: PendingQueueDto, @CurrentUser() user) {
    return this.service.findPendingQueue(user, query);
  }

  @Patch(':id/approve')
  @Permissions(UserPermission.APPROVE_DOCUMENTS)
  approve(@Param('id') id: string, @CurrentUser() user) {
    return this.service.approve(id, user);
  }

  /**
   * PATCH /documents/:id
   * Cập nhật thông tin cơ bản: title, description, departmentId
   */
  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
    @CurrentUser() user,
  ) {
    return this.service.updateDocument(id, dto, user);
  }
  @Patch(':id/reject')
  @Permissions(UserPermission.APPROVE_DOCUMENTS)
  reject(
    @Param('id') id: string,
    @Body() dto: RejectDocumentDto,
    @CurrentUser() user,
  ) {
    return this.service.reject(id, user, dto.reason);
  }

  /**
   * PATCH /documents/:id/metadata
   * Admin gán loại hồ sơ, phân loại giá trị, ngày hình thành.
   * Nếu tài liệu đã STORED, hạn lưu trữ sẽ được tính lại tự động.
   */
  @Patch(':id/metadata')
  @Roles(UserRole.ADMIN)
  updateMetadata(
    @Param('id') id: string,
    @Body() dto: UpdateMetadataDto,
    @CurrentUser() user,
  ) {
    return this.service.updateMetadata(id, dto, user);
  }

  @Get('search')
  search(@Query() query: SearchDocumentDto, @CurrentUser() user) {
    // Phân quyền (user chỉ thấy file của mình, admin thấy tất cả) được xử lý trong service
    return this.service.search(query, user);
  }

  /**
   * GET /documents — alias cho /documents/search
   * Tương thích với frontend gọi GET /documents?visibility=private&...
   */
  @Get()
  searchAlias(@Query() query: SearchDocumentDto, @CurrentUser() user) {
    return this.service.search(query, user);
  }

  /**
   * GET /documents/my-storage
   * Tài liệu riêng tư (visibility=private) của user đang đăng nhập.
   * Dùng cho trang "Kho lưu trữ cá nhân".
   */
  @Get('my-storage')
  getMyStorage(
    @Query('page') page: string,
    @Query('limit') limit: string,
    @CurrentUser() user,
  ) {
    return this.service.getMyStorage(user, {
      page:  page  ? parseInt(page,  10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }
  @Get('archive/years')
  getArchiveYears(@CurrentUser() user) {
    return this.service.getArchiveYears(user);
  }

  @Get('archive/years/:year/dates')
  getArchiveDates(@Param('year') year: string, @CurrentUser() user) {
    return this.service.getArchiveDates(year, user);
  }

  @Get('archive/years/:year/dates/:date/files')
  getArchiveFiles(
    @Param('year') year: string,
    @Param('date') date: string,
    @CurrentUser() user,
  ) {
    return this.service.getArchiveFiles(year, date, user);
  }

  // ─── EXPORT (alias cho /export/excel và /export/pdf) ───────
  /** GET /documents/export hoặc /documents/export/excel */
  @Get('export')
  @Get('export/excel')
  async exportExcel(
    @Query() filter: any,
    @CurrentUser() user,
    @Res() res: Response,
  ) {
    const buffer = await this.exportService.exportExcel(filter, user);
    const filename = `documents_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  /** GET /documents/export/pdf */
  @Get('export/pdf')
  async exportPdf(
    @Query() filter: any,
    @CurrentUser() user,
    @Res() res: Response,
  ) {
    const buffer = await this.exportService.exportPdf(filter, user);
    const filename = `documents_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  /** POST /documents/:id/mark-reviewed — đánh dấu đã hoàn thành chỉnh lý */
  @Post(':id/mark-reviewed')
  @Roles(UserRole.ADMIN)
  markReviewed(@Param('id') id: string, @CurrentUser() user) {
    return this.service.updateMetadata(id, { reviewStatus: ReviewStatus.COMPLETED }, user);
  }

  /** GET /documents/:id/download-url — cấp URL tải file tạm thời */
  @Get(':id/download-url')
  createDownloadUrl(@Param('id') id: string, @CurrentUser() user) {
    return this.service.createDownloadUrl(id, user);
  }

  @Get(':id/view-url')
  @UseGuards(DocumentAccessGuard)
  createViewUrl(@CurrentUser() user, @Req() req, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.createViewUrl(req.documentForView, user, req.viewAccessExpiresAt);
  }

  /** GET /documents/:id/download — tải file gốc */
  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @CurrentUser() user,
    @Res() res: Response,
  ) {
    const doc = await this.service.getFileForDownload(id, user);
    const mimeType = doc.file?.mimeType ?? inferMimeType(doc.originalFilename);
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const filename = doc.originalFilename;
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    await archiveChecksum(doc.storagePath, doc.sha256Checksum);
    const stream = archiveStream(doc.storagePath, doc.sha256Checksum);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  /** GET /documents/:id/view — xem file gốc */
  @Get(':id/view')
  @UseGuards(DocumentAccessGuard)
  async view(
    @Param('id') id: string,
    @CurrentUser() user,
    @Req() req,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.service.getFileForView(req.documentForView, user);
    const frameOrigins = authAllowedOrigins(new ConfigService());
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', `default-src 'none'; frame-ancestors 'self' ${frameOrigins.join(' ')}; base-uri 'none'; form-action 'none'`);
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `${isPdfFile(file.filename, file.mimeType) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.filename)}"`,
    );
    if (isPdfFile(file.filename, file.mimeType)) {
      return new StreamableFile(await readArchiveBuffer(file.path, file.checksum));
    }
    await archiveChecksum(file.path, file.checksum);
    return new StreamableFile(archiveStream(file.path, file.checksum));
  }

  // ─── COMMENTS ──────────────────────────────────────────────

  /** Thêm ghi chú nội bộ vào tài liệu */
  @Post(':id/comments')
  addComment(
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user,
  ) {
    return this.service.addComment(id, dto.content, user);
  }

  /** Lấy danh sách ghi chú của tài liệu */
  @Get(':id/comments')
  getComments(@Param('id') id: string, @CurrentUser() user) {
    return this.service.getComments(id, user);
  }

  /** Full metadata; file viewing/downloading retains its separate access checks. */
  @Get(':id')
  getDetail(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user) {
    return this.service.getDetail(id, user);
  }

  /** Xóa ghi chú (chỉ tác giả hoặc Admin) */
  @Delete(':id/comments/:commentId')
  deleteComment(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @CurrentUser() user,
  ) {
    return this.service.deleteComment(id, commentId, user);
  }
}
