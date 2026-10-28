import { Fragment, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from 'chart.js';
import { X, Loader2, Calendar, Mail, Download, MessagesSquare, UserPlus, Repeat, Target, ShoppingBag, Wallet, Percent, TrendingUp, CircleDollarSign, CheckCircle2, Clock, LayoutGrid, List } from 'lucide-react';
import { ChannelIcon } from '../lib/channelIcons.jsx';
import * as XLSX from 'xlsx';
import { fetchPipelineStats, fetchPipelineStatsCosts, fetchPipelineStatsAdvisors, fetchMetaAdsReport } from '../api.js';
import { showError } from './Toast.jsx';
import Select from './Select.jsx';
import { PERIOD_OPTIONS, guatemalaToday, addDays, monthBounds, MONTH_NAMES } from '../lib/pipelinePeriod.js';
import { DEFAULT_COLUMN_META, PIPELINE_ICON_MAP, PIPELINE_COLOR_CLASSES } from '../lib/pipelineColumns.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

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

function Tile({ icon: Icon, tone, value, label, title, big }) {
  return (
    <div title={title} className="flex items-center gap-2 rounded-xl border border-line bg-paper px-2.5 py-2 shadow-sm">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${tone}`}><Icon size={14} /></span>
      <span className="min-w-0 leading-tight"><span className={`block font-semibold tabular-nums text-ink ${big ? 'text-xl' : 'text-base'}`}>{value}</span><span className="block truncate text-[11px] text-greige-ink">{label}</span></span>
    </div>
  );
}

function SummaryPanel({ data, costs, adv }) {
  const c = data.conversations;
  const orig = ORIGINS.map(([k, label, color]) => ({ k, label, color, n: c.byOrigin[k] ?? 0 }));
  const originTotal = orig.reduce((n, o) => n + o.n, 0);
  const roas = costs?.conversionCost?.spend > 0 ? ((c.salesAmount * (adv?.fxQtoCop ?? 420)) / costs.conversionCost.spend).toFixed(2) : '…';
  return (
    <div className="flex flex-col gap-2.5">
      <div title="Clientes que escribieron cada día, sumados día por día (como las cuenta Meta)" className="flex items-center gap-3 rounded-xl border border-line bg-paper px-3 py-2.5 shadow-sm">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><MessagesSquare size={20} /></span>
        <span className="leading-tight"><span className="block text-3xl font-bold tabular-nums text-ink">{c.conversations}</span><span className="block text-xs text-greige-ink">conversaciones</span></span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {['whatsapp', 'instagram', 'messenger'].map((ch) => (
          <div key={ch} title={ch === 'whatsapp' ? 'WhatsApp' : ch === 'instagram' ? 'Instagram' : 'Messenger'} className="flex flex-col items-center gap-1 rounded-xl border border-line bg-paper py-2 shadow-sm">
            <ChannelIcon channel={ch} size={26} />
            <span className="text-lg font-bold tabular-nums leading-none text-ink">{c.byChannel[ch]}</span>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-line bg-paper px-3 py-2.5 shadow-sm">
        <div className="flex h-2.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">
          {originTotal > 0 && orig.filter((o) => o.n > 0).map((o) => <span key={o.k} title={`${o.label}: ${o.n}`} style={{ width: `${(o.n / originTotal) * 100}%`, background: o.color }} />)}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
          {orig.map((o) => (
            <span key={o.k} className="flex items-center gap-1.5 text-[11px] text-greige-ink"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: o.color }} /><span className="truncate">{o.label}</span><b className="ml-auto tabular-nums text-ink">{o.n}</b></span>
          ))}
        </div>
      </div>

      <Tile icon={Target} tone="bg-accent text-white" big value={c.managerTotal} label="Total gerencial" title="Anuncios de WhatsApp + difusión + Instagram + Messenger (sin orgánico de WhatsApp), como lo arma el trafficker" />

      <div className="grid grid-cols-2 gap-2">
        <Tile icon={UserPlus} tone="bg-success/10 text-success" value={c.newPeople} label="Nuevos" title={`Clientes distintos: ${c.people}`} />
        <Tile icon={Repeat} tone="bg-info/10 text-info" value={c.returning} label="Recurrentes" title={`Clientes distintos: ${c.people}`} />
        <Tile icon={ShoppingBag} tone="bg-success/10 text-success" value={c.sales ?? '—'} label="Ventas" title="Ventas del reporte de ventas (suma de las asesoras de la línea elegida)" />
        <Tile icon={Wallet} tone="bg-warning/10 text-warning" value={c.salesAmount ? `Q ${Math.round(c.salesAmount).toLocaleString('es-GT')}` : '—'} label="Vendido" />
        <Tile icon={Percent} tone="bg-accent-soft text-accent" value={pctText(c.closeRate)} label="Cierre" title="Ventas ÷ total gerencial" />
        <Tile icon={TrendingUp} tone="bg-purple/10 text-purple" value={roas} label="ROAS" title="Valor vendido en COP ÷ inversión de pauta" />
      </div>
    </div>
  );
}

// Estados en cuadritos: ícono de la columna, cantidad y un punto rojo con los no leídos.
// En esta vista las tres columnas del medio llevan su nombre de temperatura (frío, tibio, caliente).
const TEMP_LABEL = { en_atencion: 'Frío', cotizacion: 'Tibio', medio_pago: 'Caliente' };

function StatesGrid({ buckets }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {buckets.map((b) => {
        const meta = metaFor(b.bucket);
        const Icon = meta.icon;
        return (
          <div key={b.bucket} title={`${meta.label}${b.unreadTotal > 0 ? ` · ${b.unreadTotal} no leído(s)` : ''}`} className="relative flex items-center gap-2 rounded-xl border border-line bg-paper px-2.5 py-2 shadow-sm">
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${meta.iconBg} ${meta.iconText}`}><Icon size={14} /></span>
            <span className="min-w-0 leading-tight"><span className="block text-base font-semibold tabular-nums text-ink">{b.total}</span><span className="block truncate text-[11px] text-greige-ink">{TEMP_LABEL[b.bucket] ?? meta.label}</span></span>
            {b.unreadTotal > 0 && <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-bold text-white">{b.unreadTotal}</span>}
          </div>
        );
      })}
    </div>
  );
}

