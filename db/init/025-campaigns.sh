#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Recipient-level tracking is NOT a separate table: each send is inserted into
-- n8n_chat_histories exactly like an advisor message (additional_kwargs.campaignId
-- links it back here), so it shows up in that customer's own conversation thread and
-- rides the existing wamid/status webhook — sent/delivered/read/failed all update it
-- the same way they already update every other outgoing message. This table is only
-- the campaign's own identity and the audience rule it was sent with.
CREATE TABLE campaigns (
    id                SERIAL PRIMARY KEY,
    template_name     TEXT NOT NULL,
    template_language TEXT NOT NULL,
    temperature       TEXT,
    requested_count   INTEGER,
    customer_ids      INTEGER[] NOT NULL DEFAULT '{}',
    recipient_count   INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'sending',
    created_by        TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ
);

EOSQL
