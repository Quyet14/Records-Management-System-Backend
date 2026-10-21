import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from '../entities/document.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { OtpCode } from '../entities/otp-code.entity';
import { AuditLog } from '../entities/audit-log.entity';
import { SystemService } from './system.service';
import { SystemController } from './system.controller';
import { DestructionModule } from '../destruction/destruction.module';

@Module({
  imports: [TypeOrmModule.forFeature([Document, RefreshToken, OtpCode, AuditLog]), DestructionModule],
  providers: [SystemService],
  controllers: [SystemController],
})
export class SystemModule {}
