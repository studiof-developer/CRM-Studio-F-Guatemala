// Definición del proceso logístico como DATOS: estados, pasos, quién puede hacer cada uno, qué variables captura, qué evidencia exige y qué
// separación de funciones aplica. Es la versión 0.1 del documento técnico: lo que todavía se está validando con el negocio está marcado
// PV y vive en LOGISTICS_DEFAULTS (parámetros editables), no repartido en el código.
// Cada paso lleva el código de la ficha técnica (LOG-FF.PP) para poder rastrearlo en el documento.

export const ROLES = {
  auditor_ingresos: 'Auditor/a de ingresos',
  verificador: 'Verificador/a de pedidos',
  traslados: 'Solicitante de traslados',
  autorizador: 'Autorizador de traslados',
  bodega: 'Bodega Online (recibe y consolida)',
  facturador: 'Facturador/a',
  empacador: 'Empacador/a',
  auditor_empaque: 'Auditor/a de empaque',
  despachador: 'Despachador/a y seguimiento (Guatex y tiendas)',
  jefe_logistica: 'Jefe/a de logística',
};

// Parámetros que todavía son PV (punto a validar): se cambian desde Logística > Configuración, sin tocar código.
export const LOGISTICS_DEFAULTS = {
  enforceSod: true, // separación de funciones (PRO-06)
  adminAllRoles: true, // el administrador puede ejercer cualquier rol (sigue sujeto a la separación de funciones)
  totalBusinessDays: 4, // DEC-06: plazo del pago al cliente (AMB-04: se cuenta desde que se aprueba el pago)
  holidays: [], // feriados AAAA-MM-DD que no cuentan como día hábil
  amountToleranceQ: 0, // B3: diferencia aceptada entre lo pagado y lo debido
  codAdvancePct: 25, // G1: anticipo de contraentrega, sobre el total
  codMaxAttempts: 2, // G2: intentos de entrega de contraentrega
  dispatchWarehouse: 'Oakland',
  warehouses: [], // A5: tiendas / bodegas de origen (vacío = texto libre)
  sla: {}, // horas por paso: { submit: 4, verify_ok: 8, ... } (vacío = sin alerta)
  // Ajustes según la ficha de papel (Control Ventas Online):
  allowCodGoods: false, // contraentrega del pedido completo (anticipo + saldo). En las fichas reales solo se cobra el flete al recibir; se deja apagado hasta confirmar
  requiredFields: ['full_name', 'phone'], // siempre obligatorios para enviar a auditoría (lo que casi siempre llena la asesora)
  requiredForDelivery: ['address', 'department'], // además, si va a domicilio o agencia (la paquetería los pide)
  includeFreightInRequired: true, // si el flete ya está pagado, los pagos deben cubrir también el flete
  numbering: { mode: 'auto', prefix: '' }, // auto = FIC-AAAA-00001 · custom = prefijo + número que define el administrador (p. ej. 2287)
};

export const STATUS = {
  BORRADOR: 'Borrador',
  EN_AUDITORIA_PAGO: 'En auditoría de pago',
  OBSERVADA: 'Observada (la asesora debe corregir)',
  NUEVO_PEDIDO: 'Nuevo pedido',
  EN_VERIFICACION: 'En verificación',
  VERIFICADA: 'Verificada',
  TRASLADO_SOLICITADO: 'Traslado solicitado',
  TRASLADO_AUTORIZADO: 'Traslado autorizado',
  RECIBIDO_BODEGA: 'Recibido en bodega Online',
  FALTANTE: 'Faltante (separado, esperando traslado)',
  CONSOLIDADO: 'Consolidado (paquete completo)',
  PAGO_VALIDADO: 'Pago de contado validado',
  FACTURADO: 'Facturado (contado)',
  ANTICIPO_VALIDADO: 'Anticipo validado (contraentrega)',
  EMPACADO: 'Empacado (pendiente de auditoría)',
  SELLADO: 'Auditado y sellado',
  GUIA_GENERADA: 'Guía generada',
  LISTO_RECOGER: 'Listo para recoger en tienda',
  DESPACHADO: 'Entregado a Guatex',
  EN_RUTA: 'En ruta',
  ENTREGADO: 'Entregado al cliente',
  DEVUELTO: 'Devuelto a bodega Guatex',
  CLIENTE_CONTACTADO: 'Cliente contactado',
  ACREDITACION_REPORTADA: 'Acreditación reportada',
  ACREDITACION_VERIFICADA: 'Acreditación verificada en banco',
  CERRADO: 'Cerrado',
  PAUSADA: 'Pausada',
  CANCELADA: 'Cancelada',
};

