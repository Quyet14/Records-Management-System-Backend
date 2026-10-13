-- StoredFile schema for production deployment.
-- Run against the application's database after taking a backup.
-- This script is intentionally limited to `files` and `documents.file_id`.

CREATE TABLE IF NOT EXISTS `files` (
  `id` VARCHAR(36) NOT NULL,
  `file_hash` VARCHAR(64) NOT NULL,
  `storage_key` VARCHAR(1000) NOT NULL,
  `size` BIGINT NOT NULL,
  `mime_type` VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQ_files_file_hash` (`file_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @file_id_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'file_id'
);

SET @add_file_id_sql := IF(
  @file_id_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `file_id` VARCHAR(36) NULL',
  'SELECT 1'
);

PREPARE add_file_id FROM @add_file_id_sql;
EXECUTE add_file_id;
DEALLOCATE PREPARE add_file_id;

SET @file_fk_exists := (
  SELECT COUNT(*)
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'file_id'
    AND REFERENCED_TABLE_NAME = 'files'
    AND REFERENCED_COLUMN_NAME = 'id'
);

SET @add_file_fk_sql := IF(
  @file_fk_exists = 0,
  'ALTER TABLE `documents` ADD CONSTRAINT `FK_documents_file_id` FOREIGN KEY (`file_id`) REFERENCES `files` (`id`)',
  'SELECT 1'
);

PREPARE add_file_fk FROM @add_file_fk_sql;
EXECUTE add_file_fk;
DEALLOCATE PREPARE add_file_fk;

CREATE TABLE IF NOT EXISTS `login_confirmations` (
  `id` VARCHAR(36) NOT NULL,
  `user_id` VARCHAR(36) NOT NULL,
  `token_hash` VARCHAR(64) NOT NULL,
  `is_confirmed` TINYINT(1) NOT NULL DEFAULT 0,
  `is_consumed` TINYINT(1) NOT NULL DEFAULT 0,
  `ip_address` VARCHAR(64) NULL,
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQ_login_confirmations_token_hash` (`token_hash`),
  KEY `IDX_login_confirmations_user_id` (`user_id`),
  CONSTRAINT `FK_login_confirmations_user_id`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `password_reset_tokens` (
  `id` VARCHAR(36) NOT NULL,
  `user_id` VARCHAR(36) NOT NULL,
  `token_hash` VARCHAR(64) NOT NULL,
  `is_used` TINYINT(1) NOT NULL DEFAULT 0,
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQ_password_reset_tokens_token_hash` (`token_hash`),
  KEY `IDX_password_reset_tokens_user_id` (`user_id`),
  CONSTRAINT `FK_password_reset_tokens_user_id`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @must_change_password_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'must_change_password'
);

SET @add_must_change_password_sql := IF(
  @must_change_password_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `must_change_password` TINYINT(1) NOT NULL DEFAULT 0',
  'SELECT 1'
);

PREPARE add_must_change_password FROM @add_must_change_password_sql;
EXECUTE add_must_change_password;
DEALLOCATE PREPARE add_must_change_password;

SET @otp_purpose_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'otp_codes'
    AND COLUMN_NAME = 'purpose'
);

SET @add_otp_purpose_sql := IF(
  @otp_purpose_exists = 0,
  'ALTER TABLE `otp_codes` ADD COLUMN `purpose` VARCHAR(30) NOT NULL DEFAULT ''login''',
  'SELECT 1'
);

PREPARE add_otp_purpose FROM @add_otp_purpose_sql;
EXECUTE add_otp_purpose;
DEALLOCATE PREPARE add_otp_purpose;

SET @otp_attempts_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'otp_codes'
    AND COLUMN_NAME = 'attempts'
);

SET @add_otp_attempts_sql := IF(
  @otp_attempts_exists = 0,
  'ALTER TABLE `otp_codes` ADD COLUMN `attempts` INT NOT NULL DEFAULT 0',
  'SELECT 1'
);

PREPARE add_otp_attempts FROM @add_otp_attempts_sql;
EXECUTE add_otp_attempts;
DEALLOCATE PREPARE add_otp_attempts;

-- Verification:
-- SHOW CREATE TABLE `files`;
-- SHOW CREATE TABLE `documents`;
-- SHOW CREATE TABLE `login_confirmations`;
