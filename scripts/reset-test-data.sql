-- TEST DATA ONLY. Target: lths, as shown in the test server screenshots.
-- Stop lths-backend (all PM2 instances) and take a database export first.
-- Execute this entire file in ONE session. TRUNCATE implicitly commits.
-- Keeps schema, triggers, foreign keys, migrations, users, departments,
-- document_types, tags, personal_files and authentication/session tables.
-- Clears shared documents, destruction requests/evidence, related logs and notifications.
-- Does NOT delete PDFs, backups, or the independent SQLite destruction journal.

USE `lths`;

SET @lths_previous_fk_checks = @@SESSION.FOREIGN_KEY_CHECKS;
SET SESSION FOREIGN_KEY_CHECKS = 0;

-- TRUNCATE does not run DELETE triggers. Protection triggers remain installed.
TRUNCATE TABLE `destruction_attachment_content`;
TRUNCATE TABLE `destruction_approvals`;
TRUNCATE TABLE `destruction_otp_challenges`;
TRUNCATE TABLE `destruction_attachments`;
TRUNCATE TABLE `destruction_backup_dispositions`;
TRUNCATE TABLE `destruction_jobs`;
TRUNCATE TABLE `destruction_idempotency`;
TRUNCATE TABLE `destruction_items`;
TRUNCATE TABLE `destruction_requests`;

TRUNCATE TABLE `document_tags`;
TRUNCATE TABLE `document_comments`;
TRUNCATE TABLE `document_versions`;
TRUNCATE TABLE `view_requests`;
TRUNCATE TABLE `access_logs`;
TRUNCATE TABLE `notifications`;
TRUNCATE TABLE `audit_logs`;
TRUNCATE TABLE `documents`;
TRUNCATE TABLE `files`;

SET SESSION FOREIGN_KEY_CHECKS = @lths_previous_fk_checks;

SELECT 'documents' AS table_name, COUNT(*) AS remaining_rows FROM `documents`
UNION ALL SELECT 'destruction_requests', COUNT(*) FROM `destruction_requests`
UNION ALL SELECT 'destruction_items', COUNT(*) FROM `destruction_items`
UNION ALL SELECT 'files', COUNT(*) FROM `files`;