export const TERMINAL = ['CERRADO', 'CANCELADA'];

// Columnas del tablero de Logística (de izquierda a derecha).
export const BOARD = [
  { key: 'entrada', label: 'Pago y verificación', statuses: ['EN_AUDITORIA_PAGO', 'OBSERVADA', 'NUEVO_PEDIDO', 'EN_VERIFICACION', 'VERIFICADA'] },
  { key: 'traslado', label: 'Traslado y bodega', statuses: ['TRASLADO_SOLICITADO', 'TRASLADO_AUTORIZADO', 'RECIBIDO_BODEGA', 'FALTANTE', 'CONSOLIDADO'] },
  { key: 'preparacion', label: 'Facturación y empaque', statuses: ['PAGO_VALIDADO', 'FACTURADO', 'ANTICIPO_VALIDADO', 'EMPACADO', 'SELLADO'] },
  { key: 'despacho', label: 'Despacho y ruta', statuses: ['GUIA_GENERADA', 'LISTO_RECOGER', 'DESPACHADO', 'EN_RUTA', 'DEVUELTO', 'CLIENTE_CONTACTADO'] },
  { key: 'cierre', label: 'Entrega y cierre', statuses: ['ENTREGADO', 'ACREDITACION_REPORTADA', 'ACREDITACION_VERIFICADA', 'CERRADO'] },
  { key: 'excepciones', label: 'Excepciones', statuses: ['PAUSADA', 'CANCELADA'] },
];

const bool = (key, label) => ({ key, label, type: 'bool', required: true, mustBeTrue: true });
const text = (key, label, required = true) => ({ key, label, type: 'text', required });
const num = (key, label, required = true) => ({ key, label, type: 'number', required });
const date = (key, label, required = true) => ({ key, label, type: 'date', required });