// Costos en cuadritos; las explicaciones largas salen al pasar el mouse.
function CostsVisual({ costs }) {
  if (!costs) return <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-muted-foreground" /></div>;
  const cc = costs.conversionCost; const mc = costs.messageCost;
  const fm = (n, cur) => (n == null ? '—' : formatMoney(n, cur));
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink" title="Lo que Meta cuenta como resultado (conversaciones iniciadas) y lo que el CRM confirma como venta real. No tienen por qué coincidir.">Pauta{cc?.nameFilter ? ` · “${cc.nameFilter}”` : ''}</p>
        {cc ? (
          <div className="grid grid-cols-2 gap-2">
            <Tile icon={CircleDollarSign} tone="bg-danger/10 text-danger" value={fm(cc.spend, cc.currency)} label="Gasto en pauta" title="Igual que el Informe de anuncios (campañas filtradas por nombre)" />
            <Tile icon={MessagesSquare} tone="bg-info/10 text-info" value={cc.results} label="Conversaciones" title="Conversaciones iniciadas según Meta" />
            <Tile icon={Target} tone="bg-warning/10 text-warning" value={fm(cc.costPerResult, cc.currency)} label="Por resultado" title="Costo por conversación iniciada (igual a Meta)" />
            <Tile icon={CheckCircle2} tone="bg-success/10 text-success" value={cc.conversions} label="Pagados de pauta" title="Clientes que llegaron por anuncio y pagaron, confirmados en el CRM" />
            <Tile icon={Wallet} tone="bg-accent-soft text-accent" value={cc.costPerConversion != null ? fm(cc.costPerConversion, cc.currency) : 'Sin ventas'} label="Por venta" title="Gasto de pauta ÷ pagados de pauta" />
          </div>
        ) : costs.conversionCostError ? <p className="text-xs text-danger">No se pudo leer Meta Ads: {costs.conversionCostError}</p> : <p className="text-xs text-muted-foreground">Sin datos para este periodo.</p>}
      </div>
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
                {mc.byCategory.map((c) => <span key={c.category} className="rounded-lg border border-line bg-paper px-2 py-1 text-[11px] text-greige-ink">{PRICING_CATEGORY_LABELS[c.category] ?? c.category}: {c.volume} · {c.cost > 0 ? `${formatMoney(c.costPerMessage, mc.currency)}/msg` : 'gratis'}</span>)}
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
      <SumRow label="Anuncios Meta" value={c.byOrigin.ads} purple /><SumRow label="Respuesta a difusión" value={c.byOrigin.broadcast} />
      <SumRow label="Orgánico de WhatsApp" value={c.byOrigin.organic} /><SumRow label="Instagram y Messenger" value={c.byOrigin.social} />
      <p className="mt-1 border-t border-line/60 pt-1 font-medium uppercase tracking-wide">Cierre</p>
      <SumRow label="Ventas confirmadas" value={c.sales ?? '—'} strong /><SumRow label="Valor vendido" value={c.salesAmount ? `Q ${Math.round(c.salesAmount).toLocaleString('es-GT')}` : '—'} />
      <SumRow label="Tasa de cierre" value={pctText(c.closeRate)} /><SumRow label="ROAS" value={roas} />
      <p className="text-[10px] leading-tight text-muted-foreground">Ventas del reporte de ventas (suma de las asesoras de la línea elegida) ÷ total gerencial. ROAS = valor en COP ÷ inversión de pauta.</p>
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
    fetchPipelineStats({ from: dateFrom, to: dateTo, lineId: line || undefined })
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
  }, [open, dateFrom, dateTo, line]);

  const dayRef = useRef(null);
  const days = data?.dailyConversations ?? [];
  useChart(dayRef, () => ({
    type: 'bar',
    data: {
      labels: days.map((d) => `${d.day.slice(8)}/${d.day.slice(5, 7)}`),
      datasets: [
        { label: 'Anuncios', data: days.map((d) => d.ads), backgroundColor: '#4338ca', borderRadius: 2 },
        { label: 'Difusión', data: days.map((d) => d.broadcast), backgroundColor: '#f59e0b', borderRadius: 2 },
        { label: 'Orgánico', data: days.map((d) => d.organic), backgroundColor: '#10b981', borderRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } }, tooltip: { mode: 'index', intersect: false } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0, autoSkip: true } },
        y: { stacked: true, beginAtZero: true, grid: { color: '#e4e4e7' }, ticks: { precision: 0 } },
      },
    },
  }), [data]);

  const hourRef = useRef(null);
  useChart(hourRef, () => ({
    type: 'bar',
    data: {
      labels: (data?.conversationsByHour ?? []).map((r) => `${r.hour}h`),
      datasets: [{
        data: (data?.conversationsByHour ?? []).map((r) => r.total),
        backgroundColor: '#4338ca',
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { beginAtZero: true, grid: { color: '#e4e4e7' }, ticks: { precision: 0 } },
      },
    },
  }), [data]);

  return (
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
            className="glass-card w-full max-w-7xl max-h-[92vh] overflow-y-auto rounded-2xl border border-line bg-paper p-6 shadow-xl"
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
              <div className="mt-5 grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-[260px_240px_340px_1fr]">
                <div className="flex flex-col gap-6">
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink">Resumen del periodo</p>
                    <div className="flex flex-col gap-2">
                      {view === 'visual' ? <SummaryPanel data={data} costs={costs} adv={adv} /> : <SummaryDetail data={data} costs={costs} adv={adv} />}
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
                  {view === 'visual' ? <CostsVisual costs={costs} /> : (
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
                              value={formatMoney(costs?.conversionCost.spend, costs?.conversionCost.currency)}
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
                              value={costs?.conversionCost.costPerResult != null ? formatMoney(costs?.conversionCost.costPerResult, costs?.conversionCost.currency) : 'Sin conversaciones'}
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
                              value={costs?.conversionCost.costPerConversion != null ? formatMoney(costs?.conversionCost.costPerConversion, costs?.conversionCost.currency) : 'Sin ventas'}
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
                            value={formatMoney(costs?.messageCost.totalCost, costs?.messageCost.currency)}
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
                            value={costs?.messageCost.avgCostPerMessage != null ? formatMoney(costs?.messageCost.avgCostPerMessage, costs?.messageCost.currency) : 'Sin mensajes cobrados'}
                            iconBg={PIPELINE_COLOR_CLASSES.info.iconBg}
                            iconText={PIPELINE_COLOR_CLASSES.info.iconText}
                            icon={PIPELINE_ICON_MAP.CircleDollarSign}
                          />
                        </div>
                        {costs?.messageCost.byCategory.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {costs?.messageCost.byCategory.map((c) => (
                              <span key={c.category} className="rounded-lg border border-line bg-paper px-2.5 py-1 text-[11px] text-greige-ink">
                                {PRICING_CATEGORY_LABELS[c.category] ?? c.category}: {c.volume} · {c.cost > 0 ? `${formatMoney(c.costPerMessage, costs?.messageCost.currency)}/msg` : 'gratis'}
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

                <div className="flex flex-col gap-4">
                  {days.length > 1 && (
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink">Conversaciones por día</p>
                      <div style={{ position: 'relative', height: 230 }}>
                        <canvas ref={dayRef} role="img" aria-label="Conversaciones por día, por origen" />
                      </div>
                    </div>
                  )}
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-greige-ink">Conversaciones por hora del día</p>
                    <div style={{ position: 'relative', height: days.length > 1 ? 200 : 380 }}>
                      <canvas ref={hourRef} role="img" aria-label="Conversaciones de clientes por hora del día" />
                    </div>
                  </div>
                </div>
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
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
