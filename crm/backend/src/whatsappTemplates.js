// Reglas de las plantillas de WhatsApp (Meta) en un solo lugar: validan lo que el usuario arma en el CRM y lo convierten
// a los "components" que pide la API de Meta, y hacen el camino inverso para mostrar una plantilla ya creada.
// Sin llamadas a la red: así se puede probar entero (whatsappTemplates.test.js).
export const CATEGORIES = ['MARKETING', 'UTILITY'];
export const LANGUAGES = [
  { value: 'es', label: 'Español' },
  { value: 'es_MX', label: 'Español (México)' },
  { value: 'es_AR', label: 'Español (Argentina)' },
  { value: 'es_ES', label: 'Español (España)' },
  { value: 'en_US', label: 'Inglés (EE. UU.)' },
  { value: 'pt_BR', label: 'Portugués (Brasil)' },
];
export const MEDIA_HEADERS = ['IMAGE', 'VIDEO', 'DOCUMENT'];
export const LIMITS = { body: 1024, header: 60, footer: 60, buttonText: 25, buttons: 10, urlButtons: 2, phoneButtons: 1, url: 2000 };

const NAME_RE = /^[a-z0-9_]{1,512}$/;
const PHONE_RE = /^\+\d{8,15}$/;
const bad = (message) => Object.assign(new Error(message), { status: 400 });