// from: estados desde los que se puede dar el paso · roles: quién · mode: solo ese tipo de pago · sod: pasos que NO puede haber hecho la
// misma persona en la misma ficha · evidence: archivo obligatorio · slaHours: plazo por defecto (null = sin plazo; PV)
export const TRANSITIONS = {
  submit: { code: 'LOG-01.05', label: 'Enviar a auditoría de pago', from: ['BORRADOR', 'OBSERVADA'], to: 'EN_AUDITORIA_PAGO', roles: ['asesora'], fields: [], evidence: null, sod: [], slaHours: null, special: 'submit' },
  start_verification: { code: 'LOG-03.01', label: 'Tomar el pedido para verificar', from: ['NUEVO_PEDIDO'], to: 'EN_VERIFICACION', roles: ['verificador'], fields: [], evidence: null, sod: [], slaHours: null, special: 'assign' },
  verify_ok: {
    code: 'LOG-03.02', label: 'Ficha verificada', from: ['EN_VERIFICACION'], to: 'VERIFICADA', roles: ['verificador'], sod: ['audit_payment'],
    fields: [bool('ficha_completa', 'Todos los campos obligatorios están completos'), bool('existencias_ok', 'Las existencias en la bodega de origen cubren el pedido'), text('bodegas_origen', 'Bodega(s) de origen')],
    evidence: { required: true, label: 'Captura de la disponibilidad en el ERP' }, slaHours: null,
  },
  verify_observe: { code: 'LOG-03.03', label: 'Devolver a la asesora con observación', from: ['EN_VERIFICACION'], to: 'OBSERVADA', roles: ['verificador'], fields: [text('observation', 'Qué debe corregir la asesora')], evidence: null, sod: [], slaHours: null, special: 'observe' },
  request_transfer: {
    code: 'LOG-03.04', label: 'Solicitar traslado (físico y en el ERP)', from: ['VERIFICADA'], to: 'TRASLADO_SOLICITADO', roles: ['traslados'], sod: [],
    fields: [text('tr_numbers', 'Número(s) de TR en el ERP'), num('tr_count', 'Cantidad de TR'), text('tr_warehouses', 'Bodegas / tiendas de los TR')],
    evidence: { required: true, label: 'Documento del traslado en el ERP' }, slaHours: null,
  },
  authorize_transfer: { code: 'LOG-03.05', label: 'Autorizar traslado a bodega Online', from: ['TRASLADO_SOLICITADO'], to: 'TRASLADO_AUTORIZADO', roles: ['autorizador'], fields: [text('authorization_note', 'Observación', false)], evidence: null, sod: ['request_transfer'], slaHours: null },
  receive_transfer: {
    code: 'LOG-04.01', label: 'Recibir traslado físico', from: ['TRASLADO_AUTORIZADO'], to: 'RECIBIDO_BODEGA', roles: ['bodega'], sod: [],
    fields: [text('transfer_guide', 'Guía del traslado (Guatex)'), num('packages_received', 'Bultos recibidos'), text('discrepancies', 'Diferencias contra el ERP', false)],
    evidence: { required: true, label: 'Video de la recepción' }, slaHours: null,
  },
  consolidate_complete: {
    code: 'LOG-04.02', label: 'Paquete completo: consolidado contra la ficha', from: ['RECIBIDO_BODEGA'], to: 'CONSOLIDADO', roles: ['bodega'], sod: [],
    fields: [bool('referencias_ok', 'Referencias, tallas, colores y cantidades coinciden con la ficha')], evidence: null, slaHours: null,
  },
  consolidate_incomplete: { code: 'LOG-04.03', label: 'Paquete incompleto: separar y seguir el faltante', from: ['RECIBIDO_BODEGA'], to: 'FALTANTE', roles: ['bodega'], fields: [text('missing_detail', 'Qué falta (referencia, talla, color, cantidad)')], evidence: null, sod: [], slaHours: null },
  receive_missing: {
    code: 'LOG-04.04', label: 'Recibir faltantes y verificar el paquete', from: ['FALTANTE'], to: 'RECIBIDO_BODEGA', roles: ['bodega'], sod: [],
    fields: [text('transfer_guide', 'Guía del traslado (Guatex)'), num('packages_received', 'Bultos recibidos')], evidence: { required: true, label: 'Video de la recepción' }, slaHours: null,
  },

  // — contado —
  validate_cash: {
    code: 'LOG-05.01', label: 'Validar comprobante, forma de pago y monto', from: ['CONSOLIDADO'], to: 'PAGO_VALIDADO', roles: ['verificador'], mode: 'contado', sod: ['consolidate_complete'],
    fields: [bool('monto_cubre_pedido', 'El monto pagado cubre el valor del pedido')], evidence: null, slaHours: null,
  },
  issue_invoice_cash: {
    code: 'LOG-05.02', label: 'Emitir factura de contado', from: ['PAGO_VALIDADO'], to: 'FACTURADO', roles: ['facturador'], mode: 'contado', sod: ['audit_payment'],
    fields: [text('invoice_number', 'Número de factura'), date('invoice_date', 'Fecha de la factura')], evidence: { required: true, label: 'Factura (PDF o foto)' }, slaHours: null,
  },
  // — contraentrega —
  validate_advance: {
    code: 'LOG-06.01', label: 'Validar anticipo de contraentrega', from: ['CONSOLIDADO'], to: 'ANTICIPO_VALIDADO', roles: ['verificador'], mode: 'contraentrega', sod: ['consolidate_complete'],
    fields: [num('advance_amount', 'Anticipo recibido (Q)'), bool('anticipo_cumple', 'El anticipo cumple el porcentaje mínimo')], evidence: null, slaHours: null,
  },

  // — empaque y despacho (ambos tipos de pago) —
  pack: {
    code: 'LOG-07.01', label: 'Empacar pedido', from: ['FACTURADO', 'ANTICIPO_VALIDADO', 'EMPACADO'], to: 'EMPACADO', roles: ['empacador'], sod: [],
    fields: [num('packages_count', 'Cantidad de paquetes')], evidence: null, slaHours: null,
  },
  audit_pack: {
    code: 'LOG-07.02', label: 'Auditoría de empaque: conforme y sellar', from: ['EMPACADO'], to: 'SELLADO', roles: ['auditor_empaque'], sod: ['pack'],
    fields: [
      bool('ref_ok', 'Referencias correctas'), bool('talla_ok', 'Tallas correctas'), bool('color_ok', 'Colores correctos'), bool('cantidad_ok', 'Cantidades correctas'),
      bool('estado_ok', 'Prendas en buen estado'), bool('etiqueta_ok', 'Etiquetado correcto'), bool('guia_ok', 'Datos de envío coinciden con la ficha'), text('seal_number', 'Número de sello'),
    ],
    evidence: { required: true, label: 'Foto o video del contenido antes de sellar' }, slaHours: null,
  },
  audit_pack_fail: { code: 'LOG-07.03', label: 'Auditoría de empaque: no conforme', from: ['EMPACADO'], to: 'EMPACADO', roles: ['auditor_empaque'], sod: ['pack'], fields: [text('nonconformity', 'Qué no coincide con la ficha')], evidence: { required: true, label: 'Foto del hallazgo' }, slaHours: null, special: 'nonconformity' },
  generate_guide: {
    code: 'LOG-08.01', label: 'Generar guía en Guatex', from: ['SELLADO'], to: 'GUIA_GENERADA', roles: ['despachador'], delivery: ['domicilio', 'agencia'], sod: [],
    fields: [text('guide_number', 'Número de guía'), { key: 'guide_type', label: 'Tipo de guía', type: 'select', options: ['contado', 'xcobrar'], required: true }, num('amount_to_collect', 'Monto a cobrar al recibir (Q, solo XCOBRAR)', false)],
    evidence: { required: true, label: 'Guía (PDF o foto)' }, slaHours: null, special: 'guide',
  },
  ready_pickup: {
    code: 'LOG-08.04', label: 'Pedido listo para recoger en tienda', from: ['SELLADO'], to: 'LISTO_RECOGER', roles: ['despachador'], delivery: ['tienda'], sod: [],
    fields: [bool('asesora_avisada', 'Se avisó a la asesora para que contacte al cliente')], evidence: { required: true, label: 'Foto del paquete sellado en la tienda' }, slaHours: null,
  },
  hand_over: {
    code: 'LOG-08.02', label: 'Entregar paquete a Guatex', from: ['GUIA_GENERADA'], to: 'DESPACHADO', roles: ['despachador'], sod: [],
    fields: [date('pickup_date', 'Fecha de recolección / entrega'), text('manifest_number', 'Número de manifiesto')], evidence: { required: true, label: 'Manifiesto de guías' }, slaHours: null,
  },
  send_guide: { code: 'LOG-08.03', label: 'Enviar guía a la asesora', from: ['DESPACHADO'], to: 'EN_RUTA', roles: ['despachador'], fields: [text('sent_via', 'Por dónde se envió (WhatsApp, correo…)')], evidence: null, sod: [], slaHours: null },

  // — seguimiento y cierre —
  mark_delivered: { code: 'LOG-09.01', label: 'Entrega confirmada', from: ['EN_RUTA'], to: 'ENTREGADO', roles: ['despachador'], fields: [date('delivered_at', 'Fecha de entrega'), text('received_by', 'Quién recibió')], evidence: null, sod: [], slaHours: null },
  confirm_received: { code: 'LOG-09.02', label: 'Cliente confirmó recibido: cerrar', from: ['ENTREGADO'], to: 'CERRADO', roles: ['despachador'], mode: 'contado', fields: [bool('cliente_confirmo', 'El cliente confirmó que recibió su pedido')], evidence: null, sod: [], slaHours: null },
  deliver_pickup: {
    code: 'LOG-09.03', label: 'Entregado al cliente en tienda', from: ['LISTO_RECOGER'], to: 'CERRADO', roles: ['despachador'], mode: 'contado', delivery: ['tienda'], sod: [],
    fields: [date('delivered_at', 'Fecha de entrega'), text('received_by', 'Quién recibió (nombre y DPI)')], evidence: { required: true, label: 'Foto o firma de recibido' }, slaHours: null,
  },
  // contraentrega: el cliente no paga al recibir
  return_to_hub: { code: 'LOG-10.01', label: 'El cliente no pagó: paquete regresa a bodega Guatex', from: ['EN_RUTA'], to: 'DEVUELTO', roles: ['despachador'], mode: 'contraentrega', fields: [text('reason', 'Motivo')], evidence: null, sod: [], slaHours: null, special: 'attempt' },
  contact_client: { code: 'LOG-10.02', label: 'Cliente contactado: confirma recibir y pagar', from: ['DEVUELTO'], to: 'CLIENTE_CONTACTADO', roles: ['asesora'], mode: 'contraentrega', fields: [bool('cliente_confirmo_pago', 'El cliente confirmó que recibirá y pagará'), text('note', 'Observación', false)], evidence: null, sod: [], slaHours: null },
  redispatch: { code: 'LOG-10.03', label: 'Despachar de nuevo', from: ['CLIENTE_CONTACTADO'], to: 'EN_RUTA', roles: ['despachador'], mode: 'contraentrega', fields: [date('new_date', 'Fecha del nuevo intento')], evidence: null, sod: [], slaHours: null, special: 'redispatch' },
  report_credit: {
    code: 'LOG-11.01', label: 'Reportar acreditación de Guatex', from: ['ENTREGADO'], to: 'ACREDITACION_REPORTADA', roles: ['despachador'], mode: 'contraentrega', sod: [],
    fields: [num('credit_amount', 'Monto acreditado (Q)'), date('credit_date', 'Fecha de acreditación'), text('guatex_reference', 'Referencia de Guatex')], evidence: { required: true, label: 'Soporte de la acreditación' }, slaHours: null,
  },
  verify_credit: {
    code: 'LOG-11.02', label: 'Verificar acreditación en el banco y auditar el pago', from: ['ACREDITACION_REPORTADA'], to: 'ACREDITACION_VERIFICADA', roles: ['auditor_ingresos'], mode: 'contraentrega', sod: ['report_credit'],
    fields: [text('bank', 'Banco'), text('bank_reference', 'Referencia bancaria'), num('verified_amount', 'Monto verificado (Q)')], evidence: { required: true, label: 'Captura del movimiento bancario' }, slaHours: null,
  },
  invoice_cod: {
    code: 'LOG-11.03', label: 'Emitir factura de contraentrega y cerrar', from: ['ACREDITACION_VERIFICADA'], to: 'CERRADO', roles: ['facturador'], mode: 'contraentrega', sod: ['verify_credit'],
    fields: [text('invoice_number', 'Número de factura'), date('invoice_date', 'Fecha de la factura')], evidence: { required: true, label: 'Factura (PDF o foto)' }, slaHours: null,
  },

  // — excepciones —
  hold: { code: 'LOG-90.01', label: 'Pausar pedido', from: 'ACTIVE', to: 'PAUSADA', roles: ['jefe_logistica'], fields: [text('reason', 'Motivo de la pausa')], evidence: null, sod: [], slaHours: null, special: 'hold' },
  resume: { code: 'LOG-90.02', label: 'Reanudar pedido', from: ['PAUSADA'], to: null, roles: ['jefe_logistica'], fields: [text('note', 'Observación', false)], evidence: null, sod: [], slaHours: null, special: 'resume' },
  cancel: { code: 'LOG-90.03', label: 'Cancelar pedido', from: 'ACTIVE', to: 'CANCELADA', roles: ['jefe_logistica'], fields: [text('reason', 'Motivo de la cancelación')], evidence: null, sod: [], slaHours: null, special: 'cancel' },
};

