import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from '../entities/document.entity';
import { AuditLog } from '../entities/audit-log.entity';
import { User } from '../entities/user.entity';
import { DocumentComment } from '../entities/document-comment.entity';
import { StoredFile } from '../entities/stored-file.entity';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { ExportService } from '../export/export.service';
import { RetentionModule } from '../retention/retention.module';
import { WatermarkService } from '../common/watermark/watermark.service';
import { AuthModule } from '../auth/auth.module';
import { ViewRequest } from '../entities/view-request.entity';
import { AccessLog } from '../entities/access-log.entity';
import { DocumentAccessGuard } from '../common/guards/document-access.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Document, StoredFile, AuditLog, User, DocumentComment, ViewRequest, AccessLog]),
    AuthModule,
    RetentionModule,
  ],
  providers: [DocumentsService, ExportService, WatermarkService, DocumentAccessGuard],
  controllers: [DocumentsController],
})
export class DocumentsModule {}
