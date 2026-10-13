import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from '../entities/document.entity';
import { User } from '../entities/user.entity';
import { Department } from '../entities/department.entity';
import { DocumentType } from '../entities/document-type.entity';
import { StatsService } from './stats.service';
import { StatsController } from './stats.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Document, User, Department, DocumentType])],
  providers: [StatsService],
  controllers: [StatsController],
})
export class StatsModule {}
