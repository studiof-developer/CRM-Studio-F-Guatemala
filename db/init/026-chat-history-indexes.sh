#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- n8n_chat_histories had no index at all — every read (the conversation list, opening
-- a thread, sending a message, campaigns, the status webhook) does a full sequential
-- scan of the whole table. Confirmed via EXPLAIN ANALYZE in production: 165ms for the
-- conversation list at ~15k rows today, and it grows with every new message logged —
-- exactly the "it's slower now that there are more messages" pattern reported.

-- session_id is matched both exactly and as a LIKE 'phone%' prefix everywhere
-- (findConversationThread, the conversation list's threaded/phone_by_session CTEs,
-- campaign sends). text_pattern_ops makes a prefix LIKE usable by a plain B-tree index
-- regardless of the database's collation.
CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_session_id
  ON n8n_chat_histories (session_id text_pattern_ops);

-- message->>'type' is filtered on in the conversation list, the unread count, orphan
-- recovery, and the new-customer check — on effectively every read of this table.
CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_type
  ON n8n_chat_histories ((message->>'type'));

-- Matched by the delivery-status webhook on every sent/delivered/read/failed event,
-- and by the orphan-recovery sweep looking for messages with none yet. Partial index
-- since most rows are inbound and never carry this field at all.
CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_wamid
  ON n8n_chat_histories ((message->'additional_kwargs'->>'wamid'))
  WHERE message->'additional_kwargs'->>'wamid' IS NOT NULL;

-- Scanned in full, once per campaign, four times over (sent/delivered/read/failed
-- counts) by GET /api/campaigns — see the note there. Partial for the same reason.
CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_campaign_id
  ON n8n_chat_histories ((message->'additional_kwargs'->>'campaignId'))
  WHERE message->'additional_kwargs'->>'campaignId' IS NOT NULL;

EOSQL
