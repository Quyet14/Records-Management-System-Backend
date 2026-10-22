import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { StatsService } from './stats.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../entities/user.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ReportActor, reportDepartment } from '../common/report-scope';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
@Controller('stats')
export class StatsController {
  constructor(private service: StatsService) {}

  /** Tổng quan: tổng tài liệu, user, khoa, dung lượng, phân bố trạng thái */
  @Get('overview')
  getOverview(@CurrentUser() actor: ReportActor) {
    return this.service.getOverview(reportDepartment(actor));
  }

  /** Thống kê theo từng khoa */
  @Get('by-department')
  getByDepartment(@CurrentUser() actor: ReportActor) {
    return this.service.getByDepartment(reportDepartment(actor));
  }

  /** Thống kê theo tháng trong năm — ?year=2025 (mặc định: năm hiện tại) */
  @Get('by-year')
  getByYear(@CurrentUser() actor: ReportActor, @Query('year') year?: string) {
    return this.service.getByYear(year ? Number(year) : undefined, reportDepartment(actor));
  }

  /** Tăng trưởng dung lượng lưu trữ theo thời gian (tích lũy) */
  @Get('storage-growth')
  getStorageGrowth(@CurrentUser() actor: ReportActor) {
    return this.service.getStorageGrowth(reportDepartment(actor));
  }

  /** Top người dùng upload nhiều nhất — ?limit=10 */
  @Get('top-uploaders')
  getTopUploaders(@CurrentUser() actor: ReportActor, @Query('limit') limit?: string) {
    return this.service.getTopUploaders(limit ? Number(limit) : 10, reportDepartment(actor));
  }

  /** Thống kê số lượng tài liệu theo từng loại hồ sơ */
  @Get('by-document-type')
  getByDocumentType(@CurrentUser() actor: ReportActor) {
    return this.service.getByDocumentType(reportDepartment(actor));
  }

  /** Thống kê theo phân loại giá trị (vĩnh viễn / có thời hạn / chưa xác định) */
  @Get('by-classification')
  getByClassification(@CurrentUser() actor: ReportActor) {
    return this.service.getByClassificationValue(reportDepartment(actor));
  }

  /** Tiến độ chỉnh lý tài liệu trước 01/7/2025 + đếm ngược deadline 01/7/2030 */
  @Get('review-progress')
  getReviewProgress(@CurrentUser() actor: ReportActor) {
    return this.service.getReviewProgress(reportDepartment(actor));
  }

  /** Tài liệu sắp hết hạn lưu trữ — ?days=180 */
  @Get('expiring-soon')
  getExpiringSoon(@CurrentUser() actor: ReportActor, @Query('days') days?: string) {
    return this.service.getExpiringSoon(days ? Number(days) : 180, reportDepartment(actor));
  }
}
