ALTER TABLE tickets ADD COLUMN IF NOT EXISTS whatsapp_number_id INTEGER REFERENCES whatsapp_numbers(id) ON DELETE CASCADE;

-- Asignar los tickets existentes al único número de whatsapp existente
UPDATE tickets SET whatsapp_number_id = (SELECT id FROM whatsapp_numbers LIMIT 1) WHERE whatsapp_number_id IS NULL;

-- Trigger para asignar automáticamente la línea activa por defecto a tickets nuevos si no viene especificada (ej. n8n actual)
CREATE OR REPLACE FUNCTION default_ticket_whatsapp_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.whatsapp_number_id IS NULL THEN
        NEW.whatsapp_number_id := (SELECT id FROM whatsapp_numbers WHERE is_active = true ORDER BY id ASC LIMIT 1);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_default_ticket_whatsapp_number ON tickets;
CREATE TRIGGER trg_default_ticket_whatsapp_number
BEFORE INSERT ON tickets
FOR EACH ROW
EXECUTE FUNCTION default_ticket_whatsapp_number();

