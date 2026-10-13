import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
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
import { createReadStream } from 'fs';
import { DocumentsService } from './documents.service';
import { ExportService } from '../export/export.service';
import { WatermarkService } from '../common/watermark/watermark.service';
import { IpWhitelistGuard } from '../common/guards/ip-whitelist.guard';
import { multerOptions } from './multer.config';
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
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DocumentAccessGuard } from '../common/guards/document-access.guard';
import { UserRole } from '../entities/user.entity';
import { ReviewStatus } from '../entities/document.entity';

@UseGuards(JwtAuthGuard, RolesGuard, IpWhitelistGuard)
@Controller('documents')
export class DocumentsController {
  constructor(
    private service: DocumentsService,
    private exportService: ExportService,
    private watermarkService: WatermarkService,
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
  ) {
    return this.service.uploadMultiple(files, departmentId, user);
  }

  @Get('pending')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  pendingQueue(@Query() query: PendingQueueDto, @CurrentUser() user) {
    return this.service.findPendingQueue(user, query);
  }

  @Patch(':id/approve')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
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
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
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

  /** GET /documents/:id/download — tải file gốc; thêm watermark=true nếu cần */
  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @CurrentUser() user,
    @Query('watermark') watermark: string,
    @Res() res: Response,
  ) {
    const doc = await this.service.getFileForDownload(id, user);
    const pdfBuffer = watermark === 'true'
      ? await this.watermarkService.applyWatermark(doc.storagePath, {
          userName: user.fullName ?? user.email ?? user.id,
          userEmail: user.email ?? '',
        })
      : this.watermarkService.readOriginal(doc.storagePath);
    const filename = doc.originalFilename.endsWith('.pdf')
      ? doc.originalFilename
      : `${doc.originalFilename}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  }

  /** GET /documents/:id/view — xem file gốc; thêm watermark=true nếu cần */
  @Get(':id/view')
  @UseGuards(DocumentAccessGuard)
  async view(
    @Param('id') id: string,
    @CurrentUser() user,
    @Req() req,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.service.getFileForView(req.documentForView, user);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(file.filename)}"`,
    );
    return new StreamableFile(createReadStream(file.path));
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
