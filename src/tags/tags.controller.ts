import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TagsService } from './tags.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../entities/user.entity';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tags')
export class TagsController {
  constructor(private service: TagsService) {}

  /** Lấy danh sách tất cả tags — mọi user đã đăng nhập */
  @Get()
  findAll() {
    return this.service.findAll();
  }

  /** Tạo tag mới — chỉ Admin */
  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateTagDto) {
    return this.service.create(dto);
  }

  /** Xoá tag — chỉ Admin */
  @Delete(':id')
  @Roles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  /** Tìm tài liệu theo tag name (query: ?name=...) */
  @Get('search')
  findDocsByTagName(@Query('name') name: string, @CurrentUser() user) {
    return this.service.findDocumentsByTagName(name, user);
  }

  /** Tìm tài liệu theo tag ID */
  @Get(':id/documents')
  findDocsByTag(@Param('id') id: string, @CurrentUser() user) {
    return this.service.findDocumentsByTag(id, user);
  }

  /** Gắn tag vào tài liệu — Admin, DeptHead */
  @Post(':tagId/documents/:docId')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  addTag(
    @Param('docId') docId: string,
    @Param('tagId') tagId: string,
    @CurrentUser() user,
  ) {
    return this.service.addTagToDocument(docId, tagId, user);
  }

  /** Gỡ tag khỏi tài liệu — Admin, DeptHead */
  @Delete(':tagId/documents/:docId')
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  removeTag(
    @Param('docId') docId: string,
    @Param('tagId') tagId: string,
    @CurrentUser() user,
  ) {
    return this.service.removeTagFromDocument(docId, tagId, user);
  }
}
