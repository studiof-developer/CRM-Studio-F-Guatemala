// Cliente con historial de compras en el ERP, para las difusiones. Se cruza por los últimos 8 dígitos del teléfono, igual que la ficha del cliente.
// idleDays (10 a 30, de 5 en 5): además, que lleve más de esos días sin comprar, ni en tienda (fecha de la última factura del ERP) ni por el CRM
// (venta registrada). Así no se manda una difusión a quien compró hace 2 o 3 días.
export const IDLE_DAY_OPTIONS = [10, 15, 20, 25, 30];

export function parseIdleDays(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!IDLE_DAY_OPTIONS.includes(n)) throw Object.assign(new Error('Los días sin comprar van de 5 en 5, entre 10 y 30'), { status: 400 });
  return n;
}

const PHONE_MATCH = '(e.telefono = right(c.whatsapp_number, 8) OR e.celular = right(c.whatsapp_number, 8))';

export function erpBuyerSql(idleDays = null) {
  if (!idleDays) return `EXISTS (SELECT 1 FROM erp_customers e WHERE COALESCE(e.facturas_totales, 0) > 0 AND ${PHONE_MATCH})`;
  const n = Number(idleDays); // ya validado por parseIdleDays: nunca llega texto del usuario a la consulta
  return `(EXISTS (SELECT 1 FROM erp_customers e WHERE COALESCE(e.facturas_totales, 0) > 0 AND e.fecha_ultima_compra IS NOT NULL AND ${PHONE_MATCH})
    AND NOT EXISTS (SELECT 1 FROM erp_customers e WHERE e.fecha_ultima_compra > (now() AT TIME ZONE 'America/Guatemala')::date - ${n} AND ${PHONE_MATCH})
    AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = c.id AND s.status IN ('confirmada', 'revisar') AND s.created_at > now() - interval '${n} days'))`;
}
