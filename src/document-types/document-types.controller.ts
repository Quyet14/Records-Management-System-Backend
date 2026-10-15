import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../entities/user.entity';
import { DocumentTypesService } from './document-types.service';
import { CreateDocumentTypeDto } from './dto/create-document-type.dto';
import { UpdateDocumentTypeDto } from './dto/update-document-type.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('document-types')
export class DocumentTypesController {
  constructor(private service: DocumentTypesService) {}

  /** Tất cả roles đều có thể xem danh mục (để chọn khi upload) */
  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  /** Admin và Trưởng khoa được tạo; sửa/xóa loại hồ sơ chỉ dành cho Admin */
  @Post()
  @Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
  create(@Body() dto: CreateDocumentTypeDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateDocumentTypeDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
