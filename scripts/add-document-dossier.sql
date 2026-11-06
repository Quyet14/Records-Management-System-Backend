-- Apply before deploying the backend. Existing documents remain standalone.
ALTER TABLE documents
  ADD COLUMN dossier_root_id varchar(36) NULL,
  ADD INDEX idx_documents_dossier_root (dossier_root_id),
  ADD CONSTRAINT fk_documents_dossier_root FOREIGN KEY (dossier_root_id)
    REFERENCES documents(id) ON DELETE RESTRICT;
