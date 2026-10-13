import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessLog } from '../entities/access-log.entity';
import { Document } from '../entities/document.entity';
import { User } from '../entities/user.entity';
import { ViewRequest } from '../entities/view-request.entity';
import { AuthModule } from '../auth/auth.module';
import { ViewRequestsController } from './view-requests.controller';
import { ViewRequestsService } from './view-requests.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ViewRequest, Document, User, AccessLog]),
    AuthModule,
  ],
  controllers: [ViewRequestsController],
  providers: [ViewRequestsService],
})
export class ViewRequestsModule {}
