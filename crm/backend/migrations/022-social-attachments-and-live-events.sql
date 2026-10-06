-- Migration 022: Allow message_attachments to link to social_messages as well as n8n_chat_histories
ALTER TABLE message_attachments ALTER COLUMN n8n_message_id DROP NOT NULL;
ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS social_message_id INTEGER REFERENCES social_messages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_message_attachments_social_message_id ON message_attachments(social_message_id);
