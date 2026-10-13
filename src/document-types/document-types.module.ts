import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentType } from '../entities/document-type.entity';
import { DocumentTypesService } from './document-types.service';
import { DocumentTypesController } from './document-types.controller';

@Module({
  imports: [TypeOrmModule.forFeature([DocumentType])],
  providers: [DocumentTypesService],
  controllers: [DocumentTypesController],
  exports: [DocumentTypesService],
})
export class DocumentTypesModule {}
