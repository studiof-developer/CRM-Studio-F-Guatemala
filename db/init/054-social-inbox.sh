#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Instagram DM + Messenger inbox (2026-09-14) — deliberately separate from
-- customers/n8n_chat_histories, not an extension of them. WhatsApp's whole schema
-- assumes a phone-number identity (session_id split on '__', regex-validated as
-- \d{7,15}, joined against customers.whatsapp_number) at ~20 call sites across both
-- SQL triggers and JS routes — Instagram/Messenger IDs (IGSID/PSID) aren't phone-shaped
-- and were never meant to flow through that machinery. Keeping this fully separate
-- means zero risk to the revenue-critical WhatsApp path from a brand-new, unproven
-- integration. Unifying identity across channels is a deliberate later decision, not
-- an accident of shared tables.
CREATE TABLE social_contacts (
    id               SERIAL PRIMARY KEY,
    provider         TEXT NOT NULL CHECK (provider IN ('instagram', 'messenger')),
    external_id      TEXT NOT NULL,
    display_name     TEXT,
    profile_pic_url  TEXT,
    last_message_at  TIMESTAMPTZ,
    unread_count     INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, external_id)
);

CREATE TABLE social_messages (
    id                  SERIAL PRIMARY KEY,
    contact_id          INTEGER NOT NULL REFERENCES social_contacts(id),
    direction           TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    body                TEXT,
    raw_payload         JSONB,
    external_message_id TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_social_messages_contact_id ON social_messages (contact_id, created_at);
CREATE INDEX idx_social_contacts_last_message_at ON social_contacts (last_message_at DESC);

EOSQL