// Números de variable {{n}} usados en un texto, sin repetir y ordenados.
export function paramNumbers(text) {
  return [...new Set([...String(text ?? '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

// {{1}}, {{2}}… en orden, sin saltos: lo exige Meta al revisar. Devuelve la cantidad, o -1 si hay saltos.
export function sequentialParamCount(text) {
  const nums = paramNumbers(text);
  if (!nums.length) return 0;
  return nums.every((n, i) => n === i + 1) ? nums.length : -1;
}

const clean = (v) => String(v ?? '').trim();

function buildHeader(h) {
  if (!h || !h.format) return null;
  if (h.format === 'TEXT') {
    const text = clean(h.text);
    if (!text) throw bad('El texto del encabezado no puede estar vacío.');
    if (text.length > LIMITS.header) throw bad(`El encabezado admite hasta ${LIMITS.header} caracteres.`);
    const count = sequentialParamCount(text);
    if (count < 0 || count > 1) throw bad('El encabezado solo puede tener una variable: {{1}}.');
    if (count === 1 && !clean(h.example)) throw bad('Completa el valor de ejemplo de la variable del encabezado.');
    return { type: 'HEADER', format: 'TEXT', text, ...(count ? { example: { header_text: [clean(h.example)] } } : {}) };
  }
  if (MEDIA_HEADERS.includes(h.format)) {
    if (!clean(h.handle)) throw bad(`Sube un archivo de ejemplo para el encabezado de ${{ IMAGE: 'imagen', VIDEO: 'video', DOCUMENT: 'documento' }[h.format]}: Meta lo pide para revisar la plantilla.`);
    return { type: 'HEADER', format: h.format, example: { header_handle: [clean(h.handle)] } };
  }
  throw bad('Tipo de encabezado no admitido.');
}

function buildBody(b) {
  const text = clean(b?.text);
  if (!text) throw bad('El mensaje es obligatorio.');
  if (text.length > LIMITS.body) throw bad(`El mensaje admite hasta ${LIMITS.body} caracteres.`);
  const count = sequentialParamCount(text);
  if (count < 0) throw bad('Las variables deben ser {{1}}, {{2}}, {{3}}… en orden, sin saltos ni repetidas.');
  const examples = (Array.isArray(b?.examples) ? b.examples : []).map(clean);
  if (count > 0 && (examples.length !== count || examples.some((v) => !v))) throw bad(`El mensaje tiene ${count} variable(s): completa un valor de ejemplo para cada una.`);
  return { type: 'BODY', text, ...(count ? { example: { body_text: [examples] } } : {}) };
}

function buildFooter(f) {
  const text = clean(f);
  if (!text) return null;
  if (text.length > LIMITS.footer) throw bad(`El pie de página admite hasta ${LIMITS.footer} caracteres.`);
  if (/\{\{/.test(text)) throw bad('El pie de página no admite variables.');
  return { type: 'FOOTER', text };
}

function buildButtons(list) {
  const buttons = Array.isArray(list) ? list : [];
  if (!buttons.length) return null;
  if (buttons.length > LIMITS.buttons) throw bad(`Máximo ${LIMITS.buttons} botones.`);
  const out = buttons.map((b, i) => {
    const text = clean(b.text);
    if (!text) throw bad(`El botón ${i + 1} necesita un texto.`);
    if (text.length > LIMITS.buttonText) throw bad(`El texto del botón ${i + 1} admite hasta ${LIMITS.buttonText} caracteres.`);
    if (b.type === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text };
    if (b.type === 'URL') {
      const url = clean(b.url);
      if (!/^https?:\/\/\S+$/i.test(url) || url.length > LIMITS.url) throw bad(`El botón "${text}" necesita una dirección que empiece con https://.`);
      if (/\{\{/.test(url)) throw bad('Las direcciones con variable todavía no se pueden enviar desde el CRM; usa una dirección fija.');
      return { type: 'URL', text, url };
    }
    if (b.type === 'PHONE_NUMBER') {
      const phone = clean(b.phone).replace(/[\s-]/g, '');
      if (!PHONE_RE.test(phone)) throw bad(`El botón "${text}" necesita un teléfono con código de país, por ejemplo +50255551234.`);
      return { type: 'PHONE_NUMBER', text, phone_number: phone };
    }
    throw bad(`Tipo de botón no admitido en el botón ${i + 1}.`);
  });
  const count = (t) => out.filter((b) => b.type === t).length;
  if (count('URL') > LIMITS.urlButtons) throw bad(`Máximo ${LIMITS.urlButtons} botones de enlace.`);
  if (count('PHONE_NUMBER') > LIMITS.phoneButtons) throw bad('Máximo 1 botón de llamada.');
  // Meta exige que las respuestas rápidas vayan juntas, al inicio o al final de la lista.
  const qr = out.map((b, i) => (b.type === 'QUICK_REPLY' ? i : -1)).filter((i) => i >= 0);
  if (qr.length && qr.length < out.length) {
    const contiguous = qr[qr.length - 1] - qr[0] === qr.length - 1 && (qr[0] === 0 || qr[qr.length - 1] === out.length - 1);
    if (!contiguous) throw bad('Las respuestas rápidas deben ir juntas, antes o después de los demás botones.');
  }
  return { type: 'BUTTONS', buttons: out };
}

// spec: { header, body, footer, buttons } → components de Meta. Lanza un error 400 con un mensaje claro si algo no cumple.
export function buildComponents(spec) {
  return [buildHeader(spec.header), buildBody(spec.body), buildFooter(spec.footer), buildButtons(spec.buttons)].filter(Boolean);
}

export function validateNew({ name, category, language }) {
  if (!NAME_RE.test(name ?? '')) throw bad('El nombre solo puede tener minúsculas, números y guion bajo (_), sin espacios.');
  if (!CATEGORIES.includes(category)) throw bad('Categoría inválida.');
  if (!LANGUAGES.some((l) => l.value === language)) throw bad('Idioma no admitido.');
}

// Camino inverso: una plantilla de Meta → la forma simple que usa la pantalla.
export function describeTemplate(t) {
  const find = (type) => t.components?.find((c) => c.type === type);
  const h = find('HEADER'), b = find('BODY'), f = find('FOOTER'), bt = find('BUTTONS');
  return {
    id: t.id ?? null,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
    quality: t.quality_score?.score ?? null,
    correctCategory: t.correct_category ?? null,
    previousCategory: t.previous_category ?? null,
    header: h ? { format: h.format, text: h.text ?? null, example: h.example?.header_text?.[0] ?? h.example?.header_handle?.[0] ?? null } : null,
    body: b?.text ?? '',
    bodyExamples: b?.example?.body_text?.[0] ?? [],
    footer: f?.text ?? null,
    buttons: (bt?.buttons ?? []).map((x) => ({ type: x.type, text: x.text, url: x.url ?? null, phone: x.phone_number ?? null })),
  };
}
