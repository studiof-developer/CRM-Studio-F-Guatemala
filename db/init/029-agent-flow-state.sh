#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Tracks where the AI agent is mid-conversation (which of the ~9 branches in the
-- Mar-IA flow), keyed the same way the n8n Postgres Chat Memory node keys its own
-- session (whatsapp_number) so both stay in sync. A stateless LLM call can't reliably
-- re-derive "which branch am I on" from raw chat history alone once waits/timeouts
-- are involved — this is what the agent reads/writes every turn instead.
CREATE TABLE agent_conversation_state (
    whatsapp_number         TEXT PRIMARY KEY,
    stage                   TEXT NOT NULL DEFAULT 'identificando',
    customer_name           TEXT,
    talla                   TEXT,
    linea_anuncio           TEXT,
    sublinea_anuncio        TEXT,
    color_anuncio           TEXT,
    temperatura             TEXT,
    referencias_ofrecidas   JSONB NOT NULL DEFAULT '[]'::jsonb,
    deadline_at             TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who's on shift, so the welcome message can use a real advisor's name instead of
-- "Mar-IA" when someone's actually covering that slot.
CREATE TABLE advisor_schedules (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day_of_week     SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    start_time      TIME NOT NULL,
    end_time        TIME NOT NULL
);
CREATE INDEX advisor_schedules_lookup ON advisor_schedules (day_of_week, start_time, end_time);

EOSQL
