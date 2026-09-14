#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Phase 3 (2026-09-14): links a social_contacts row to a real customers/tickets row so
-- Instagram/Messenger contacts get the same Pipeline/temperature/audit treatment as
-- WhatsApp customers. customers.whatsapp_number stays NOT NULL UNIQUE untouched — a
-- social-linked customer gets the synthetic value 'social:<social_contacts.id>' there
-- instead of a real phone. That format can never collide with or be mistaken for a real
-- phone by any of the ~20 \d{7,15}-regex call sites elsewhere in the schema/codebase,
-- and it doubles as the exact sessionId format Conversations.jsx already routes to
-- SocialThreadPanel — so HandoffQueue.jsx's onOpenConversation(card.whatsappNumber)
-- call sites need zero code changes to also open a social thread.
ALTER TABLE social_contacts ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id);

-- Denormalized (not a join to social_contacts inside the Pipeline's hot CTEs) for the
-- same reason has_unread (051) was: that CTE is duplicated across /pipeline,
-- /pipeline/card, /pipeline/export, /pipeline/stats and runs on every board load, poll,
-- and live patch — the 2026-09-11 outage was exactly a per-row correlated subquery
-- added to this same query shape. A plain column read on customers (already in the base
-- JOIN) costs nothing extra.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (channel IN ('whatsapp', 'instagram', 'messenger'));

CREATE INDEX IF NOT EXISTS idx_social_contacts_customer_id ON social_contacts (customer_id);

EOSQL
