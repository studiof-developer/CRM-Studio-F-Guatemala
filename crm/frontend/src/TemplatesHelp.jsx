import { useState } from 'react';
import InfoModal from './components/InfoModal.jsx';

// Ayuda de Marketing > Plantillas: cómo funciona la sección, los tipos de plantilla que existen en WhatsApp y cuáles se
// pueden crear desde el CRM, y qué significan los estados y la calidad. Es texto fijo: si Meta agrega formatos nuevos, se
// actualiza aquí.
const TABS = [
  { key: 'how', label: 'Cómo funciona' },
  { key: 'types', label: 'Tipos de plantilla' },
  { key: 'status', label: 'Estados y calidad' },
];

const STEPS = [
  ['Elige la línea', 'Cada línea de WhatsApp tiene sus propias plantillas. Arriba a la izquierda eliges con cuál trabajas.'],
  ['Crea la plantilla', 'Pon nombre (minúsculas y guion bajo), categoría, idioma y el mensaje. En el mensaje, {{1}} es siempre el nombre del cliente; {{2}}, {{3}}… son valores distintos por cliente (por ejemplo un número de guía) que se piden al armar la difusión. Meta pide un ejemplo por cada variable.'],
  ['Espera la revisión de Meta', 'Queda "En revisión" de unos minutos a ~1 día. Cuando Meta responde, el CRM lo avisa aquí mismo (en "Cambios recientes").'],
  ['Úsala en Difusión', 'Solo las plantillas "Aprobadas" aparecen para enviar en Marketing → Difusión.'],
  ['Edita, duplica o elimina', 'Una aprobada se puede editar 1 vez al día y hasta 10 al mes; no cambia de categoría ni de nombre. Duplicar sirve para crear una variante nueva. Al eliminar puedes quitar solo un idioma o todos.'],
  ['Mide', 'En "Rendimiento" ves cuántas se enviaron, entregaron, leyeron, fallaron y cuántos clientes respondieron en 72 horas, solo de las difusiones hechas desde el CRM.'],
];

const TYPES = [
  { name: 'Marketing', status: 'ok', desc: 'Promociones, nueva colección, descuentos, reactivar clientes que dejaron de escribir. Es la que más se usa en las difusiones y normalmente cuesta más por mensaje. Meta puede reclasificar como Marketing una plantilla de Utilidad que suene a promoción.' },
  { name: 'Utilidad', status: 'ok', desc: 'Mensajes sobre algo que el cliente ya pidió o hizo: confirmación de pedido, guía de envío, recordatorio de pago, cambio de talla. Normalmente cuesta menos que Marketing. No debe llevar promociones.' },
  { name: 'Autenticación', status: 'no', desc: 'Códigos de un solo uso (OTP) para verificar la identidad de alguien. Meta define el formato: el texto no se personaliza y el botón copia o autocompleta el código. Para una tienda de ropa casi no se usa.' },
];
const FORMATS = [
  ['Encabezado de imagen, video o documento (PDF)', 'ok'],
  ['Encabezado de texto con una variable', 'ok'],
  ['Pie de página', 'ok'],
  ['Botones de respuesta rápida, de enlace (dirección fija) y de llamada', 'ok'],
  ['Varios idiomas de una misma plantilla', 'ok'],
  ['Encabezado de ubicación', 'no'],
  ['Botón de enlace con variable (la parte final de la dirección cambia por cliente)', 'no'],
  ['Botón de copiar código de cupón', 'no'],
  ['Oferta por tiempo limitado (cuenta regresiva y cupón)', 'no'],
  ['Carrusel (varias tarjetas con imagen y botón)', 'no'],
  ['Plantillas de catálogo y de productos (uno o varios productos)', 'no'],
  ['Botón de WhatsApp Flows (formulario dentro del chat)', 'no'],
];

const STATUS = [
  ['Aprobada', 'Lista para usar en Difusión.', 'success'],
  ['En revisión', 'Meta la está revisando. No se puede editar ni usar todavía.', 'warning'],
  ['Rechazada', 'Meta no la aceptó; el motivo aparece en la tarjeta. Edítala y vuelve a enviarla.', 'danger'],
  ['Pausada', 'Meta la detuvo por un tiempo, normalmente porque los clientes reaccionaron mal (calidad baja). No se puede enviar mientras dure.', 'warning'],
  ['Deshabilitada', 'Meta la desactivó de forma más larga o definitiva por mala calidad repetida. Conviene crear una nueva con otro enfoque.', 'danger'],
  ['Marcada', 'Meta detectó un problema de calidad y puede pausarla si no mejora.', 'warning'],
  ['En apelación', 'Se pidió a Meta que revise de nuevo una decisión.', 'info'],
  ['Eliminándose', 'Meta está terminando de borrarla.', 'neutral'],
];
const QUALITY = [
  ['Calidad alta', 'Pocos clientes la bloquean o reportan. Sin riesgo.', 'success'],
  ['Calidad media', 'Empieza a haber reacciones negativas. Revisa el texto y la audiencia.', 'warning'],
  ['Calidad baja', 'Muchas reacciones negativas. Meta puede pausarla y limitar tus envíos. Deja de usarla o cámbiala.', 'danger'],
];
const COLOR = { success: 'bg-ok/10 text-ok', warning: 'bg-warn/10 text-warn', danger: 'bg-danger/10 text-danger', info: 'bg-accent-soft text-accent', neutral: 'bg-black/[0.06] text-greige-ink dark:bg-white/[0.1]' };

