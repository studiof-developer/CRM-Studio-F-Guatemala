#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Extends the audit trail from "who looked at what" to "who changed what" — a human-
-- readable "from -> to" summary (a plain string is enough here, this isn't queried
-- structurally anywhere, just displayed).
ALTER TABLE access_audit ADD COLUMN IF NOT EXISTS details TEXT;

ALTER TABLE access_audit DROP CONSTRAINT IF EXISTS access_audit_action_check;
ALTER TABLE access_audit ADD CONSTRAINT access_audit_action_check
  CHECK (action IN (
    'view_customer', 'view_ticket', 'view_conversation', 'login',
    'user_created', 'user_updated', 'user_deleted',
    'whatsapp_number_created', 'whatsapp_number_updated', 'whatsapp_number_deleted',
    'ticket_status_changed', 'customer_status_changed', 'customer_marked_paid'
  ));

EOSQL
