// Calificación de la pauta como la hace el traficker en su informe: costo por conversación y conversión clic → mensaje, con umbrales
// en la moneda de la cuenta (vienen del servidor: app_settings.meta_ads_thresholds).
export const DEFAULT_THRESHOLDS = { cprGood: 1200, cprRegular: 2500, convGood: 25, convRegular: 20 };

export const rateCpr = (v, t = DEFAULT_THRESHOLDS) => (v == null ? null : v <= t.cprGood ? 'good' : v <= t.cprRegular ? 'regular' : 'bad');
export const rateConv = (v, t = DEFAULT_THRESHOLDS) => (v == null ? null : v > t.convGood ? 'good' : v > t.convRegular ? 'regular' : 'bad');
export const CPR_LABEL = { good: 'Bueno', regular: 'Regular', bad: 'Malo' };
export const CONV_LABEL = { good: 'Buena', regular: 'Regular', bad: 'A revisar' };

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const longDay = (d) => `${Number(d.slice(8))} de ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

// Lectura ejecutiva: lo mismo que el traficker escribe a mano (mejor día, principal generadora, eficiencia), calculado con los datos en vivo.
export function executiveReading({ daily = [], rows = [], totals, thresholds = DEFAULT_THRESHOLDS, fmt, pct }) {
  const out = [];
  const withData = daily.filter((d) => d.conversations > 0);
  if (withData.length > 1) {
    const best = withData.reduce((a, b) => (b.conversations > a.conversations ? b : a));
    out.push({ title: `Mejor día: ${longDay(best.date)}.`, text: `Se registraron ${best.conversations} conversaciones con un costo promedio de ${fmt(best.costPerConversation)}.` });
  }
  const top = [...rows].filter((r) => r.conversations > 0).sort((a, b) => b.conversations - a.conversations)[0];
  if (top) out.push({ title: `Principal generadora: ${top.name}.`, text: `Aporta ${top.conversations} conversaciones durante el período (${Math.round((top.conversations / Math.max(1, totals.conversations)) * 100)}% del total).` });
  if (totals.costPerConversation != null) {
    const costRate = rateCpr(totals.costPerConversation, thresholds);
    const convRate = rateConv(totals.conversionPct, thresholds);
    const costWord = { good: 'en rango bueno', regular: 'en rango regular', bad: 'en rango malo' }[costRate];
    const above = totals.conversionPct != null ? (totals.conversionPct > thresholds.convGood ? `supera el ${thresholds.convGood}%` : `no llega al ${thresholds.convGood}%`) : null;
    const costly = rows.filter((r) => r.conversations > 0 && r.costPerConversation > thresholds.cprRegular).map((r) => r.name);
    out.push({
      title: 'Eficiencia de la pauta:',
      text: `El costo promedio de ${fmt(totals.costPerConversation)} está ${costWord}${above ? ` y la conversión clic → mensaje de ${pct(totals.conversionPct)} ${above}` : ''}.`
        + (costly.length ? ` Revisar especialmente lo que supera ${fmt(thresholds.cprRegular)} por conversación: ${costly.slice(0, 4).join(', ')}.` : convRate === 'bad' ? ' Revisar la conversión.' : ''),
    });
  }
  return out;
}
