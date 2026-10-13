import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { DepartmentsService } from './departments.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../entities/user.entity';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('departments')
export class DepartmentsController {
  constructor(private service: DepartmentsService) {}

  @Get()
  findAll() {
    // Mọi user đã đăng nhập đều xem được danh sách khoa (để chọn khi upload)
    return this.service.findAll();
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body('name') name: string) {
    return this.service.create(name);
  }
}