export const EDITABLE_STATUSES = ['BORRADOR', 'OBSERVADA'];

export const isActive = (status) => !TERMINAL.includes(status) && status !== 'PAUSADA';

// Estados desde los que sale un paso (resuelve "ACTIVE" = cualquier estado no terminal ni pausado).
export function fromStatuses(step) {
  return step.from === 'ACTIVE' ? Object.keys(STATUS).filter(isActive) : step.from;
}

// Pasos que se pueden dar sobre una ficha: según su estado y su tipo de pago. No mira quién es la persona (eso lo hace allowedFor).
export function stepsFor(sheet) {
  return Object.entries(TRANSITIONS)
    .filter(([, s]) => fromStatuses(s).includes(sheet.status) && (!s.mode || s.mode === sheet.payment_mode) && (!s.delivery || s.delivery.includes(sheet.delivery_type)))
    .map(([key, s]) => ({ key, ...s }));
}

// Quién puede dar el paso: roles de logística de la persona, el rol especial "asesora" (quien creó la ficha) y el administrador.
// events: lo que ya hizo esa misma persona en esta ficha, para la separación de funciones.
export function allowedFor({ step, sheet, userId, userRole, roles = [], done = [], cfg = LOGISTICS_DEFAULTS }) {
  const isCreator = sheet.created_by === userId;
  const hasRole = step.roles.some((r) => (r === 'asesora' ? isCreator || userRole === 'admin' : roles.includes(r) || (cfg.adminAllRoles && userRole === 'admin')));
  if (!hasRole) return { ok: false, reason: 'No tienes el rol para este paso' };
  if (cfg.enforceSod && step.sod?.length) {
    const clash = step.sod.find((k) => done.includes(k));
    if (clash) return { ok: false, reason: `Separación de funciones: quien hizo "${TRANSITIONS[clash]?.label ?? clash}" no puede hacer este paso` };
  }
  return { ok: true };
}

