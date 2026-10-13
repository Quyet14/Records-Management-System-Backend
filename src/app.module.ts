import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import typeormConfig from './config/typeorm.config';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { DepartmentsModule } from './departments/departments.module';
import { DocumentsModule } from './documents/documents.module';
import { TagsModule } from './tags/tags.module';
import { StatsModule } from './stats/stats.module';
import { ExportModule } from './export/export.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SystemModule } from './system/system.module';
import { DocumentTypesModule } from './document-types/document-types.module';
import { RetentionModule } from './retention/retention.module';
import { StorageModule } from './storage/storage.module';
import { ViewRequestsModule } from './view-requests/view-requests.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [typeormConfig] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<TypeOrmModuleOptions>('database')!,
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    AuthModule,
    UsersModule,
    DepartmentsModule,
    DocumentsModule,
    TagsModule,
    StatsModule,
    ExportModule,
    NotificationsModule,
    SystemModule,
    DocumentTypesModule,
    RetentionModule,
    StorageModule,
    ViewRequestsModule,
  ],
})
export class AppModule {}
