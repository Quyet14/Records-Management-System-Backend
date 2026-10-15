import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  Res,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, fromEvent } from 'rxjs';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private service: NotificationsService) {}

  /** Danh sách thông báo của tôi — ?unread=true để lọc chưa đọc */
  @Get()
  getMyNotifications(
    @CurrentUser() user,
    @Query('unread') unread?: string,
  ) {
    return this.service.getMyNotifications(user, unread === 'true');
  }

  /** Số thông báo chưa đọc */
  @Get('unread-count')
  async getUnreadCount(@CurrentUser() user) {
    const count = await this.service.countUnread(user);
    return { count };
  }

  /** Đánh dấu đã đọc một thông báo */
  @Patch(':id/read')
  markRead(@Param('id') id: string, @CurrentUser() user) {
    return this.service.markRead(id, user.id);
  }

  /** Đánh dấu tất cả đã đọc */
  @Patch('read-all')
  markAllRead(@CurrentUser() user) {
    return this.service.markAllRead(user.id);
  }

  /**
   * SSE endpoint — client kết nối một lần và nhận push events real-time
   * GET /notifications/stream
   */
  @Sse('stream')
  stream(@CurrentUser() user, @Req() req: Request): Observable<MessageEvent> {
    const subject = this.service.getStream(user.id);

    // Dọn dẹp khi client disconnect
    req.on('close', () => this.service.removeStream(user.id));

    return subject.asObservable();
  }
}
