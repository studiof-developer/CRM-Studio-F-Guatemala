-- Migration 009: allow quick-replies to be scoped to a specific WhatsApp line/brand.
-- NULL means "global" — visible to everyone regardless of which line they're chatting on.
ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS whatsapp_number_id INTEGER REFERENCES whatsapp_numbers(id);