// Variables que capturó el paso: faltantes y tipos. Devuelve { data, errors } con los valores ya normalizados.
export function validateFields(step, input = {}) {
  const errors = [];
  const data = {};
  for (const f of step.fields) {
    const raw = input[f.key];
    const empty = raw === undefined || raw === null || String(raw).trim() === '';
    if (empty) { if (f.required) errors.push(`Falta: ${f.label}`); continue; }
    if (f.type === 'bool') {
      const v = raw === true || raw === 'true';
      if (f.mustBeTrue && !v) { errors.push(`Debe confirmarse: ${f.label}`); continue; }
      data[f.key] = v;
    } else if (f.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) { errors.push(`Número no válido: ${f.label}`); continue; }
      data[f.key] = n;
    } else if (f.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) { errors.push(`Fecha no válida (AAAA-MM-DD): ${f.label}`); continue; }
      data[f.key] = String(raw);
    } else if (f.type === 'select') {
      if (!f.options.includes(String(raw))) { errors.push(`Valor no permitido: ${f.label}`); continue; }
      data[f.key] = String(raw);
    } else data[f.key] = String(raw).trim().slice(0, 1000);
  }
  return { data, errors };
}

// — días hábiles (DEC-06): lunes a viernes, sin feriados —
const ymd = (d) => d.toISOString().slice(0, 10);
const GT_OFFSET_MS = 6 * 3600000;
export const guatemalaDay = (date) => ymd(new Date(+new Date(date) - GT_OFFSET_MS));

