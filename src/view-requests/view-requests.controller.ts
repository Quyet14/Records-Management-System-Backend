import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole } from '../entities/user.entity';
import { ApproveViewRequestDto } from './dto/approve-view-request.dto';
import { CreateViewRequestDto } from './dto/create-view-request.dto';
import { QueryViewRequestsDto } from './dto/query-view-requests.dto';
import { RejectViewRequestDto } from './dto/reject-view-request.dto';
import { ViewRequestsService } from './view-requests.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class ViewRequestsController {
  constructor(private readonly service: ViewRequestsService) {}

  @Post('documents/:id/view-requests')
  create(
    @Param('id') documentId: string,
    @Body() dto: CreateViewRequestDto,
    @CurrentUser() user,
  ) {
    return this.service.create(documentId, dto, user);
  }

  @Post('view-requests/:id/extend')
  extend(
    @Param('id') id: string,
    @Body() dto: CreateViewRequestDto,
    @CurrentUser() user,
  ) {
    return this.service.extend(id, dto, user);
  }

  @Get('documents/:id/view-status')
  getViewStatus(@Param('id') documentId: string, @CurrentUser() user) {
    return this.service.getViewStatus(documentId, user);
  }

  @Get('view-requests')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  findAll(@Query() query: QueryViewRequestsDto, @CurrentUser() user) {
    return this.service.findAll(query, user);
  }

  @Patch('view-requests/:id/approve')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveViewRequestDto,
    @CurrentUser() user,
  ) {
    return this.service.approve(id, dto, user);
  }

  @Patch('view-requests/:id/reject')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  reject(
    @Param('id') id: string,
    @Body() dto: RejectViewRequestDto,
    @CurrentUser() user,
  ) {
    return this.service.reject(id, dto.decisionNote, user);
  }
}
