-- Migration 010: opt-out flag for broadcast campaigns.
-- opted_out_campaigns = true → customer is excluded from all future bulk broadcasts.
-- opted_out_at records when the opt-out occurred (auto-detected keyword or manual toggle).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS opted_out_campaigns BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;
