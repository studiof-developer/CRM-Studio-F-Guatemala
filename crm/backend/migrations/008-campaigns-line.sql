-- Migration 008: tie each campaign to the WABA line it was sent from.
-- NULL = sent before this migration (legacy, uses Line 1 by default as before).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS whatsapp_number_id INTEGER REFERENCES whatsapp_numbers(id);
