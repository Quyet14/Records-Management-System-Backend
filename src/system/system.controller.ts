import {
  Controller, Get, Post, Query, UseGuards,
} from '@nestjs/common';
import { SystemService } from './system.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ReportActor, reportDepartment } from '../common/report-scope';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('system')
export class SystemController {
  constructor(private service: SystemService) {}

  /**
   * GET /system/health — Public (không cần auth) — trả status API, DB, Storage
   * Dùng cho monitoring / load balancer health check
   */
  @Get('health')
  getHealth() {
    return this.service.getHealth();
  }

  /** Tổng quan hệ thống: dung lượng, số file, uptime */
  @Get('status')
  getStatus() {
    return this.service.getSystemStatus();
  }

  /** Kiểm tra checksum toàn bộ tài liệu đã lưu trữ */
  @Get('verify-checksums')
  verifyChecksums() {
    return this.service.verifyChecksums();
  }

  /** Kích hoạt backup thủ công */
  @Post('backup')
  runBackup() {
    return this.service.runBackup();
  }

  /** Kiểm thử khôi phục từ backup mới nhất */
  @Post('restore-test')
  testRestore() {
    return this.service.testRestore();
  }

  /**
   * GET /system/audit-logs — Lịch sử hành động
   * ?action=approve&userId=...&documentId=...&page=1&limit=20
   */
  @Get('audit-logs')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  getAuditLogs(
    @CurrentUser() actor: ReportActor,
    @Query('action')     action?: string,
    @Query('userId')     userId?: string,
    @Query('documentId') documentId?: string,
    @Query('page')       page?: string,
    @Query('limit')      limit?: string,
  ) {
    return this.service.getAuditLogs({
      action,
      userId,
      documentId,
      page:  page  ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    }, reportDepartment(actor));
  }

  /** Read metadata only; does not scan server files or expose physical storage paths. */
  @Get('missing-checksums')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  getMissingChecksums(@CurrentUser() actor: ReportActor, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.service.getMissingChecksums(page ? Number(page) : 1, limit ? Number(limit) : 20, reportDepartment(actor));
  }
}
