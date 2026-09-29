-- Migration 012: Fix chat cross-contamination and notify payload with phone
CREATE OR REPLACE FUNCTION notify_message_change() RETURNS trigger AS $$
DECLARE
  v_phone TEXT;
BEGIN
  v_phone := split_part(NEW.session_id, '__', 1);
  IF v_phone !~ '^\d{7,15}$' THEN
    v_phone := NULL;
  END IF;

  PERFORM pg_notify(
    'message_changes',
    json_build_object(
      'session_id', NEW.session_id,
      'phone', v_phone
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