const Pill = ({ tone, children }) => <span className={`inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${COLOR[tone]}`}>{children}</span>;

export default function TemplatesHelp({ open, onClose }) {
  const [tab, setTab] = useState('how');
  return (
    <InfoModal open={open} onClose={onClose} title="Cómo funciona Plantillas" subtitle="Las plantillas son los mensajes que WhatsApp te deja enviar primero, o después de 24 horas sin que el cliente escriba.">
      <div className="mb-5 inline-flex flex-wrap rounded-xl border border-line bg-black/[0.03] p-1 dark:bg-white/[0.05]" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all ${tab === t.key ? 'bg-paper text-ink shadow-sm' : 'text-greige-ink hover:text-ink'}`}>{t.label}</button>
        ))}
      </div>

      {tab === 'how' && (
        <div className="grid gap-4">
          <ol className="grid gap-3">
            {STEPS.map(([title, text], i) => (
              <li key={title} className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-accent">{i + 1}</span>
                <div><p className="text-sm font-semibold text-ink">{title}</p><p className="text-sm leading-relaxed text-greige-ink">{text}</p></div>
              </li>
            ))}
          </ol>
          <div className="rounded-xl border border-line bg-black/[0.02] p-4 text-sm leading-relaxed text-greige-ink dark:bg-white/[0.03]">
            <p className="mb-1 font-semibold text-ink">Para que Meta las apruebe</p>
            Escribe un texto claro y específico, sin promesas engañosas, sin MAYÚSCULAS en exceso y sin enlaces acortados. Da ejemplos reales en las variables. Una plantilla que parece promoción pero se manda como Utilidad suele ser reclasificada a Marketing o rechazada.
          </div>
          <p className="text-xs text-greige">Pueden gestionarla administradores y supervisores. Crear, editar y eliminar afecta a toda la cuenta de Meta de esa línea y queda registrado en Auditoría.</p>
        </div>
      )}

      {tab === 'types' && (
        <div className="grid gap-5">
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-greige">Las tres categorías de WhatsApp</p>
            <div className="grid gap-3">
              {TYPES.map((t) => (
                <div key={t.name} className="rounded-xl border border-line p-4">
                  <div className="mb-1 flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-ink">{t.name}</p><Pill tone={t.status === 'ok' ? 'success' : 'neutral'}>{t.status === 'ok' ? 'Se crea desde el CRM' : 'Aún no se crea desde el CRM'}</Pill></div>
                  <p className="text-sm leading-relaxed text-greige-ink">{t.desc}</p>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-greige">Formatos dentro de Marketing y Utilidad</p>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {FORMATS.map(([label, st]) => (
                <li key={label} className="flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink">
                  <span className={`mt-0.5 shrink-0 text-xs font-bold ${st === 'ok' ? 'text-ok' : 'text-greige'}`}>{st === 'ok' ? '✓' : '—'}</span>
                  <span className={st === 'ok' ? '' : 'text-greige-ink'}>{label}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-greige">✓ se puede crear y enviar desde el CRM · — existe en Meta pero todavía no está en el CRM; por ahora se crea en el Administrador de WhatsApp de Meta. Meta agrega formatos con frecuencia.</p>
          </div>
        </div>
      )}

      {tab === 'status' && (
        <div className="grid gap-5">
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-greige">Estado</p>
            <ul className="grid gap-2">{STATUS.map(([name, text, tone]) => <li key={name} className="flex items-start gap-3 text-sm"><Pill tone={tone}>{name}</Pill><span className="leading-relaxed text-greige-ink">{text}</span></li>)}</ul>
          </div>
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-greige">Calidad</p>
            <ul className="grid gap-2">{QUALITY.map(([name, text, tone]) => <li key={name} className="flex items-start gap-3 text-sm"><Pill tone={tone}>{name}</Pill><span className="leading-relaxed text-greige-ink">{text}</span></li>)}</ul>
            <p className="mt-2 text-xs text-greige">La calidad la calcula Meta según cómo reaccionan los clientes (bloqueos y reportes). Una plantilla nueva aparece sin calidad hasta que se ha enviado lo suficiente.</p>
          </div>
        </div>
      )}
    </InfoModal>
  );
}
