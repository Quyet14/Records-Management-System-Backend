import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
  Body,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../entities/user.entity';
import { RetentionService } from './retention.service';
import { ReviewStatus } from '../entities/document.entity';
import { IsBoolean, IsEnum } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ReportActor, reportDepartment } from '../common/report-scope';

class UpdateReviewStatusDto {
  @IsEnum(ReviewStatus)
  reviewStatus: ReviewStatus;
}
class LegalHoldDto {
  @IsBoolean()
  legalHold: boolean;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('retention')
export class RetentionController {
  constructor(private service: RetentionService) {}

  @Patch('documents/:id/legal-hold')
  legalHold(@Param('id') id: string, @Body() body: LegalHoldDto, @CurrentUser() actor: { id: string }) {
    return this.service.setLegalHold(id, body.legalHold, actor.id);
  }

  /**
   * GET /retention/expiring?days=180
   * Danh sách tài liệu sắp hết hạn lưu trữ
   */
  @Get('expiring')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  getExpiring(@CurrentUser() actor: ReportActor, @Query('days') days?: string) {
    return this.service.getExpiringDocuments(days ? Number(days) : undefined, reportDepartment(actor));
  }

  /**
   * GET /retention/pending-review?page=1&limit=20
   * Danh sách tài liệu trước 01/7/2025 chưa hoàn thành chỉnh lý
   */
  @Get('pending-review')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  getPendingReview(
    @CurrentUser() actor: ReportActor,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getPendingReviewDocuments(
      page ? Number(page) : 1,
      limit ? Number(limit) : 20,
      reportDepartment(actor),
    );
  }

  /**
   * GET /retention/review-summary
   * Tóm tắt tiến độ chỉnh lý + đếm ngược đến 01/7/2030
   */
  @Get('review-summary')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  getReviewSummary(@CurrentUser() actor: ReportActor) {
    return this.service.getReviewSummary(reportDepartment(actor));
  }

  /**
   * PATCH /retention/documents/:id/review-status
   * Cập nhật trạng thái chỉnh lý cho tài liệu
   */
  @Patch('documents/:id/review-status')
  updateReviewStatus(
    @Param('id') id: string,
    @Body() dto: UpdateReviewStatusDto,
  ) {
    return this.service.updateReviewStatus(id, dto.reviewStatus);
  }
}
