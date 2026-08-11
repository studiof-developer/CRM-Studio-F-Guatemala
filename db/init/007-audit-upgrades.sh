#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

ALTER TABLE access_audit ADD COLUMN IF NOT EXISTS actor_user_id INTEGER REFERENCES users(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'access_audit_action_check'
  ) THEN
    ALTER TABLE access_audit ADD CONSTRAINT access_audit_action_check
      CHECK (action IN ('view_customer', 'view_ticket', 'view_conversation'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_access_audit_customer_id ON access_audit(customer_id);
CREATE INDEX IF NOT EXISTS idx_access_audit_accessed_at ON access_audit(accessed_at DESC);

ALTER TABLE ai_decision_log ADD COLUMN IF NOT EXISTS session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_ai_decision_log_created_at ON ai_decision_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_decision_log_session_id ON ai_decision_log(session_id);

EOSQL
