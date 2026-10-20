import { pool } from './db.js';
import { broadcast } from './events.js';

export const TEMPLATE_FIELDS = ['message_template_status_update', 'message_template_quality_update', 'template_category_update'];

// Convierte el valor que manda Meta en un aviso simple { event, detail }. Pura: se prueba sin base de datos.
export function describeTemplateEvent(field, v = {}) {
  if (field === 'message_template_status_update') {
    const reason = v.reason && v.reason !== 'NONE' ? v.reason : null;
    const extra = v.disable_info?.disable_date ? `deshabilitada el ${v.disable_info.disable_date}` : v.other_info?.description ?? null;
    return { event: String(v.event ?? 'UPDATE').toUpperCase(), detail: [reason, extra].filter(Boolean).join(' · ') || null };
  }
  if (field === 'message_template_quality_update') {
    return { event: 'QUALITY_UPDATE', detail: `${v.previous_quality_score ?? '?'} → ${v.new_quality_score ?? '?'}` };
  }
  if (field === 'template_category_update') {
    const to = v.new_category ?? v.correct_category;
    return { event: 'CATEGORY_UPDATE', detail: `${v.previous_category ?? '?'} → ${to ?? '?'}` };
  }
  return null;
}

// Guarda el aviso y lo empuja en vivo a las pantallas abiertas (la lista de plantillas se recarga y muestra el cambio).
export async function recordTemplateEvent(wabaId, change) {
  const info = describeTemplateEvent(change.field, change.value);
  const v = change.value ?? {};
  if (!info || !v.message_template_name) return;
  await pool.query(
    `INSERT INTO whatsapp_template_events (waba_id, template_id, template_name, language, event, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
    [wabaId ?? null, v.message_template_id != null ? String(v.message_template_id) : null, v.message_template_name, v.message_template_language ?? null, info.event, info.detail]
  );
  broadcast('template_changes', JSON.stringify({ name: v.message_template_name, language: v.message_template_language ?? null, event: info.event, detail: info.detail }));
}
