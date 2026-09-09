#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Seeds each with today's real hardcoded value, so turning these into settings
-- changes nothing until an admin actually edits one.
INSERT INTO app_settings (key, value) VALUES ('sla_minutes', '15'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_settings (key, value) VALUES ('awaiting_reply_overdue_minutes', '60'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_settings (key, value) VALUES ('broadcast_cooldown_hours', '42'::jsonb)
ON CONFLICT (key) DO NOTHING;

EOSQL
