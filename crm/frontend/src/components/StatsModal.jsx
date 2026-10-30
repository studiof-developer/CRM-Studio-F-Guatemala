import { Fragment, createContext, useContext, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend, DoughnutController, ArcElement } from 'chart.js';
import { X, Loader2, Calendar, Mail, Download, MessagesSquare, UserPlus, Repeat, Target, ShoppingBag, Wallet, Percent, TrendingUp, CircleDollarSign, CheckCircle2, Clock, LayoutGrid, List, Globe } from 'lucide-react';
import { ChannelIcon } from '../lib/channelIcons.jsx';
import * as XLSX from 'xlsx';
import { fetchPipelineStats, fetchPipelineStatsCosts, fetchPipelineStatsAdvisors, fetchMetaAdsReport } from '../api.js';
import { showError } from './Toast.jsx';
import Select from './Select.jsx';
import { PERIOD_OPTIONS, guatemalaToday, addDays, monthBounds, MONTH_NAMES, guatemalaMidnight, useDayCutoffs } from '../lib/pipelinePeriod.js';
import { DEFAULT_COLUMN_META, PIPELINE_ICON_MAP, PIPELINE_COLOR_CLASSES } from '../lib/pipelineColumns.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend, DoughnutController, ArcElement);

function useChart(canvasRef, buildConfig, deps) {
  useEffect(() => {
    if (!canvasRef.current) return;
    Chart.getChart(canvasRef.current)?.destroy();
    const chart = new Chart(canvasRef.current, buildConfig());
    return () => chart.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function formatMinutes(m) {
  if (m === null) return 'Sin datos';
  if (m < 60) return `${m} min`;
  return `${(m / 60).toFixed(1)} h`;
}

// Meta's own pricing_category values, confirmed against Studio F's WABA (MARKETING,
// SERVICE) plus the two other billable categories the docs list — shown as whatever
// Meta actually sends if a new one ever shows up, rather than hiding it.
const PRICING_CATEGORY_LABELS = { MARKETING: 'Marketing', UTILITY: 'Utilidad', AUTHENTICATION: 'Autenticación', SERVICE: 'Servicio (gratis)', AI_BOT: 'Bot IA' };

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('es-GT', { style: 'currency', currency }).format(amount);
  } catch {
    // An unrecognized/unusual currency code from Meta shouldn't crash the whole popup —
    // falls back to a plain grouped number with the raw code appended.
    return `${new Intl.NumberFormat('es-GT').format(amount)} ${currency}`;
  }
}

// Moneda de lo que se muestra con dinero: Quetzales (por defecto), COP o USD. Los montos de pauta vienen en COP y las ventas en quetzales;
// el tipo de cambio Q→COP es el configurado y el del dólar el del día. Menos de 1.000 lleva dos decimales (un costo por mensaje de Q 4,46 no se redondea a Q 4).
function makeMoney(cur, usdCop, fx) {
  const fromCop = (cop) => (cur === 'COP' ? cop : cur === 'Q' ? cop / fx : cop / usdCop);
  const prefix = cur === 'Q' ? 'Q' : cur;
  const fmt = (n) => {
    const v = Math.abs(n);
    const dec = v < 1000 ? 2 : 0;
    return `${prefix} ${n.toLocaleString(cur === 'USD' ? 'en-US' : 'es-GT', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
  };
  const out = (cop) => fmt(fromCop(cop ?? 0));
  const short = out; // antes abreviaba ("3.66 M"); se confundía con 3,066,000: ahora siempre el número completo
  return {
    cur, cop: out, short, q: (quetzales) => out((quetzales ?? 0) * fx), qShort: (quetzales) => short((quetzales ?? 0) * fx),
    acct: (n, currency) => (currency && currency !== 'COP' ? new Intl.NumberFormat('es-GT', { style: 'currency', currency }).format(n) : out(n)),
  };
}
const MoneyCtx = createContext(makeMoney('Q', 4000, 420));
const useMoney = () => useContext(MoneyCtx);

function metaFor(key) {
  const cfg = DEFAULT_COLUMN_META[key];
  return {
    label: cfg.label,
    icon: PIPELINE_ICON_MAP[cfg.icon],
    ...(PIPELINE_COLOR_CLASSES[cfg.color] ?? PIPELINE_COLOR_CLASSES.info),
  };
}

// Same visual card HandoffQueue.jsx's own stat strip uses — kept identical so this
// popup reads as "the same board, just showing everything" rather than a new UI.
function StatCard({ label, value, unit, iconBg, iconText, icon: Icon, sub }) {
  return (
    <div title={sub} className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-1.5 shadow-sm">
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${iconBg} ${iconText}`}>
        <Icon size={12} />
      </span>
      <span className="whitespace-nowrap text-lg font-semibold leading-none tracking-tight text-ink">{value}</span>
      <span className="whitespace-nowrap text-xs leading-none text-greige-ink">{label}</span>
      {unit && <span className="whitespace-nowrap text-xs leading-none text-muted-foreground">{unit}</span>}
    </div>
  );
}

