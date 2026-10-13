CREATE TABLE IF NOT EXISTS view_requests (
  id varchar(36) NOT NULL,
  document_id varchar(36) NOT NULL,
  requester_id varchar(36) NOT NULL,
  approver_id varchar(36) NULL,
  reason text NOT NULL,
  status enum('pending','approved','rejected','expired') NOT NULL DEFAULT 'pending',
  decision_note text NULL,
  access_expires_at timestamp NULL,
  requested_duration int NULL,
  approved_duration int NULL,
  extended_from_request_id varchar(36) NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  decided_at timestamp NULL,
  PRIMARY KEY (id),
  KEY idx_view_requests_document (document_id),
  KEY idx_view_requests_requester (requester_id),
  KEY idx_view_requests_approver (approver_id),
  KEY idx_view_requests_extended_from (extended_from_request_id),
  KEY idx_view_requests_status_expires (status, access_expires_at),
  CONSTRAINT fk_view_requests_document
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  CONSTRAINT fk_view_requests_requester
    FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_view_requests_approver
    FOREIGN KEY (approver_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_view_requests_extended_from
    FOREIGN KEY (extended_from_request_id) REFERENCES view_requests(id) ON DELETE SET NULL
);

ALTER TABLE view_requests
  ADD COLUMN requested_duration int NULL;

ALTER TABLE view_requests
  ADD COLUMN approved_duration int NULL;

ALTER TABLE view_requests
  ADD COLUMN extended_from_request_id varchar(36) NULL;

ALTER TABLE view_requests
  ADD KEY idx_view_requests_extended_from (extended_from_request_id);

ALTER TABLE view_requests
  ADD CONSTRAINT fk_view_requests_extended_from
    FOREIGN KEY (extended_from_request_id) REFERENCES view_requests(id) ON DELETE SET NULL;

ALTER TABLE document_types
  ADD COLUMN max_view_duration_days int NULL;

CREATE TABLE IF NOT EXISTS access_logs (
  id varchar(36) NOT NULL,
  document_id varchar(36) NOT NULL,
  user_id varchar(36) NOT NULL,
  action enum('requested','approved','rejected','viewed') NOT NULL,
  timestamp datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_access_logs_document (document_id),
  KEY idx_access_logs_user (user_id),
  KEY idx_access_logs_action_timestamp (action, timestamp),
  CONSTRAINT fk_access_logs_document
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  CONSTRAINT fk_access_logs_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE notifications
  MODIFY type enum(
    'document_approved',
    'document_rejected',
    'document_pending',
    'role_changed',
    'view_request_pending',
    'view_request_approved',
    'view_request_rejected'
  ) NOT NULL;
