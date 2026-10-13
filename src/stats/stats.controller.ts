import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { StatsService } from './stats.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../entities/user.entity';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('stats')
export class StatsController {
  constructor(private service: StatsService) {}

  /** Tổng quan: tổng tài liệu, user, khoa, dung lượng, phân bố trạng thái */
  @Get('overview')
  getOverview() {
    return this.service.getOverview();
  }

  /** Thống kê theo từng khoa */
  @Get('by-department')
  getByDepartment() {
    return this.service.getByDepartment();
  }

  /** Thống kê theo tháng trong năm — ?year=2025 (mặc định: năm hiện tại) */
  @Get('by-year')
  getByYear(@Query('year') year?: string) {
    return this.service.getByYear(year ? parseInt(year, 10) : undefined);
  }

  /** Tăng trưởng dung lượng lưu trữ theo thời gian (tích lũy) */
  @Get('storage-growth')
  getStorageGrowth() {
    return this.service.getStorageGrowth();
  }

  /** Top người dùng upload nhiều nhất — ?limit=10 */
  @Get('top-uploaders')
  getTopUploaders(@Query('limit') limit?: string) {
    return this.service.getTopUploaders(limit ? parseInt(limit, 10) : 10);
  }

  /** Thống kê số lượng tài liệu theo từng loại hồ sơ */
  @Get('by-document-type')
  getByDocumentType() {
    return this.service.getByDocumentType();
  }

  /** Thống kê theo phân loại giá trị (vĩnh viễn / có thời hạn / chưa xác định) */
  @Get('by-classification')
  getByClassification() {
    return this.service.getByClassificationValue();
  }

  /** Tiến độ chỉnh lý tài liệu trước 01/7/2025 + đếm ngược deadline 01/7/2030 */
  @Get('review-progress')
  getReviewProgress() {
    return this.service.getReviewProgress();
  }

  /** Tài liệu sắp hết hạn lưu trữ — ?days=180 */
  @Get('expiring-soon')
  getExpiringSoon(@Query('days') days?: string) {
    return this.service.getExpiringSoon(days ? parseInt(days, 10) : 180);
  }
}
