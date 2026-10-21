import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { User } from '../entities/user.entity';
import { Department } from '../entities/department.entity';
import { Document } from '../entities/document.entity';
import { DocumentVersion } from '../entities/document-version.entity';
import { AuditLog } from '../entities/audit-log.entity';
import { Tag } from '../entities/tag.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { Notification } from '../entities/notification.entity';
import { DocumentComment } from '../entities/document-comment.entity';
import { DocumentType } from '../entities/document-type.entity';
import { OtpCode } from '../entities/otp-code.entity';
import { PersonalFile } from '../entities/personal-file.entity';
import { StoredFile } from '../entities/stored-file.entity';
import { LoginConfirmation } from '../entities/login-confirmation.entity';
import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { ViewRequest } from '../entities/view-request.entity';
import { AccessLog } from '../entities/access-log.entity';
import { destructionEntities } from '../entities/destruction.entity';
import { AuthSession } from '../entities/auth-session.entity';
import { AuthCaptcha } from '../entities/auth-captcha.entity';
import { AuditContextSubscriber } from '../security/request-audit';

export default registerAs(
  'database',
  (): TypeOrmModuleOptions => ({
    type: 'mysql',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    username: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'pdf_archive',
    charset: 'utf8mb4',
    extra: {
      connectionLimit: parseInt(process.env.DB_POOL_SIZE || '15', 10),
      waitForConnections: true,
      queueLimit: 0,
    },
    timezone: 'Z',
    entities: [User, Department, Document, DocumentVersion, AuditLog, Tag, RefreshToken, AuthSession, AuthCaptcha, Notification, DocumentComment, DocumentType, OtpCode, PersonalFile, StoredFile, LoginConfirmation, PasswordResetToken, ViewRequest, AccessLog, ...destructionEntities],
    subscribers: [AuditContextSubscriber],
    // Không tự thay đổi schema trên server; dùng migration hoặc SQL riêng để cập nhật database.
    synchronize: process.env.DB_SYNCHRONIZE === 'true',
    // Queries may contain evidence PDF bytes and OTP verifier data. Never log SQL parameters.
    logging: false,
  }),
);
