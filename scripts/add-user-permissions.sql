-- Add granular permissions for regular users.
-- Run this once when DB_SYNCHRONIZE=false.

SET @permissions_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'permissions'
);

SET @add_permissions_sql := IF(
  @permissions_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `permissions` TEXT NULL',
  'SELECT ''users.permissions already exists'' AS message'
);

PREPARE add_permissions FROM @add_permissions_sql;
EXECUTE add_permissions;
DEALLOCATE PREPARE add_permissions;