// Fecha límite = fin del n-ésimo día hábil después del día del pago (hora de Guatemala). Ej.: paga el lunes, n = 4 → viernes 23:59.
export function addBusinessDays(from, n, holidays = []) {
  let d = new Date(`${guatemalaDay(from)}T12:00:00Z`);
  const off = new Set(holidays);
  let left = n;
  while (left > 0) {
    d = new Date(+d + 86400000);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !off.has(ymd(d))) left--;
  }
  return new Date(`${ymd(d)}T23:59:59-06:00`);
}

// Cuánto debe estar pagado para pasar a Logística: el total (contado) o el anticipo (contraentrega).
export function requiredPayment(sheet, cfg = LOGISTICS_DEFAULTS) {
  const total = Number(sheet.total);
  if (sheet.payment_mode === 'contraentrega') return Math.round(total * cfg.codAdvancePct) / 100;
  const freight = cfg.includeFreightInRequired && sheet.shipping_payment === 'pagado' ? Number(sheet.shipping) || 0 : 0;
  return Math.round((total + freight) * 100) / 100;
}

// Qué hace falta para enviar la ficha a auditoría. Devuelve la lista de faltantes. Los campos obligatorios salen de la configuración
// (por defecto los que casi siempre llena la asesora en la ficha de papel).
export const SHEET_FIELD_LABELS = { full_name: 'Nombre completo', phone: 'Celular', email: 'Correo', address: 'Dirección', city: 'Ciudad', department: 'Departamento', campaign: 'Nombre de la campaña', dpi: 'DPI', zone: 'Zona', address_ref: 'Referencia de la dirección' };
export function sheetMissing(sheet, items, payments, cfg = LOGISTICS_DEFAULTS) {
  const pickup = sheet.delivery_type === 'tienda';
  const keys = [...new Set([...(cfg.requiredFields ?? []), ...(pickup ? [] : cfg.requiredForDelivery ?? [])])];
  const missing = keys.filter((k) => SHEET_FIELD_LABELS[k] && !String(sheet[k] ?? '').trim()).map((k) => SHEET_FIELD_LABELS[k]);
  if (pickup && !String(sheet.pickup_store ?? '').trim()) missing.push('Tienda donde recoge');
  if (!items.length) missing.push('Al menos una prenda');
  else if (items.some((i) => !String(i.origin_warehouse ?? '').trim())) missing.push('Tienda de origen de cada prenda');
  if (!(Number(sheet.total) > 0)) missing.push('Total mayor a cero');
  if (sheet.shipping_payment === 'al_recibir' && !(Number(sheet.shipping) > 0)) missing.push('Monto del flete (se cobra al recibir)');
  if (!payments.length) missing.push('Al menos un pago con su comprobante');
  else if (payments.some((p) => !p.attachment_id)) missing.push('Cada pago debe llevar su comprobante');
  if (payments.some((p) => !String(p.reference_number ?? '').trim())) missing.push('Cada pago necesita su número de referencia');
  if (payments.some((p) => p.method === 'tarjeta_link' && !p.platform_verified)) missing.push('Confirmar que el pago con Link se verificó en NeoLink');
  return missing;
}

