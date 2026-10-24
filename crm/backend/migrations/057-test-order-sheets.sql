-- Migration 057: fichas de prueba.
-- Una ficha puede crearse "de prueba" (se decide al crearla y no se puede cambiar después): lleva su propia numeración (PRUEBA-n, para no dejar
-- huecos en la numeración real) y es la única que su dueña o el administrador pueden eliminar. El registro de auditoría de las fichas reales
-- sigue sellado: solo se permite borrar los eventos de una ficha de prueba, al borrar esa ficha.
ALTER TABLE order_sheets ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
CREATE SEQUENCE IF NOT EXISTS order_sheet_test_seq;

CREATE OR REPLACE FUNCTION order_sheet_events_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM order_sheets WHERE id = OLD.sheet_id AND is_test) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'El registro de auditoría de logística no se edita ni se borra';
END;
$$ LANGUAGE plpgsql;

-- Nadie convierte una ficha real en "de prueba" (ni al revés) para poder borrarla o esconderla.
CREATE OR REPLACE FUNCTION order_sheets_test_flag_fixed() RETURNS trigger AS $$
BEGIN
  IF NEW.is_test IS DISTINCT FROM OLD.is_test THEN
    RAISE EXCEPTION 'Una ficha no puede cambiar entre real y de prueba';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_sheets_test_flag_fixed ON order_sheets;
CREATE TRIGGER trg_order_sheets_test_flag_fixed BEFORE UPDATE OF is_test ON order_sheets
  FOR EACH ROW EXECUTE FUNCTION order_sheets_test_flag_fixed();
