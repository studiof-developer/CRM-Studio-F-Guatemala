#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

CREATE TABLE conversation_reads (
    phone                 TEXT PRIMARY KEY,
    last_read_message_id  INTEGER NOT NULL,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Without this, every thread nobody has reopened since this feature shipped would
-- show its ENTIRE message history as "unread" (watermark defaults to 0) — this marks
-- everything that already existed as caught-up, so only genuinely new messages count.
INSERT INTO conversation_reads (phone, last_read_message_id, updated_at)
SELECT phone, max(id), now()
FROM (
    SELECT h.id,
           CASE WHEN h.session_id ~ '^\d{7,15}$' THEN h.session_id ELSE p.phone END AS phone
    FROM n8n_chat_histories h
    LEFT JOIN (
        SELECT DISTINCT ON (session_id) session_id, trim(message->>'content') AS phone
        FROM n8n_chat_histories
        WHERE message->>'type' = 'human' AND trim(message->>'content') ~ '^\d{7,15}$'
        ORDER BY session_id, id ASC
    ) p USING (session_id)
) resolved
WHERE phone IS NOT NULL
GROUP BY phone
ON CONFLICT (phone) DO NOTHING;

EOSQL
