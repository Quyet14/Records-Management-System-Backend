-- Add missing document metadata columns for newer upload forms.
-- Run this once when DB_SYNCHRONIZE=false.

SET @summary_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'summary'
);

SET @add_summary_sql := IF(
  @summary_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `summary` TEXT NULL',
  'SELECT ''documents.summary already exists'' AS message'
);

PREPARE add_summary FROM @add_summary_sql;
EXECUTE add_summary;
DEALLOCATE PREPARE add_summary;

SET @reference_no_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'reference_no'
);

SET @add_reference_no_sql := IF(
  @reference_no_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `reference_no` VARCHAR(100) NULL',
  'SELECT ''documents.reference_no already exists'' AS message'
);

PREPARE add_reference_no FROM @add_reference_no_sql;
EXECUTE add_reference_no;
DEALLOCATE PREPARE add_reference_no;

SET @issuing_unit_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'issuing_unit'
);

SET @add_issuing_unit_sql := IF(
  @issuing_unit_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `issuing_unit` VARCHAR(255) NULL',
  'SELECT ''documents.issuing_unit already exists'' AS message'
);

PREPARE add_issuing_unit FROM @add_issuing_unit_sql;
EXECUTE add_issuing_unit;
DEALLOCATE PREPARE add_issuing_unit;

SET @organizing_body_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'organizing_body'
);

SET @add_organizing_body_sql := IF(
  @organizing_body_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `organizing_body` VARCHAR(255) NULL',
  'SELECT ''documents.organizing_body already exists'' AS message'
);

PREPARE add_organizing_body FROM @add_organizing_body_sql;
EXECUTE add_organizing_body;
DEALLOCATE PREPARE add_organizing_body;

SET @received_date_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'received_date'
);

SET @add_received_date_sql := IF(
  @received_date_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `received_date` DATE NULL',
  'SELECT ''documents.received_date already exists'' AS message'
);

PREPARE add_received_date FROM @add_received_date_sql;
EXECUTE add_received_date;
DEALLOCATE PREPARE add_received_date;

SET @document_number_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'document_number'
);

SET @add_document_number_sql := IF(
  @document_number_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `document_number` VARCHAR(100) NULL',
  'SELECT ''documents.document_number already exists'' AS message'
);

PREPARE add_document_number FROM @add_document_number_sql;
EXECUTE add_document_number;
DEALLOCATE PREPARE add_document_number;

SET @security_level_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'security_level'
);

SET @add_security_level_sql := IF(
  @security_level_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `security_level` VARCHAR(50) NULL',
  'SELECT ''documents.security_level already exists'' AS message'
);

PREPARE add_security_level FROM @add_security_level_sql;
EXECUTE add_security_level;
DEALLOCATE PREPARE add_security_level;

SET @author_name_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'author_name'
);

SET @add_author_name_sql := IF(
  @author_name_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `author_name` VARCHAR(255) NULL',
  'SELECT ''documents.author_name already exists'' AS message'
);

PREPARE add_author_name FROM @add_author_name_sql;
EXECUTE add_author_name;
DEALLOCATE PREPARE add_author_name;

SET @document_date_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'document_date'
);

SET @add_document_date_sql := IF(
  @document_date_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `document_date` DATE NULL',
  'SELECT ''documents.document_date already exists'' AS message'
);

PREPARE add_document_date FROM @add_document_date_sql;
EXECUTE add_document_date;
DEALLOCATE PREPARE add_document_date;

SET @classification_value_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'classification_value'
);

SET @add_classification_value_sql := IF(
  @classification_value_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `classification_value` ENUM(''permanent'', ''timed'', ''unclassified'') NOT NULL DEFAULT ''unclassified''',
  'SELECT ''documents.classification_value already exists'' AS message'
);

PREPARE add_classification_value FROM @add_classification_value_sql;
EXECUTE add_classification_value;
DEALLOCATE PREPARE add_classification_value;

SET @review_status_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'review_status'
);

SET @add_review_status_sql := IF(
  @review_status_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `review_status` ENUM(''pending'', ''in_progress'', ''completed'') NOT NULL DEFAULT ''pending''',
  'SELECT ''documents.review_status already exists'' AS message'
);

PREPARE add_review_status FROM @add_review_status_sql;
EXECUTE add_review_status;
DEALLOCATE PREPARE add_review_status;

SET @visibility_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'visibility'
);

SET @add_visibility_sql := IF(
  @visibility_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `visibility` ENUM(''public'', ''department'', ''private'') NOT NULL DEFAULT ''department''',
  'SELECT ''documents.visibility already exists'' AS message'
);

PREPARE add_visibility FROM @add_visibility_sql;
EXECUTE add_visibility;
DEALLOCATE PREPARE add_visibility;

SET @patient_death_date_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'patient_death_date'
);

SET @add_patient_death_date_sql := IF(
  @patient_death_date_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `patient_death_date` DATE NULL',
  'SELECT ''documents.patient_death_date already exists'' AS message'
);

PREPARE add_patient_death_date FROM @add_patient_death_date_sql;
EXECUTE add_patient_death_date;
DEALLOCATE PREPARE add_patient_death_date;

SET @expires_at_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'expires_at'
);

SET @add_expires_at_sql := IF(
  @expires_at_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `expires_at` DATE NULL',
  'SELECT ''documents.expires_at already exists'' AS message'
);

PREPARE add_expires_at FROM @add_expires_at_sql;
EXECUTE add_expires_at;
DEALLOCATE PREPARE add_expires_at;

-- Optional: ensure approved_at exists for archive filtering.
SET @approved_at_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'documents'
    AND COLUMN_NAME = 'approved_at'
);

SET @add_approved_at_sql := IF(
  @approved_at_exists = 0,
  'ALTER TABLE `documents` ADD COLUMN `approved_at` DATETIME NULL',
  'SELECT ''documents.approved_at already exists'' AS message'
);

PREPARE add_approved_at FROM @add_approved_at_sql;
EXECUTE add_approved_at;
DEALLOCATE PREPARE add_approved_at;
