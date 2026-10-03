-- Migration 016: Critical composite indexes for chat history performance
-- 1. Index for rapid chat thread loading and pagination by session_id
CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_session_id_id 
  ON n8n_chat_histories (session_id, id DESC);

-- 2. Index for filtering by whatsapp line
CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_line_id 
  ON n8n_chat_histories (whatsapp_number_id, id DESC);

-- 3. Partial index for lightning-fast unread count checks
CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_human_unread
  ON n8n_chat_histories (id DESC)
  WHERE (message->>'type') = 'human';