const PIE_COLORS = ['#4338ca', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6'];
const money0 = (n) => Math.round(n).toLocaleString('es-GT');

// Atención y ventas por asesora en el periodo. Conversión = ventas de la asesora ÷ conversaciones que atendió. Al abrir una asesora se ve su día por día.
function AdvisorTable({ adv }) {
  const [open, setOpen] = useState(null);
  if (!adv) return <div className="flex justify-center py-4"><Loader2 size={16} className="animate-spin text-muted-foreground" /></div>;
  if (adv.failed) return <p className="text-xs text-danger">No se pudo cargar la atención por asesora.</p>;
  if (!adv.advisors.length) return <p className="text-xs text-muted-foreground">Sin atención ni ventas de asesoras en este periodo.</p>;
  const tot = adv.advisors.reduce((t, a) => ({ c: t.c + a.conversations, s: t.s + a.sales, v: t.v + a.salesAmount }), { c: 0, s: 0, v: 0 });
  const th = 'px-3 py-2 text-right font-semibold';
  return (
    <div className="max-h-72 overflow-auto rounded-xl border border-line">
      <table className="w-full min-w-[760px] text-xs">
        <thead className="sticky top-0 bg-paper uppercase tracking-wide text-greige-ink">
          <tr><th className="px-3 py-2 text-left font-semibold">Asesora (toca para ver por día)</th><th className={th}>Conversaciones atendidas</th><th className={th}>Ventas</th><th className={th}>Valor (Q)</th><th className={th}>Valor (COP)</th><th className={th}>Conversión</th></tr>
        </thead>
        <tbody>
          {adv.advisors.map((a) => (
            <Fragment key={a.advisor}>
              <tr onClick={() => setOpen(open === a.advisor ? null : a.advisor)} className="cursor-pointer border-t border-line-soft tabular-nums hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
                <td className="px-3 py-1.5 text-left text-ink"><span className="mr-1.5 inline-block w-3 text-greige-ink">{open === a.advisor ? '▾' : '▸'}</span>{a.advisor}</td>
                <td className="px-3 py-1.5 text-right">{a.conversations}</td>
                <td className="px-3 py-1.5 text-right font-semibold text-ink">{a.sales}</td><td className="px-3 py-1.5 text-right">{money0(a.salesAmount)}</td>
                <td className="px-3 py-1.5 text-right text-greige-ink">{money0(a.salesAmount * adv.fxQtoCop)}</td><td className="px-3 py-1.5 text-right text-greige-ink">{pctText(a.conversionRate)}</td>
              </tr>
              {open === a.advisor && adv.daily.filter((d) => d.advisor === a.advisor).map((d) => (
                <tr key={d.day} className="bg-black/[0.025] tabular-nums text-greige-ink dark:bg-white/[0.03]">
                  <td className="py-1 pl-9 pr-3 text-left">{d.day.slice(8)}/{d.day.slice(5, 7)}</td><td className="px-3 py-1 text-right">{d.conversations}</td><td className="px-3 py-1 text-right">{d.sales}</td>
                  <td className="px-3 py-1 text-right">{money0(d.salesAmount)}</td><td className="px-3 py-1 text-right">{money0(d.salesAmount * adv.fxQtoCop)}</td><td className="px-3 py-1 text-right">{pctText(d.conversations > 0 ? d.sales / d.conversations : null)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-black/[0.03] font-bold tabular-nums text-ink dark:bg-white/[0.04]">
            <td className="px-3 py-2 text-left">Total</td><td className="px-3 py-2 text-right">{tot.c}</td><td className="px-3 py-2 text-right">{tot.s}</td>
            <td className="px-3 py-2 text-right">{money0(tot.v)}</td><td className="px-3 py-2 text-right">{money0(tot.v * adv.fxQtoCop)}</td><td className="px-3 py-2 text-right">{pctText(tot.c > 0 ? tot.s / tot.c : null)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// Excel gerencial: el mismo formato de la hoja del trafficker, con la pauta de Meta (filtro de campaña activo) y lo que atendió el CRM.
async function downloadExcel({ data, adv, dateFrom, dateTo, line }) {
  try {
    let meta = [];
    try { meta = (await fetchMetaAdsReport({ since: dateFrom, until: dateTo, level: 'campaign' })).daily ?? []; } catch { /* sin Meta: esas columnas salen vacías */ }
    const metaBy = Object.fromEntries(meta.map((d) => [d.date, d]));
    const fx = adv?.fxQtoCop ?? 420;
    // Formato del trafficker: WhatsApp = conversaciones por anuncio (Meta), más Instagram, Messenger y respuestas a difusión; el total no cuenta el orgánico de WhatsApp.
    const rows = data.dailyConversations.map((d) => {
      const x = metaBy[d.day];
      const wa = x?.conversations ?? d.ads;
      const total = wa + d.social + d.broadcast;
      return {
        Fecha: d.day, Clics: x?.linkClicks ?? '', 'Costo por clic': x?.cpc ?? '', CTR: x?.ctr != null ? x.ctr / 100 : '', '% conversión': x?.conversionPct != null ? x.conversionPct / 100 : '',
        WhatsApp: wa, 'Costo por mensaje': x?.costPerConversation ?? '', Inversión: x?.spend ?? '',
        'Difusiones enviadas': d.broadcastSent, Leídos: d.broadcastRead, '% tasa de lectura': d.broadcastSent > 0 ? d.broadcastRead / d.broadcastSent : 0, 'Respuestas de difusiones': d.broadcast,
        Instagram: d.instagram, Messenger: d.messenger, 'Total de todos los canales': total,
        Ventas: d.sales, 'Valor en ventas (Q)': d.salesAmount, 'Valor en ventas (COP)': d.salesAmount * fx, 'Tasa de cierre': total > 0 ? d.sales / total : 0, ROAS: x?.spend > 0 ? (d.salesAmount * fx) / x.spend : '',
        'WhatsApp por anuncio (CRM)': d.ads, 'WhatsApp orgánico (CRM, fuera del total)': d.organic,
      };
    });
    const sumK = (k) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
    const spend = sumK('Inversión'); const cop = sumK('Valor en ventas (COP)'); const totalAll = sumK('Total de todos los canales'); const ventas = sumK('Ventas');
    rows.push({ Fecha: 'Total', Clics: sumK('Clics'), WhatsApp: sumK('WhatsApp'), Inversión: spend, 'Difusiones enviadas': sumK('Difusiones enviadas'), Leídos: sumK('Leídos'), 'Respuestas de difusiones': sumK('Respuestas de difusiones'),
      Instagram: sumK('Instagram'), Messenger: sumK('Messenger'), 'Total de todos los canales': totalAll, Ventas: ventas, 'Valor en ventas (Q)': sumK('Valor en ventas (Q)'), 'Valor en ventas (COP)': cop,
      'Tasa de cierre': totalAll > 0 ? ventas / totalAll : 0, ROAS: spend > 0 ? cop / spend : '',
      'WhatsApp por anuncio (CRM)': sumK('WhatsApp por anuncio (CRM)'), 'WhatsApp orgánico (CRM, fuera del total)': sumK('WhatsApp orgánico (CRM, fuera del total)') });
    const byAdvisor = (adv?.daily ?? []).map((r) => ({ Fecha: r.day, Asesora: r.advisor, 'Conversaciones atendidas': r.conversations, Ventas: r.sales, 'Valor (Q)': r.salesAmount, 'Valor (COP)': r.salesAmount * fx,
      Conversión: r.conversations > 0 ? r.sales / r.conversations : '' }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Gerencial');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byAdvisor.length ? byAdvisor : [{ Aviso: 'Sin datos de asesoras en el periodo' }]), 'Por asesora y día');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ Periodo: `${dateFrom} a ${dateTo}`, Línea: line || 'Todas', 'Tipo de cambio Q→COP': fx, Nota: 'Pauta (clics, costo, inversión, mensajes Meta) = Meta con el filtro de campaña del Informe de anuncios. Lo demás = CRM.' }]), 'Notas');
    XLSX.writeFile(wb, `estadisticas-${dateFrom}_${dateTo}.xlsx`);
  } catch (err) { showError(err.message || 'No se pudo generar el Excel'); }
}

// Resumen en iconos y colores: cuántos escribieron, por qué canal, de dónde vinieron y cómo cerraron. Las explicaciones largas quedan en el texto que sale al pasar el mouse.
const ORIGINS = [['ads', 'Anuncios', '#4338ca'], ['broadcast', 'Difusión', '#f59e0b'], ['organic', 'Orgánico', '#10b981'], ['social', 'Redes', '#ec4899']];

// Ayuda que aparece al pasar el mouse (o con el teclado): qué es la cifra y, cuando aplica, el valor ideal para un negocio como Studio F.
function Hint({ h, align = 'left', up = false, className = '', children }) {
  if (!h) return <div className={className}>{children}</div>;
  return (
    <div tabIndex={0} className={`group relative outline-none ${className}`}>
      {children}
      <div role="tooltip" className={`pointer-events-none absolute z-[60] hidden w-72 rounded-xl border border-line bg-paper p-3 text-left text-xs font-normal normal-case tracking-normal text-ink shadow-xl group-hover:block group-focus-within:block ${up ? 'bottom-full mb-2' : 'top-full mt-2'} ${align === 'right' ? 'right-0' : 'left-0'}`}>
        <p className="mb-1 text-[13px] font-semibold">{h.t}</p>
        <p className="leading-snug text-greige-ink">{h.d}</p>
        {h.i && <p className="mt-2 rounded-lg bg-accent-soft px-2 py-1.5 leading-snug text-accent"><b>Ideal:</b> {h.i}</p>}
      </div>
    </div>
  );
}

// Referencias para un negocio como Studio F (ropa por WhatsApp con anuncios de mensajes). Son guías generales: ajústalas con el historial propio.
const HINTS = {
  sales: { t: 'Ventas', d: 'Dinero de las ventas confirmadas en el periodo (las del reporte de ventas). El ticket es lo que gasta en promedio cada cliente que compra.', i: 'No hay una cifra fija: compáralo con el mismo periodo anterior. Si el ticket sube, cada cliente deja más.' },
  spend: { t: 'Inversión en pauta', d: 'Lo que Meta cobró por los anuncios que traen mensajes (campañas filtradas por nombre, igual que el Informe de anuncios).', i: 'Debe moverse junto con las ventas: si sube la inversión y no suben las ventas, algo falla en el anuncio o en el cierre.' },
  roas: { t: 'ROAS (retorno de la pauta)', d: 'Cuánto dinero se vendió por cada peso invertido en pauta: ventas ÷ inversión. Un 11 significa que por cada $1 invertido se vendieron $11. "Solo ventas de anuncios" cuenta únicamente a clientes que llegaron por un anuncio.', i: 'Meta de Studio F: 10 o más. Mínimo para no perder: 1 ÷ margen (con margen de 50 %, un ROAS de 2). Un solo día varía mucho: léelo en semana o mes.' },
  cpm: { t: 'Costo por mensaje', d: 'Lo que cuesta que una persona escriba por un anuncio (costo por resultado de Meta). Se calcula sobre los mensajes que Meta cuenta como iniciados.', i: 'Bueno: hasta COP 1,200 (unos Q 2.90). Aceptable: hasta COP 2,500 (Q 6). Más de eso es caro y conviene revisar el anuncio.' },
  cierre: { t: 'Cierre', d: 'De cada 100 conversaciones del total gerencial (anuncios + difusión + Instagram + Messenger), cuántas terminan en venta: ventas ÷ total gerencial.', i: 'Referencia para ropa por WhatsApp con anuncios: 3 % a 5 %. Por debajo de 2 % se escribe mucho pero se cierra poco: revisar seguimiento y cotizaciones. Octubre cerró cerca de 2.5 %.' },
  conv: { t: 'Conversaciones', d: 'Personas que escribieron cada día, sumadas día por día (como lo cuenta Meta). Un cliente que escribe en dos días distintos cuenta dos veces; "clientes distintos" lo cuenta una sola.' },
  channels: { t: 'Por dónde escribieron', d: 'WhatsApp, Instagram o Messenger. WhatsApp incluye a quienes llegaron por anuncios, difusiones o por su cuenta. Las tres cifras suman el total de conversaciones.' },
  origin: { t: '¿De dónde llegaron?', d: 'Anuncios: llegaron por un anuncio de Meta. Difusión: respondieron a un envío masivo en las 24 horas siguientes. Orgánico: escribieron por su cuenta en WhatsApp. Redes: llegaron por Instagram o Messenger.', i: 'Con pauta activa, "Anuncios" debe ser la mayor parte. Si el orgánico crece solo, la marca está generando recordación.' },
  adsFrom: { t: 'Anuncios por red', d: 'De los clientes que llegaron por anuncio (los mismos de "Anuncios"), cuántos hicieron clic en un anuncio de Facebook y cuántos en uno de Instagram. Siempre suma lo mismo que Anuncios.' },
  seen: { t: 'Anuncios según Meta', d: 'Dato de Meta, aparte del CRM: en qué plataforma se mostró el anuncio que trajo el mensaje. Todos terminan en WhatsApp, por eso no se suman al canal ni al origen.' },
  manager: { t: 'Total gerencial', d: 'Anuncios de WhatsApp + respuestas a difusión + Instagram + Messenger. No cuenta el orgánico de WhatsApp. Es la base del cierre y la que usa el trafficker en su reporte.' },
  wait: { t: 'Demora en responder', d: 'Tiempo promedio que tarda una asesora en dar la primera respuesta a un cliente que escribe.', i: 'Ideal: 5 a 10 minutos. Aceptable hasta 30. Pasada 1 hora, el Pipeline marca el chat como "atrasado".' },
  fresh: { t: 'Nuevos', d: 'Clientes que escriben por primera vez en el periodo.', i: 'Con pauta activa deben crecer cuando sube la inversión; si no crecen, el anuncio no está atrayendo gente nueva.' },
  back: { t: 'Recurrentes', d: 'Clientes que ya habían escrito antes y vuelven.', i: 'Un buen número de recurrentes indica seguimiento y confianza; ayudan a vender sin pagar anuncio.' },
  unread: { t: 'Sin leer', d: 'Chats con mensajes del cliente que nadie ha abierto. Sigue el modo del embudo (Ahora o Del periodo).', i: 'Ideal: 0 al terminar el turno.' },
  pending: { t: 'Sin atender', d: 'Clientes que escribieron y ninguna asesora ha tomado todavía. Sigue el modo del embudo (Ahora o Del periodo).', i: 'Ideal: 0 al cerrar el día.' },
  cac: (pct) => ({ t: 'Costo por venta', d: 'Cuánto se invirtió en pauta por cada venta que vino de un anuncio: inversión ÷ ventas de anuncios.', i: `Que no pase del 15 % al 20 % del ticket promedio. ${pct != null ? `En este periodo equivale al ${pct.toFixed(1)} % del ticket.` : ''}` }),
  net: { t: 'Tras pauta', d: 'Lo vendido menos lo invertido en pauta, antes de descontar el costo de las prendas. Todavía no es ganancia.', i: 'Cuanto más alto el porcentaje, mejor; para ver la ganancia real hay que definir el margen bruto.' },
  adSales: { t: 'Ventas de anuncios', d: 'Valor de las ventas de clientes que llegaron por un anuncio. Es la parte de las ventas que la pauta realmente generó.', i: 'Compáralo con "Ventas": si es casi igual, casi todo lo vendido viene de la pauta.' },
  waCost: { t: 'Gasto acumulado de WhatsApp', d: 'Lo que cobra WhatsApp por los mensajes de plantilla (difusiones y avisos). No es gasto en pauta.', i: 'Referencia: mantenerlo por debajo del 3 % de lo vendido.' },
  waMsgs: { t: 'Mensajes cobrados', d: 'Mensajes de plantilla que WhatsApp cobró en el periodo. Las respuestas normales dentro de las 24 horas son gratis.' },
  sellers: { t: 'Ventas por asesora', d: 'Valor vendido por cada asesora en el periodo y su parte del total. Sirve para ver cómo se reparte el cierre.' },
  funnel: { t: 'Embudo de ventas', d: 'Dónde está cada cliente: Frío (conversando), Tibio (ya se le cotizó), Caliente (ya tiene el medio de pago), Pagado y Por despacho. "Ahora" es todo lo que hay hoy en cada etapa (el "Todo" del Pipeline); "Del periodo" es lo que se movió en el periodo elegido. El punto rojo son los no leídos.', i: 'Un embudo sano baja de Frío a Tibio a Caliente. Mucho Tibio y poco Caliente = falta cerrar.' },
  stages: {
    pendiente: { t: 'No atendidos', d: 'Clientes que escribieron y ninguna asesora ha tomado.', i: '0 al cerrar el día.' },
    en_atencion: { t: 'Frío (en conversación)', d: 'Clientes que están hablando con una asesora pero todavía sin cotización.' },
    cotizacion: { t: 'Tibio (cotización)', d: 'Clientes a quienes ya se les dio precio o cotización.', i: 'Si se acumulan, falta darles seguimiento para pasarlos a Caliente.' },
    medio_pago: { t: 'Caliente (medio de pago)', d: 'Clientes a quienes ya se les dio cómo pagar. Están a un paso de comprar.', i: 'Son los que hay que perseguir hoy: cada uno es una venta casi hecha.' },
    pagado: { t: 'Pagado', d: 'Clientes que mandaron su comprobante y siguen en esta etapa.', i: 'Pasan rápido a "Por despacho" cuando se prepara el pedido.' },
    despacho: { t: 'Por despacho', d: 'Pedidos pagados que se están preparando o enviando.' },
    pqrs: { t: 'PQRS', d: 'Peticiones, quejas y reclamos que requieren atención especial.', i: '0 pendientes sin resolver.' },
  },
};

function Tile({ icon: Icon, tone, value, label, title, big, hint, align, up }) {
  return (
    <Hint h={hint} align={align} up={up}>
      <div title={hint ? undefined : title} className="flex items-center gap-2 rounded-xl border border-line bg-paper px-2.5 py-2 shadow-sm">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${tone}`}><Icon size={14} /></span>
        <span className="min-w-0 flex-1 leading-tight"><span title={typeof value === 'string' ? value : undefined} className={`block truncate font-semibold tabular-nums text-ink ${String(value).length > 11 ? 'text-sm' : big ? 'text-xl' : 'text-base'}`}>{value}</span><span className="block truncate text-[11px] text-greige-ink">{label}</span></span>
      </div>
    </Hint>
  );
}


// Estados en cuadritos: ícono de la columna, cantidad y un punto rojo con los no leídos.
// En esta vista las tres columnas del medio llevan su nombre de temperatura (frío, tibio, caliente).
const TEMP_LABEL = { en_atencion: 'Frío', cotizacion: 'Tibio', medio_pago: 'Caliente' };

function StatesGrid({ buckets, align }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {buckets.map((b) => {
        const meta = metaFor(b.bucket);
        const Icon = meta.icon;
        return (
          <Hint key={b.bucket} h={HINTS.stages[b.bucket]} align={align}>
          <div className="relative flex items-center gap-2 rounded-xl border border-line bg-paper px-2.5 py-2 shadow-sm">
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${meta.iconBg} ${meta.iconText}`}><Icon size={14} /></span>
            <span className="min-w-0 leading-tight"><span className="block text-base font-semibold tabular-nums text-ink">{b.total}</span><span className="block truncate text-[11px] text-greige-ink">{TEMP_LABEL[b.bucket] ?? meta.label}</span></span>
            {b.unreadTotal > 0 && <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-bold text-white">{b.unreadTotal}</span>}
          </div>
          </Hint>
        );
      })}
    </div>
  );
}

// Costos en cuadritos; las explicaciones largas salen al pasar el mouse.
function CostsVisual({ costs, data, adv }) {
  const money = useMoney();
  if (!costs) return <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-muted-foreground" /></div>;
  const cc = costs.conversionCost; const mc = costs.messageCost;
  const fm = (n, cur) => (n == null ? '—' : money.acct(n, cur));
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink" title="Lo que Meta cuenta como resultado (conversaciones iniciadas) y lo que el CRM confirma como venta real. No tienen por qué coincidir.">Pauta{cc?.nameFilter ? ` · “${cc.nameFilter}”` : ''}</p>
        {cc ? (
          <div className="grid grid-cols-2 gap-2">
            <Tile icon={CircleDollarSign} tone="bg-danger/10 text-danger" value={fm(cc.spend, cc.currency)} label="Gasto en pauta" title="Igual que el Informe de anuncios (campañas filtradas por nombre)" />
            <Tile icon={MessagesSquare} tone="bg-info/10 text-info" value={cc.results} label="Conversaciones" title="Conversaciones iniciadas según Meta" />
            <Tile icon={Target} tone="bg-warning/10 text-warning" value={fm(cc.costPerResult, cc.currency)} label="Costo por mensaje" title="Lo que cuesta cada mensaje que llega por anuncio (costo por resultado de Meta)" />
            <Tile icon={CheckCircle2} tone="bg-success/10 text-success" value={cc.conversions} label="Pagados de pauta" title="Clientes que llegaron por anuncio y pagaron, confirmados en el CRM" />
            <Tile icon={Wallet} tone="bg-accent-soft text-accent" value={cc.costPerConversion != null ? fm(cc.costPerConversion, cc.currency) : 'Sin ventas'} label="Por venta" title="Gasto de pauta ÷ pagados de pauta" />
          </div>
        ) : costs.conversionCostError ? <p className="text-xs text-danger">No se pudo leer Meta Ads: {costs.conversionCostError}</p> : <p className="text-xs text-muted-foreground">Sin datos para este periodo.</p>}
      </div>
      {costs.byPlatform?.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink" title="Dónde se mostraron los anuncios que trajeron los mensajes (dato de Meta): el anuncio va a WhatsApp, pero se ve en Instagram, Facebook o Messenger">Pauta por plataforma</p>
          <div className="flex flex-col gap-1.5">
            {costs.byPlatform.map((p) => (
              <div key={p.platform} title={PLATFORM_HINT[p.platform] ?? `Mensajes y gasto de los anuncios mostrados en ${PLATFORMS[p.platform] ?? p.platform}. c/u es el costo por mensaje: la plataforma con menor c/u rinde más por peso.`} className="flex items-center gap-2.5 rounded-xl border border-line bg-paper px-2.5 py-2 shadow-sm">
                <PlatformMark platform={p.platform} />
                <span className="min-w-0 flex-1 leading-tight"><span className="block truncate text-xs font-medium text-ink">{PLATFORMS[p.platform] ?? p.platform}</span><span className="block text-[11px] text-greige-ink">{p.conversations} mensajes{p.costPerConversation != null ? ` · COP ${Math.round(p.costPerConversation).toLocaleString('es-GT')} c/u` : ''}</span></span>
                <b className="shrink-0 text-xs tabular-nums text-ink">{money.cop(p.spend)}</b>
              </div>
            ))}
          </div>
        </div>
      )}
      <Profitability data={data} costs={costs} adv={adv} />
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink" title="Lo que WhatsApp cobra por cada mensaje enviado: facturación de la plataforma, no gasto en pauta. Es de toda la cuenta de WhatsApp; no se separa por línea.">Mensajes de WhatsApp</p>
        {mc ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Tile icon={CircleDollarSign} tone="bg-danger/10 text-danger" value={fm(mc.totalCost, mc.currency)} label="Gasto acumulado" />
              <Tile icon={MessagesSquare} tone="bg-warning/10 text-warning" value={mc.billableVolume} label="Mensajes cobrados" />
              <Tile icon={Target} tone="bg-info/10 text-info" value={mc.avgCostPerMessage != null ? fm(mc.avgCostPerMessage, mc.currency) : '—'} label="Promedio por mensaje" />
            </div>
            {mc.byCategory.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {mc.byCategory.map((c) => <span key={c.category} className="rounded-lg border border-line bg-paper px-2 py-1 text-[11px] text-greige-ink">{PRICING_CATEGORY_LABELS[c.category] ?? c.category}: {c.volume} · {c.cost > 0 ? `${money.acct(c.costPerMessage, mc.currency)}/msg` : 'gratis'}</span>)}
              </div>
            )}
          </>
        ) : costs.messageCostError ? <p className="text-xs text-danger">No se pudo leer WhatsApp: {costs.messageCostError}</p> : <p className="text-xs text-muted-foreground">Sin datos para este periodo.</p>}
      </div>
    </div>
  );
}

// Vista detallada del resumen: la lista de siempre, con números y texto.
function SummaryDetail({ data, costs, adv }) {
  const money = useMoney();
  const c = data.conversations;
  const roas = costs?.conversionCost?.spend > 0 ? ((c.salesAmount * (adv?.fxQtoCop ?? 420)) / costs.conversionCost.spend).toFixed(2) : '…';
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface/50 p-2 text-[11px] text-greige-ink">
      <SumRow label="Conversaciones" value={c.conversations} strong />
      <SumRow label="Total gerencial" value={c.managerTotal} strong />
      <p className="text-[10px] leading-tight text-muted-foreground">Anuncios + difusión + Instagram + Messenger (sin orgánico de WhatsApp), como lo arma el trafficker.</p>
      <SumRow label="Clientes distintos" value={c.people} />
      <SumRow label="• Nuevos" value={c.newPeople} />
      <SumRow label="• Recurrentes" value={c.returning} />
      <p className="mt-1 border-t border-line/60 pt-1 font-medium uppercase tracking-wide">Por canal</p>
      <SumRow label="WhatsApp" value={c.byChannel.whatsapp} /><SumRow label="Instagram" value={c.byChannel.instagram} /><SumRow label="Messenger" value={c.byChannel.messenger} />
      <p className="mt-1 border-t border-line/60 pt-1 font-medium uppercase tracking-wide">Por origen</p>
      <SumRow label="Anuncios Meta" value={c.byOrigin.ads} purple />{c.byAdPlatform && <><SumRow label="• desde Facebook" value={c.byAdPlatform.facebook} /><SumRow label="• desde Instagram" value={c.byAdPlatform.instagram} /></>}<SumRow label="Respuesta a difusión" value={c.byOrigin.broadcast} />
      <SumRow label="Orgánico de WhatsApp" value={c.byOrigin.organic} /><SumRow label="Instagram y Messenger" value={c.byOrigin.social} />
      <p className="mt-1 border-t border-line/60 pt-1 font-medium uppercase tracking-wide">Cierre</p>
      <SumRow label="Ventas confirmadas" value={c.sales ?? '—'} strong /><SumRow label="Valor vendido" value={c.salesAmount ? money.q(c.salesAmount) : '—'} />
      <SumRow label="Tasa de cierre" value={pctText(c.closeRate)} /><SumRow label="ROAS" value={roas} />
      <p className="text-[10px] leading-tight text-muted-foreground">Ventas del reporte de ventas (suma de las asesoras de la línea elegida) ÷ total gerencial. ROAS = valor en COP ÷ inversión de pauta.</p>
    </div>
  );
}

// Ventas por asesora: dona con el valor vendido de cada una y, debajo, su ranking. Es lo mismo que el panel de ventas del Dashboard, aquí a la vista.
function SalesByAdvisor({ adv, sellers, pieRef, bare }) {
  const money = useMoney();
  if (!adv) return <div className="flex justify-center py-10"><Loader2 size={18} className="animate-spin text-muted-foreground" /></div>;
  const total = sellers.reduce((n, a) => n + a.salesAmount, 0);
  const count = sellers.reduce((n, a) => n + a.sales, 0);
  return (
    <div>
      {!bare && <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink" title="Valor vendido por cada asesora en el periodo elegido (ventas confirmadas del reporte de ventas)">Ventas por asesora</p>}
      {sellers.length === 0 ? <p className="rounded-xl border border-dashed border-line p-6 text-center text-xs text-greige-ink">Sin ventas confirmadas en este periodo.</p> : (
        <>
          <div className="relative mx-auto h-52 w-52">
            <canvas ref={pieRef} role="img" aria-label="Valor vendido por asesora" />
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center leading-tight"><span className={`font-bold tabular-nums text-ink ${money.q(total).length > 11 ? 'text-xs' : 'text-base'}`}>{money.q(total)}</span><span className="text-[11px] text-greige-ink">{count} ventas</span></div>
          </div>
          <ul className="mt-3 flex flex-col gap-1.5">
            {sellers.map((a, i) => (
              <li key={a.advisor} className="flex items-center gap-2 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs shadow-sm">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                <span className="min-w-0 flex-1 truncate font-medium text-ink" title={a.advisor}>{a.advisor}</span>
                <span className="shrink-0 text-right leading-tight"><b className="block tabular-nums text-ink">{money.q(a.salesAmount)}</b><span className="text-[10px] text-greige-ink">{a.sales} ventas · {Math.round((a.salesAmount / total) * 100)}%</span></span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted-foreground">Ticket promedio: {money.q(total / Math.max(count, 1))} por venta.</p>
        </>
      )}
    </div>
  );
}

// Logo y nombre de cada plataforma donde se mostró el anuncio.
const PLATFORMS = { instagram: 'Instagram', facebook: 'Facebook', messenger: 'Messenger', whatsapp: 'WhatsApp (Estados)', audience_network: 'Audience Network' };
const PLATFORM_HINT = { audience_network: 'Apps y sitios web de terceros donde Meta también muestra los anuncios', whatsapp: 'Anuncios mostrados en los Estados de WhatsApp' };
function PlatformMark({ platform, size = 22 }) {
  if (platform === 'instagram' || platform === 'messenger' || platform === 'whatsapp') return <ChannelIcon channel={platform} size={size} />;
  if (platform === 'facebook') return <span style={{ width: size, height: size }} className="flex items-center justify-center rounded-full bg-[#1877F2] text-[13px] font-bold leading-none text-white">f</span>;
  return <span style={{ width: size, height: size }} className="flex items-center justify-center rounded-full bg-black/10 text-greige-ink dark:bg-white/15"><Globe size={Math.round(size * 0.6)} /></span>;
}

// Rentabilidad: lo que queda después de pagar la pauta y, con el margen guardado, la ganancia estimada y el ROAS de equilibrio (el ROAS y el vendido ya están arriba).
function Profitability({ data, costs, adv }) {
  const money = useMoney();
  const spend = costs?.conversionCost?.spend;
  const fx = adv?.fxQtoCop ?? 420;
  const soldCop = (data.conversations.salesAmount ?? 0) * fx;
  if (!(spend > 0) || !(soldCop > 0)) return null;
  const left = soldCop - spend;
  const m = adv?.grossMarginPct;
  const profit = m ? soldCop * (m / 100) - spend : null;
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium text-greige-ink" title="Vendido menos lo invertido en pauta. Todavía no descuenta el costo de las prendas: eso lo hace la ganancia estimada, si el margen está definido.">Rentabilidad</p>
      <div className="grid grid-cols-1 gap-2">
        <Tile icon={TrendingUp} tone="bg-accent-soft text-accent" value={money.short(left)} label={`Tras pauta ${Math.round((left / soldCop) * 100)}%`} hint={HINTS.net} align="right" />
        {costs?.adSales?.amount > 0 && <Tile icon={ShoppingBag} tone="bg-purple/10 text-purple" value={money.qShort(costs.adSales.amount)} label={`Ventas anuncios · ${costs.adSales.count}`} hint={HINTS.adSales} align="right" />}
        {profit != null && <Tile icon={Wallet} tone={profit >= 0 ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'} value={money.short(profit)} label="Ganancia est." title={`${money.cop(profit)}: vendido × ${m}% de margen − pauta`} />}
        {m && <Tile icon={Target} tone="bg-warning/10 text-warning" value={(100 / m).toFixed(1)} label="ROAS equilibrio" title="Por debajo de este ROAS la pauta pierde dinero (1 ÷ margen)" />}
      </div>
      {!m && <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">Define el margen bruto para ver la ganancia estimada y el ROAS de equilibrio.</p>}
    </div>
  );
}

// Una cifra grande de la franja de arriba: la respuesta primero (cuánto se vendió, cuánto se gastó, qué regresó).
function Kpi({ icon: Icon, tone, label, value, sub, bar, barGood, title, hint, align }) {
  return (
    <Hint h={hint} align={align} className="min-w-0">
    <div title={hint ? undefined : title} className="flex min-w-0 flex-col gap-1 rounded-2xl border border-line bg-paper px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-medium text-greige-ink"><span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${tone}`}><Icon size={13} /></span><span className="truncate">{label}</span></div>
      <span className={`truncate font-bold tabular-nums leading-tight text-ink ${String(value).length > 13 ? 'text-xl' : 'text-2xl'}`}>{value}</span>
      {bar != null && <div className="h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10"><span className={`block h-full rounded-full ${barGood ? 'bg-success' : 'bg-accent'}`} style={{ width: `${Math.max(2, Math.min(100, bar * 100))}%` }} /></div>}
      <span className="truncate text-[11px] text-greige-ink">{sub}</span>
    </div>
    </Hint>
  );
}

function Panel({ title, hint, align, children }) {
  return (
    <section className="min-w-0 rounded-2xl border border-line bg-paper/60 p-4">
      <Hint h={hint && typeof hint === 'object' ? hint : null} align={align}><h4 className="mb-3 w-fit cursor-help text-xs font-semibold uppercase tracking-wide text-greige-ink" title={typeof hint === 'string' ? hint : undefined}>{title}</h4></Hint>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

// Atención: cuántos escribieron, por dónde, de dónde vinieron y qué tan rápido se les responde.
function AttentionPanel({ data, costs }) {
  const c = data.conversations;
  const orig = ORIGINS.map(([k, label, color]) => ({ k, label, color, n: c.byOrigin[k] ?? 0 }));
  const originTotal = orig.reduce((n, o) => n + o.n, 0);
  const unread = data.buckets.filter((b) => b.bucket !== 'pendiente').reduce((n, b) => n + b.unreadTotal, 0);
  const pending = data.buckets.find((b) => b.bucket === 'pendiente')?.total ?? 0;
  return (
    <>
      <Hint h={HINTS.conv}><div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><MessagesSquare size={22} /></span>
        <span className="leading-tight"><span className="block text-3xl font-bold tabular-nums text-ink">{c.conversations}</span><span className="block text-xs text-greige-ink">conversaciones · {c.people} clientes distintos</span></span>
      </div></Hint>
      <Hint h={HINTS.channels}><div>
        <p className="mb-1.5 text-[11px] font-medium text-greige-ink">Por dónde escribieron <span className="font-normal">(suma {c.conversations})</span></p>
        <div className="grid grid-cols-3 gap-2">
          {['whatsapp', 'instagram', 'messenger'].map((ch) => (
            <div key={ch} className="flex flex-col items-center gap-1 rounded-xl border border-line bg-paper py-2 shadow-sm"><ChannelIcon channel={ch} size={26} /><span className="text-lg font-bold tabular-nums leading-none text-ink">{c.byChannel[ch]}</span><span className="text-[10px] capitalize text-greige-ink">{ch}</span></div>
          ))}
        </div>
      </div></Hint>
      <Hint h={HINTS.origin}><div>
        <p className="mb-1.5 text-[11px] font-medium text-greige-ink">Cómo llegaron <span className="font-normal">(suma {originTotal}, las mismas {c.conversations})</span></p>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">{originTotal > 0 && orig.filter((o) => o.n > 0).map((o) => <span key={o.k} title={`${o.label}: ${o.n}`} style={{ width: `${(o.n / originTotal) * 100}%`, background: o.color }} />)}</div>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">{orig.map((o) => <span key={o.k} className="flex items-center gap-1.5 text-[11px] text-greige-ink"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: o.color }} /><span className="truncate">{o.label}</span><b className="ml-auto tabular-nums text-ink">{o.n}</b></span>)}</div>
        <p className="mt-1.5 text-[10px] leading-snug text-greige-ink">Los de WhatsApp ({c.byChannel.whatsapp}) son Anuncios + Difusión + Orgánico; los de Redes ({c.byChannel.instagram + c.byChannel.messenger}) son Instagram y Messenger.</p>
      </div></Hint>
      {c.byAdPlatform && c.byOrigin.ads > 0 && (
        <Hint h={HINTS.adsFrom}><div className="rounded-xl border border-line bg-paper p-2.5">
          <p className="mb-1.5 text-[11px] font-medium text-greige-ink">Anuncios: en qué red hicieron clic <span className="font-normal">(suma {c.byOrigin.ads}, los mismos Anuncios)</span></p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">{['facebook', 'instagram'].map((p) => <span key={p} className="flex items-center gap-1.5 text-xs"><PlatformMark platform={p} size={18} /><span className="text-greige-ink">{PLATFORMS[p]}</span><b className="tabular-nums text-ink">{c.byAdPlatform[p]}</b></span>)}</div>
          <p className="mt-1.5 text-[10px] leading-snug text-greige-ink">Cada anuncio se ve en Facebook o Instagram y el cliente termina escribiendo por WhatsApp. Se saca del enlace del anuncio que trae el chat.</p>
        </div></Hint>
      )}
      {costs?.byPlatform?.length > 0 && (
        <Hint h={HINTS.seen}><div className="rounded-xl border border-dashed border-line p-2.5">
          <p className="mb-1.5 text-[11px] font-medium text-greige-ink">Según Meta: dónde se vio el anuncio <span className="font-normal">(no se suma a lo de arriba)</span></p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">{costs.byPlatform.filter((p) => p.conversations > 0).map((p) => <span key={p.platform} className="flex items-center gap-1.5 text-xs"><PlatformMark platform={p.platform} size={18} /><b className="tabular-nums text-ink">{p.conversations}</b></span>)}</div>
          <p className="mt-1.5 text-[10px] leading-snug text-greige-ink">Son los mismos mensajes de anuncios que llegan a WhatsApp (ya están dentro de los {c.byChannel.whatsapp}), vistos por plataforma. Dato de Meta de toda la cuenta; puede diferir de "Anuncios" del CRM.</p>
        </div></Hint>
      )}
      <p className="text-[10px] leading-snug text-greige-ink">Sin leer y Sin atender muestran el embudo "{'Ahora'}" o "Del periodo" según lo que elijas en el embudo.</p>
      <div className="grid grid-cols-2 gap-2">
        <Tile icon={Target} tone="bg-accent text-white" value={c.managerTotal} label="Total gerencial" hint={HINTS.manager} />
        <Tile icon={Clock} tone="bg-warning/10 text-warning" value={formatMinutes(data.avgFirstResponseMinutes)} label="Demora" hint={HINTS.wait} />
        <Tile icon={UserPlus} tone="bg-success/10 text-success" value={c.newPeople} label="Nuevos" hint={HINTS.fresh} />
        <Tile icon={Repeat} tone="bg-info/10 text-info" value={c.returning} label="Recurrentes" hint={HINTS.back} />
        <Tile icon={Mail} tone="bg-warning/10 text-warning" value={unread} label="Sin leer" hint={HINTS.unread} up />
        <Tile icon={Clock} tone="bg-danger/10 text-danger" value={pending} label="Sin atender" hint={HINTS.pending} up />
      </div>
    </>
  );
}

// Pauta y rentabilidad: dónde se mostraron los anuncios, qué regresó cada peso y lo que cobra WhatsApp por los mensajes.
function PautaPanel({ data, costs, adv, line }) {
  const money = useMoney();
  if (!costs) return <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-muted-foreground" /></div>;
  const mc = costs.messageCost;
  return (
    <>
      {line && <p className="rounded-lg bg-warning/15 px-2.5 py-2 text-[11px] leading-snug text-warning">Meta no separa el gasto de pauta por línea: la inversión, el ROAS y los costos de esta sección son de toda la cuenta.</p>}
      {costs.byPlatform?.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-medium text-greige-ink" title="Dónde se mostraron los anuncios que trajeron los mensajes (dato de Meta)">Pauta por plataforma</p>
          <div className="flex flex-col gap-1.5">
            {costs.byPlatform.map((p) => (
              <div key={p.platform} className="flex items-center gap-2.5 rounded-xl border border-line bg-paper px-2.5 py-2 shadow-sm">
                <PlatformMark platform={p.platform} />
                <span className="min-w-0 flex-1 leading-tight"><span className="block truncate text-xs font-medium text-ink">{PLATFORMS[p.platform] ?? p.platform}</span><span className="block truncate text-[11px] text-greige-ink">{p.conversations} mensajes{p.costPerConversation != null ? ` · ${money.cop(p.costPerConversation)} c/u` : ''}</span></span>
                <b className="shrink-0 text-xs tabular-nums text-ink" title={money.cop(p.spend)}>{money.short(p.spend)}</b>
              </div>
            ))}
          </div>
        </div>
      )}
      <Profitability data={data} costs={costs} adv={adv} />
      <div>
        <p className="mb-1.5 text-[11px] font-medium text-greige-ink" title="Lo que WhatsApp cobra por cada mensaje enviado: facturación de la plataforma, no gasto en pauta. Es de toda la cuenta de WhatsApp.">Mensajes de WhatsApp (lo que cobra la plataforma)</p>
        {mc ? (
          <div className="grid grid-cols-2 gap-2">
            <Tile icon={CircleDollarSign} tone="bg-danger/10 text-danger" value={money.acct(mc.totalCost, mc.currency)} label="Gasto acumulado" hint={HINTS.waCost} align="right" up />
            <Tile icon={MessagesSquare} tone="bg-warning/10 text-warning" value={mc.billableVolume} label="Mensajes cobrados" hint={HINTS.waMsgs} align="right" up />
          </div>
        ) : costs.messageCostError ? <p className="text-xs text-danger">No se pudo leer WhatsApp: {costs.messageCostError}</p> : <p className="text-xs text-muted-foreground">Sin datos para este periodo.</p>}
      </div>
    </>
  );
}

// Vista de gerencia: primero el resultado (ventas, inversión, retorno), después el detalle en cuatro bloques.
function ManagerView({ data, costs, adv, sellers, pieRef, line, funnelPeriod, funnelMode, setFunnelMode }) {
  const money = useMoney();
  const c = data.conversations;
  const cc = costs?.conversionCost;
  const fx = adv?.fxQtoCop ?? 420;
  const goal = adv?.roasGoal ?? 10;
  const spend = cc?.spend;
  const roas = spend > 0 ? (c.salesAmount * fx) / spend : null;
  const roasAds = spend > 0 && costs?.adSales?.amount > 0 ? (costs.adSales.amount * fx) / spend : null;
  const adCount = costs?.adSales?.count;
  const cac = spend > 0 ? (adCount > 0 ? spend / adCount : cc?.costPerConversation) : null;
  const wait = costs ? '—' : '…';
  return (
    <div className="mt-5 flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi icon={ShoppingBag} tone="bg-success/10 text-success" label="Ventas" value={money.qShort(c.salesAmount)} sub={`${c.sales ?? 0} ventas · ticket ${money.qShort((c.salesAmount ?? 0) / Math.max(c.sales ?? 0, 1))}`} hint={HINTS.sales} />
        <Kpi icon={CircleDollarSign} tone="bg-danger/10 text-danger" label="Inversión en pauta" value={spend != null ? money.short(spend) : wait} sub={cc ? `${cc.results} mensajes de anuncios` : ' '} hint={HINTS.spend} />
        <Kpi icon={TrendingUp} tone="bg-accent-soft text-accent" label={`ROAS · meta ${goal}`} value={roas != null ? roas.toFixed(2) : wait} bar={roas != null ? roas / goal : null} barGood={roas >= goal} sub={roasAds != null ? `Solo ventas de anuncios: ${roasAds.toFixed(2)}` : 'Vendido ÷ inversión'} hint={HINTS.roas} />
        <Kpi icon={MessagesSquare} tone="bg-warning/10 text-warning" label="Costo por mensaje" value={cc?.costPerResult != null ? money.cop(cc.costPerResult) : wait} sub="cada mensaje que llega por anuncio" hint={HINTS.cpm} align="right" />
        <Kpi icon={Wallet} tone="bg-purple/10 text-purple" label="Costo por venta" value={cac != null ? money.short(cac) : wait} sub={adCount > 0 ? `${adCount} ventas de anuncios` : 'pauta ÷ ventas'} hint={HINTS.cac(cac != null && c.sales > 0 && c.salesAmount > 0 ? (cac / ((c.salesAmount * fx) / c.sales)) * 100 : null)} align="right" />
        <Kpi icon={Percent} tone="bg-accent-soft text-accent" label="Cierre" value={pctText(c.closeRate)} sub={`${c.sales ?? 0} ventas de ${c.managerTotal} conversaciones`} hint={HINTS.cierre} align="right" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Panel title="Atención" hint={{ t: 'Atención', d: 'Cuántas personas escribieron, por qué canal, de dónde llegaron y qué tan rápido se les responde.' }}><AttentionPanel data={data} costs={costs} /></Panel>
        <Panel title="Embudo de ventas" hint={HINTS.funnel} legacyHint="Los mismos números que las columnas del Pipeline para este periodo. Frío, tibio y caliente son las etapas de conversación; el punto rojo son los no leídos. Hoy cuenta desde el último mensaje de las asesoras de ayer; Ayer, lo que se trabajó esa jornada (lo que quedó pendiente al cerrar el turno cuenta como de hoy)."><div role="group" aria-label="Qué cuenta el embudo" className="flex w-fit rounded-lg border border-line bg-paper p-0.5 text-[11px] font-medium">
            {[['now', 'Ahora'], ['period', 'Del periodo']].map(([k, l]) => <button key={k} type="button" onClick={() => setFunnelMode(k)} aria-pressed={funnelMode === k} className={`rounded-md px-2.5 py-1 transition-colors ${funnelMode === k ? 'bg-accent text-white' : 'text-greige-ink hover:text-ink'}`}>{l}</button>)}
          </div>
          <StatesGrid buckets={data.buckets} /><p className="text-[10px] leading-snug text-muted-foreground">{funnelMode === 'now' ? funnelPeriod : `Periodo: ${funnelPeriod}`}. Pon el Pipeline en el mismo periodo y la misma línea para comparar: deben coincidir.</p></Panel>
        <Panel title="Pauta y rentabilidad" align="right" hint={{ t: 'Pauta y rentabilidad', d: 'Dónde se mostraron los anuncios, cuánto costó cada mensaje en cada plataforma y qué regresó la inversión.' }}><PautaPanel data={data} costs={costs} adv={adv} line={line} /></Panel>
        <Panel title="Ventas por asesora" align="right" hint={HINTS.sellers}><SalesByAdvisor adv={adv} sellers={sellers} pieRef={pieRef} bare /></Panel>
      </div>
    </div>
  );
}

function SumRow({ label, value, strong, purple }) {
  return (
    <div className={`flex items-center justify-between ${purple ? 'text-purple-600 dark:text-purple-400' : ''}`}>
      <span>{label}</span>
      <span className={`${strong || purple ? 'font-bold' : 'font-semibold'} ${purple ? '' : strong ? 'text-accent' : 'text-ink'}`}>{value}</span>
    </div>
  );
}

// Tabla gerencial día por día: la pauta de Meta (Informe de anuncios, mismo filtro de campañas) junto a lo que el CRM atendió y vendió.
// Una sola pasada: Total gerencial = anuncios de WhatsApp + respuestas a difusión + Instagram + Messenger (sin orgánico de WhatsApp).
function DailyTable({ rows, ads, fx }) {
  const loading = ads === null;
  const metaBy = Object.fromEntries((ads?.daily ?? []).map((d) => [d.date, d]));
  // Un solo día: Meta no manda serie diaria, el total del periodo es ese día.
  const metaOf = (day) => (rows.length === 1 ? ads?.totals : metaBy[day]) ?? null;
  const sum = (k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
  const T = ads?.totals;
  const spendSum = rows.reduce((n, r) => n + (metaOf(r.day)?.spend ?? 0), 0);
  const money = (n) => (n == null ? '—' : Math.round(n).toLocaleString('es-GT'));
  const meta = (v, fmt = (x) => x) => (loading ? '…' : v == null ? '—' : fmt(v));
  const pct1 = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
  const copOf = (r) => (r.salesAmount ?? 0) * fx;
  const roas = (r) => { const sp = metaOf(r.day)?.spend; return sp > 0 ? (copOf(r) / sp).toFixed(2) : '—'; };
  const th = 'whitespace-nowrap px-3 py-2 text-right font-semibold';
  const td = 'px-3 py-1.5 text-right';
  const tf = 'px-3 py-2 text-right';
  const totalRoas = spendSum > 0 ? ((sum('salesAmount') * fx) / spendSum).toFixed(2) : '—';
  return (
    <div className="rounded-xl border border-line">
      <div className="max-h-80 overflow-auto">
      <table className="w-full min-w-[1900px] text-xs">
        <thead className="sticky top-0 z-10 bg-paper uppercase tracking-wide text-greige-ink">
          <tr>
            <th className="sticky left-0 bg-paper px-3 py-2 text-left font-semibold">Día</th><th className={th}>Conversaciones</th>
            <th className={th}>Clics</th><th className={th}>CPC</th><th className={th}>CTR</th><th className={th}>% conv. pauta</th><th className={th}>Mensajes Meta</th><th className={th}>Inversión</th>
            <th className={th}>Difusiones enviadas</th><th className={th}>Leídos</th><th className={th}>% lectura</th><th className={th}>Resp. difusión</th>
            <th className={th}>Anuncios WA</th><th className={th}>Orgánico WA</th><th className={th}>Instagram</th><th className={th}>Messenger</th><th className={th}>Total gerencial</th>
            <th className={th}>Ventas</th><th className={th}>Valor (Q)</th><th className={th}>Valor (COP)</th><th className={th}>Cierre</th><th className={th}>ROAS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const m = metaOf(r.day);
            return (
              <tr key={r.day} className="border-t border-line-soft tabular-nums">
                <td className="sticky left-0 bg-paper px-3 py-1.5 text-left text-ink">{r.day.slice(8)}/{r.day.slice(5, 7)}</td>
                <td className={`${td} font-semibold text-ink`}>{r.total}</td>
                <td className={td}>{meta(m?.linkClicks, money)}</td><td className={td}>{meta(m?.cpc, money)}</td><td className={td}>{meta(m?.ctr, pct1)}</td><td className={td}>{meta(m?.conversionPct, pct1)}</td>
                <td className={td}>{meta(m?.conversations)}</td><td className={td}>{meta(m?.spend, money)}</td>
                <td className={td}>{r.broadcastSent ?? 0}</td><td className={td}>{r.broadcastRead ?? 0}</td><td className={td}>{r.broadcastSent > 0 ? pctText(r.broadcastRead / r.broadcastSent) : '—'}</td><td className={td}>{r.broadcast}</td>
                <td className={td}>{r.ads}</td><td className={`${td} text-greige-ink`}>{r.organic}</td><td className={td}>{r.instagram}</td><td className={td}>{r.messenger}</td>
                <td className={`${td} font-semibold text-ink`}>{r.managerTotal}</td>
                <td className={`${td} text-ink`}>{r.sales ?? 0}</td><td className={td}>{money(r.salesAmount)}</td><td className={td}>{money(copOf(r))}</td>
                <td className={td}>{r.managerTotal > 0 ? pctText((r.sales ?? 0) / r.managerTotal) : '—'}</td><td className={td}>{meta(roas(r) === '—' ? null : roas(r))}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="sticky bottom-0 bg-paper">
          <tr className="border-t border-line font-bold tabular-nums text-ink">
            <td className="sticky left-0 bg-paper px-3 py-2 text-left">Total del periodo</td><td className={tf}>{sum('total')}</td>
            <td className={tf}>{meta(T?.linkClicks, money)}</td><td className={tf}>{meta(T?.cpc, money)}</td><td className={tf}>{meta(T?.ctr, pct1)}</td><td className={tf}>{meta(T?.conversionPct, pct1)}</td>
            <td className={tf}>{meta(T?.conversations)}</td><td className={tf}>{meta(T ? T.spend : null, money)}</td>
            <td className={tf}>{sum('broadcastSent')}</td><td className={tf}>{sum('broadcastRead')}</td><td className={tf}>{sum('broadcastSent') > 0 ? pctText(sum('broadcastRead') / sum('broadcastSent')) : '—'}</td><td className={tf}>{sum('broadcast')}</td>
            <td className={tf}>{sum('ads')}</td><td className={tf}>{sum('organic')}</td><td className={tf}>{sum('instagram')}</td><td className={tf}>{sum('messenger')}</td><td className={tf}>{sum('managerTotal')}</td>
            <td className={tf}>{sum('sales')}</td><td className={tf}>{money(sum('salesAmount'))}</td><td className={tf}>{money(sum('salesAmount') * fx)}</td>
            <td className={tf}>{sum('managerTotal') > 0 ? pctText(sum('sales') / sum('managerTotal')) : '—'}</td><td className={tf}>{totalRoas}</td>
          </tr>
        </tfoot>
      </table>
      </div>
      <p className="border-t border-line-soft px-3 py-2 text-[11px] text-muted-foreground">Pauta (clics, CPC, CTR, mensajes e inversión) = Informe de anuncios de Meta. Conversaciones = clientes que escriben cada día, sumados día por día; un cliente que escribe dos días cuenta en cada uno. ROAS = valor vendido en COP ÷ inversión.</p>
    </div>
  );
}

// "Expandir estadísticas" (2026-09-12): the board's own stat strip only ever shows a
// card for a bucket that HAS unread messages — a bucket sitting at 0 just isn't there.
// This is the "todos los estados, sin excepción" view, plus two operational numbers the
// board doesn't surface at all (mensajes por hora, demora en primera respuesta). Its own
// period filter, independent of whatever the board is currently showing.
// Sin "Todo": las estadísticas siempre son de un periodo concreto (por defecto, hoy).
const STATS_PERIODS = PERIOD_OPTIONS.filter((o) => o.value !== 'todo');
const pctText = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

export default function StatsModal({ open, onClose, lineId, lineOptions = [], role }) {
  const [periodPreset, setPeriodPreset] = useState('hoy');
  // Vista del resumen, los estados y los costos: 'visual' (cuadritos e íconos) o 'detalle' (listas con texto). Se recuerda en este navegador.
  const [view, setViewState] = useState(() => { try { return localStorage.getItem('statsView') === 'detalle' ? 'detalle' : 'visual'; } catch { return 'visual'; } });
  const setView = (v) => { setViewState(v); try { localStorage.setItem('statsView', v); } catch { /* solo esta sesión */ } };
  const [line, setLine] = useState(lineId ?? '');
  useEffect(() => { setLine(lineId ?? ''); }, [lineId]);
  const todayStr = guatemalaToday();
  const [monthCursor, setMonthCursor] = useState(() => {
    const [y, m] = todayStr.split('-').map(Number);
    return { year: y, month: m };
  });
  const [customFrom, setCustomFrom] = useState(todayStr);
  const [customTo, setCustomTo] = useState(todayStr);

  // Plain calendar days, on purpose — NOT the advisor board's "since the last advisor
  // message before the day started" shift-aware cutoff (HandoffQueue.jsx/pipelinePeriod's
  // useDayCutoffs). This is a reporting popup: "Hoy" has to mean literally today,
  // midnight to now (2026-09-13 report: bars for hours that hadn't happened yet today
  // were actually yesterday's activity bleeding in through that cutoff), not a
  // pipeline-specific idea of when "today's backlog" starts.
  let dateFrom, dateTo;
  if (periodPreset === 'hoy') { dateFrom = todayStr; dateTo = todayStr; }
  else if (periodPreset === 'ayer') { dateFrom = addDays(todayStr, -1); dateTo = addDays(todayStr, -1); }
  else if (periodPreset === 'semana') { dateFrom = addDays(todayStr, -6); dateTo = todayStr; }
  else if (periodPreset === 'mes') { ({ from: dateFrom, to: dateTo } = monthBounds(monthCursor.year, monthCursor.month)); }
  else if (periodPreset === 'personalizado') { dateFrom = customFrom; dateTo = customTo; }

  // El embudo usa el mismo corte del Pipeline: Hoy = desde el último mensaje de las asesoras de ayer; Ayer = lo que cerró esa jornada (lo que quedó pendiente al terminar el turno cuenta como de hoy).
  const { todayCutoff, yesterdayCutoff } = useDayCutoffs(todayStr);
  // El embudo es una foto de lo que hay en cada etapa: por defecto "Ahora" (todo el Pipeline, como el "Todo" del tablero); "Del periodo" lo acota al periodo elegido.
  const [funnelMode, setFunnelMode] = useState('now');
  let fSince; let fUntil;
  if (funnelMode === 'now') { /* sin corte */ }
  else if (periodPreset === 'hoy') { fSince = todayCutoff ?? guatemalaMidnight(todayStr); }
  else if (periodPreset === 'ayer') { fSince = yesterdayCutoff ?? guatemalaMidnight(addDays(todayStr, -1)); fUntil = todayCutoff ?? guatemalaMidnight(todayStr); }

  // El periodo exacto que cuenta el embudo, a la vista, para compararlo con el del Pipeline.
  const gtStamp = (iso) => new Date(iso).toLocaleString('es-GT', { timeZone: 'America/Guatemala', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const funnelPeriod = funnelMode === 'now' ? 'Ahora: todos los clientes que hay hoy en cada etapa (igual al "Todo" del Pipeline)' : fSince ? (fUntil ? `${gtStamp(fSince)} → ${gtStamp(fUntil)}` : `Desde ${gtStamp(fSince)}`) : `${dateFrom} a ${dateTo}`;

  function shiftMonth(delta) {
    setMonthCursor((prev) => {
      let month = prev.month + delta;
      let year = prev.year;
      if (month < 1) { month = 12; year -= 1; }
      if (month > 12) { month = 1; year += 1; }
      return { year, month };
    });
  }

  const [data, setData] = useState(null);
  const [adv, setAdv] = useState(null);
  const [showDetail, setShowDetail] = useState(false); // el detalle por asesora y por día queda plegado: el resumen es lo que se mira
  const [ads, setAds] = useState(null); // pauta de Meta por día (Informe de anuncios), para la tabla gerencial
  const [costs, setCosts] = useState(null); // los costos vienen de Meta y tardan más: la pantalla se arma sin esperarlos
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setData(null);
    setCosts(null);
    setAdv(null);
    setAds(null);
    setError(null);
    fetchPipelineStats({ from: dateFrom, to: dateTo, lineId: line || undefined, fSince, fUntil, fAll: funnelMode === 'now' })
      .then((d) => { if (current) setData(d); })
      .catch((err) => { if (current) setError(err.message); });
    fetchPipelineStatsAdvisors({ from: dateFrom, to: dateTo, lineId: line || undefined })
      .then((a) => { if (current) setAdv(a); })
      .catch(() => { if (current) setAdv({ advisors: [], daily: [], fxQtoCop: 420, failed: true }); });
    fetchMetaAdsReport({ since: dateFrom, until: dateTo, level: 'campaign' })
      .then((r) => { if (current) setAds(r); })
      .catch(() => { if (current) setAds({ failed: true, daily: [], totals: null }); });
    fetchPipelineStatsCosts({ from: dateFrom, to: dateTo })
      .then((c) => { if (current) setCosts(c); })
      .catch((err) => { if (current) setCosts({ conversionCostError: err.message, messageCostError: err.message }); });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dateFrom, dateTo, line, fSince, fUntil, funnelMode]);

  const [cur, setCurState] = useState(() => { try { const v = localStorage.getItem('statsCurrency'); return v === 'USD' || v === 'COP' ? v : 'Q'; } catch { return 'Q'; } });
  const setCur = (v) => { setCurState(v); try { localStorage.setItem('statsCurrency', v); } catch { /* solo esta sesión */ } };
  const money = makeMoney(cur, adv?.usdCop ?? 4000, adv?.fxQtoCop ?? 420);

  // Ventas por asesora en el periodo (valor vendido): la misma información del panel de ventas del Dashboard.
  const pieRef = useRef(null);
  const sellers = (adv?.advisors ?? []).filter((a) => a.salesAmount > 0);
  useChart(pieRef, () => ({
    type: 'doughnut',
    data: { labels: sellers.map((a) => a.advisor), datasets: [{ data: sellers.map((a) => a.salesAmount), backgroundColor: sellers.map((_, i) => PIE_COLORS[i % PIE_COLORS.length]), borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '66%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${money.q(c.parsed)}` } } } },
  }), [adv, data, view, cur]);

  return (
    <MoneyCtx.Provider value={money}>
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ type: 'spring', bounce: 0.12, duration: 0.22 }}
            className="glass-card w-full max-w-[1560px] max-h-[94vh] overflow-y-auto rounded-2xl border border-line bg-paper p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink">Estadísticas del pipeline</h3>
              <div className="flex flex-wrap items-center gap-2">
                {lineOptions.length > 2 && <Select value={line} onChange={setLine} options={lineOptions} className="w-44 shrink-0" />}
                <div role="group" aria-label="Vista" className="flex shrink-0 rounded-lg border border-line bg-paper p-0.5 shadow-sm">
                  {[['visual', 'Visual', LayoutGrid], ['detalle', 'Detallada', List]].map(([k, l, I]) => (
                    <button key={k} type="button" onClick={() => setView(k)} aria-pressed={view === k} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${view === k ? 'bg-accent text-white' : 'text-greige-ink hover:text-ink'}`}><I size={13} />{l}</button>
                  ))}
                </div>
                <div role="group" aria-label="Moneda" className="flex shrink-0 rounded-lg border border-line bg-paper p-0.5 shadow-sm">
                  {['Q', 'COP', 'USD'].map((k) => (
                    <button key={k} type="button" onClick={() => setCur(k)} aria-pressed={cur === k} className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${cur === k ? 'bg-accent text-white' : 'text-greige-ink hover:text-ink'}`}>{k}</button>
                  ))}
                </div>
                <Select value={periodPreset} onChange={setPeriodPreset} options={STATS_PERIODS} className="w-44 shrink-0" />
                {periodPreset === 'mes' && (
                  <div className="flex shrink-0 items-center gap-1 rounded-lg border border-line bg-paper px-1.5 py-1.5 shadow-sm">
                    <button type="button" onClick={() => shiftMonth(-1)} className="rounded-full p-0.5 text-greige-ink hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]" aria-label="Mes anterior">‹</button>
                    <span className="min-w-[108px] text-center text-xs font-medium text-ink">{MONTH_NAMES[monthCursor.month - 1]} {monthCursor.year}</span>
                    <button type="button" onClick={() => shiftMonth(1)} className="rounded-full p-0.5 text-greige-ink hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]" aria-label="Mes siguiente">›</button>
                  </div>
                )}
                {periodPreset === 'personalizado' && (
                  <div className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 py-1.5 shadow-sm">
                    <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} className="bg-transparent text-xs text-ink outline-none [color-scheme:light] dark:[color-scheme:dark]" />
                    <span className="text-xs text-greige-ink">a</span>
                    <input type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} className="bg-transparent text-xs text-ink outline-none [color-scheme:light] dark:[color-scheme:dark]" />
                  </div>
                )}
                <button type="button" onClick={onClose} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-greige-ink transition-colors hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]" aria-label="Cerrar">
                  <X size={16} />
                </button>
              </div>
            </div>

            {error && <p className="mt-4 text-sm text-danger">{error}</p>}
            {!data && !error && (
              <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>
            )}
            {data && (
              <>
              {view === 'visual' && <ManagerView data={data} costs={costs} adv={adv} sellers={sellers} pieRef={pieRef} line={line} funnelPeriod={funnelPeriod} funnelMode={funnelMode} setFunnelMode={setFunnelMode} />}
              <div className="mt-5 grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-[260px_240px_340px_1fr]">
                {view === 'detalle' && (
                  <>
                <div className="flex flex-col gap-6">
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink">Resumen del periodo</p>
                    <div className="flex flex-col gap-2">
                      <SummaryDetail data={data} costs={costs} adv={adv} />
                      <StatCard
                        label="No leídos"
                        value={data.buckets.filter((b) => b.bucket !== 'pendiente').reduce((sum, b) => sum + b.unreadTotal, 0)}
                        iconBg="bg-warning/10"
                        iconText="text-warning"
                        icon={Mail}
                      />
                      <StatCard
                        label="No atendidos"
                        value={data.buckets.find((b) => b.bucket === 'pendiente')?.total ?? 0}
                        iconBg={metaFor('pendiente').iconBg}
                        iconText={metaFor('pendiente').iconText}
                        icon={metaFor('pendiente').icon}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-6">
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink">Todos los estados</p>
                    {view === 'visual' ? <StatesGrid buckets={data.buckets} /> : (
                    <div className="flex flex-col gap-2">
                      {data.buckets.map((b) => {
                        const meta = metaFor(b.bucket);
                        return (
                          <StatCard key={b.bucket} label={meta.label} value={b.total} iconBg={meta.iconBg} iconText={meta.iconText} icon={meta.icon}
                            sub={`${b.unreadTotal} no leído(s)`} unit={b.unreadTotal > 0 ? `· ${b.unreadTotal} no leídos` : undefined} />
                        );
                      })}
                    </div>
                    )}
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink">Demora en primera respuesta</p>
                    {view === 'visual'
                      ? <Tile icon={Clock} tone="bg-warning/10 text-warning" value={formatMinutes(data.avgFirstResponseMinutes)} label="demora en responder" title="Promedio de la primera respuesta en el periodo" />
                      : <StatCard
                      label="promedio en el periodo"
                      value={formatMinutes(data.avgFirstResponseMinutes)}
                      iconBg={PIPELINE_COLOR_CLASSES.warning.iconBg}
                      iconText={PIPELINE_COLOR_CLASSES.warning.iconText}
                      icon={PIPELINE_ICON_MAP.Clock}
                    />}
                  </div>
                </div>

                <div className="flex flex-col gap-6">
                  {view === 'visual' ? <CostsVisual costs={costs} data={data} adv={adv} /> : (
                  <>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-greige-ink">Costo de conversión</p>
                    {costs?.conversionCost?.nameFilter && <p className="mt-0.5 text-[11px] text-muted-foreground">Pauta: campañas que contienen “{costs.conversionCost.nameFilter}”, igual que el Informe de anuncios.</p>}
                    <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">Dos formas de medirlo: lo que Meta cuenta como "resultado" (conversaciones iniciadas) y lo que el CRM confirma como venta real. No tienen por qué coincidir.</p>
                    {costs?.conversionCost && (
                      <div className="flex flex-col gap-3">
                        <div>
                          <p className="mb-1 text-[11px] font-medium text-greige-ink">Costo por resultado — igual a Meta Ads</p>
                          <div className="flex flex-wrap gap-2">
                            <StatCard
                              label="gasto en pauta"
                              value={money.acct(costs?.conversionCost.spend, costs?.conversionCost.currency)}
                              iconBg={PIPELINE_COLOR_CLASSES.danger.iconBg}
                              iconText={PIPELINE_COLOR_CLASSES.danger.iconText}
                              icon={PIPELINE_ICON_MAP.CircleDollarSign}
                            />
                            <StatCard
                              label="conversaciones"
                              value={costs?.conversionCost.results}
                              iconBg={PIPELINE_COLOR_CLASSES.info.iconBg}
                              iconText={PIPELINE_COLOR_CLASSES.info.iconText}
                              icon={PIPELINE_ICON_MAP.MessageSquareWarning}
                            />
                            <StatCard
                              label="por resultado"
                              value={costs?.conversionCost.costPerResult != null ? money.acct(costs?.conversionCost.costPerResult, costs?.conversionCost.currency) : 'Sin conversaciones'}
                              iconBg={PIPELINE_COLOR_CLASSES.warning.iconBg}
                              iconText={PIPELINE_COLOR_CLASSES.warning.iconText}
                              icon={PIPELINE_ICON_MAP.CircleDollarSign}
                            />
                          </div>
                        </div>
                        <div>
                          <p className="mb-1 text-[11px] font-medium text-greige-ink">Costo por venta — confirmada en el CRM</p>
                          <div className="flex flex-wrap gap-2">
                            <StatCard
                              label="pagados de pauta"
                              value={costs?.conversionCost.conversions}
                              iconBg={PIPELINE_COLOR_CLASSES.success.iconBg}
                              iconText={PIPELINE_COLOR_CLASSES.success.iconText}
                              icon={PIPELINE_ICON_MAP.CheckCircle2}
                            />
                            <StatCard
                              label="por venta"
                              value={costs?.conversionCost.costPerConversion != null ? money.acct(costs?.conversionCost.costPerConversion, costs?.conversionCost.currency) : 'Sin ventas'}
                              iconBg={PIPELINE_COLOR_CLASSES.info.iconBg}
                              iconText={PIPELINE_COLOR_CLASSES.info.iconText}
                              icon={PIPELINE_ICON_MAP.CircleDollarSign}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                    {costs?.conversionCostError && (
                      <p className="text-xs text-danger">No se pudo leer Meta Ads: {costs?.conversionCostError}</p>
                    )}
                    {!costs && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
                    {costs && !costs.conversionCost && !costs.conversionCostError && (
                      <p className="text-xs text-muted-foreground">Sin datos para este periodo.</p>
                    )}
                  </div>

                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-greige-ink">Costo por mensaje</p>
                    {data.costsAreAccountWide && <p className="mt-0.5 text-[11px] text-warning">Facturación de toda la cuenta de WhatsApp: no se separa por línea.</p>}
                    <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">Lo que WhatsApp cobra por cada mensaje enviado — facturación de la plataforma, no gasto en pauta. No tiene por qué coincidir con "Costo de conversión".</p>
                    {costs?.messageCost && (
                      <>
                        <div className="flex flex-wrap gap-2">
                          <StatCard
                            label="gasto acumulado"
                            value={money.acct(costs?.messageCost.totalCost, costs?.messageCost.currency)}
                            iconBg={PIPELINE_COLOR_CLASSES.danger.iconBg}
                            iconText={PIPELINE_COLOR_CLASSES.danger.iconText}
                            icon={PIPELINE_ICON_MAP.CircleDollarSign}
                          />
                          <StatCard
                            label="mensajes cobrados"
                            value={costs?.messageCost.billableVolume}
                            iconBg={PIPELINE_COLOR_CLASSES.warning.iconBg}
                            iconText={PIPELINE_COLOR_CLASSES.warning.iconText}
                            icon={PIPELINE_ICON_MAP.MessageSquareWarning}
                          />
                          <StatCard
                            label="promedio por mensaje"
                            value={costs?.messageCost.avgCostPerMessage != null ? money.acct(costs?.messageCost.avgCostPerMessage, costs?.messageCost.currency) : 'Sin mensajes cobrados'}
                            iconBg={PIPELINE_COLOR_CLASSES.info.iconBg}
                            iconText={PIPELINE_COLOR_CLASSES.info.iconText}
                            icon={PIPELINE_ICON_MAP.CircleDollarSign}
                          />
                        </div>
                        {costs?.messageCost.byCategory.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {costs?.messageCost.byCategory.map((c) => (
                              <span key={c.category} className="rounded-lg border border-line bg-paper px-2.5 py-1 text-[11px] text-greige-ink">
                                {PRICING_CATEGORY_LABELS[c.category] ?? c.category}: {c.volume} · {c.cost > 0 ? `${money.acct(c.costPerMessage, costs?.messageCost.currency)}/msg` : 'gratis'}
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    {costs?.messageCostError && (
                      <p className="text-xs text-danger">No se pudo leer WhatsApp: {costs?.messageCostError}</p>
                    )}
                    {!costs && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
                    {costs && !costs.messageCost && !costs.messageCostError && (
                      <p className="text-xs text-muted-foreground">Sin datos para este periodo.</p>
                    )}
                  </div>
                </>
                  )}
                </div>

                <SalesByAdvisor adv={adv} sellers={sellers} pieRef={pieRef} />
                  </>
                )}
                <div className="lg:col-span-4">
                  <button type="button" onClick={() => setShowDetail((v) => !v)} className="flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline">{showDetail ? 'Ocultar el detalle por asesora y por día' : 'Ver el detalle por asesora y por día'}</button>
                </div>
                {showDetail && (
                  <>
                <div className="lg:col-span-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-greige-ink">Atención y ventas por asesora</p>
                    {role !== 'asesor' && <button type="button" onClick={() => downloadExcel({ data, adv, dateFrom, dateTo, line })} className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-muted"><Download size={13} />Descargar Excel</button>}
                  </div>
                  <AdvisorTable adv={adv} />
                </div>
                {data.dailyConversations?.length > 0 && (
                  <div className="lg:col-span-4">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink">Tabla gerencial día por día</p>
                    <DailyTable rows={data.dailyConversations} ads={ads} fx={adv?.fxQtoCop ?? 420} />
                  </div>
                )}
  </>
                )}
              </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </MoneyCtx.Provider>
  );
}