// Traslados que hay que pedir: uno por cada tienda de origen distinta (aunque sea la misma bodega de despacho).
export function transfersNeeded(items) {
  const stores = new Map();
  for (const i of items) {
    const name = String(i.origin_warehouse ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const cur = stores.get(key) ?? { store: name, units: 0, references: [] };
    cur.units += Number(i.quantity) || 0;
    cur.references.push(i.reference);
    stores.set(key, cur);
  }
  return [...stores.values()];
}

// Totales de la ficha a partir de sus prendas (el servidor recalcula siempre). El flete va aparte: no entra en el total del pedido.
export function computeTotals(items, shipping = 0) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const subtotal = r2(items.reduce((s, i) => s + Number(i.unit_price) * Number(i.quantity), 0));
  const goods = r2(items.reduce((s, i) => s + Number(i.final_price) * Number(i.quantity), 0));
  return { subtotal, discount_total: r2(subtotal - goods), shipping: r2(Number(shipping) || 0), total: goods };
}

// Qué pasa con la ficha cuando termina de auditarse un pago. payments: sus pagos con audit_status; devuelve el nuevo estado y el motivo.
export function settleAudit(sheet, payments, cfg = LOGISTICS_DEFAULTS) {
  if (payments.some((p) => p.audit_status === 'pendiente')) return { status: 'EN_AUDITORIA_PAGO' };
  const bad = payments.filter((p) => p.audit_status === 'observado' || p.audit_status === 'rechazado');
  if (bad.length) return { status: 'OBSERVADA', observation: bad.map((p) => `Pago ${p.reference_number ?? p.id} (${p.audit_status}): ${p.audit_note ?? 'sin nota'}`).join(' · ') };
  const approved = payments.filter((p) => p.audit_status === 'aprobado').reduce((s, p) => s + Number(p.audit_amount ?? p.amount), 0);
  const need = requiredPayment(sheet, cfg);
  if (approved + cfg.amountToleranceQ + 0.001 < need) return { status: 'OBSERVADA', observation: `Falta pago: aprobado Q${approved.toFixed(2)} de Q${need.toFixed(2)} requeridos` };
  return { status: 'NUEVO_PEDIDO' };
}

// Horas que una ficha puede estar en un estado antes de marcarse vencida (configurable por estado; sin valor = sin plazo; PV).
export const slaForStatus = (status, cfg = LOGISTICS_DEFAULTS) => (Number(cfg.sla?.[status]) > 0 ? Number(cfg.sla[status]) : null);
