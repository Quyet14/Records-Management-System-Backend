import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from '../entities/document.entity';
import { RetentionService } from './retention.service';
import { RetentionController } from './retention.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Document])],
  providers: [RetentionService],
  controllers: [RetentionController],
  exports: [RetentionService],
})
export class RetentionModule {}
