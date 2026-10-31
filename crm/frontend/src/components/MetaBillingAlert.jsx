import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { fetchMetaBilling, saveMetaBilling } from '../api.js';
import { useLiveEvent } from '../lib/liveEvents.js';
import { playAlarm } from '../lib/notifications.js';

// Alerta del saldo de la API de WhatsApp (Meta), solo para administradores y por línea: cada línea tiene su propia cuenta de mensajes en Meta.
// Normal (aviso): faltan ~US$7 para el cobro automático. Fuerte: faltan ~US$4, o el cobro falló / Meta rechazó un envío por pago:
// banner que no se cierra, con alarma que se repite hasta que se atienda.
const BILLING_URL = 'https://business.facebook.com/billing_hub/accounts';
const POLL_MS = 5 * 60 * 1000;
const REPEAT_MS = 90 * 1000;
const lsGet = (k) => { try { return Number(localStorage.getItem(k)) || 0; } catch { return 0; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* sin almacenamiento: solo no recuerda */ } };
const usd = (n) => `US$ ${Number(n).toFixed(2)}`;

function lineTitle(l) {
  if (l.level === 'blocked') return `${l.label}: restringida por pago, no se pueden enviar mensajes`;
  if (l.level === 'critical') return `${l.label}: saldo por acabarse, faltan ~${usd(Math.max(l.remaining ?? 0, 0))} para el cobro de Meta`;
  if (l.level === 'warn') return `${l.label}: faltan ~${usd(l.remaining)} para el próximo cobro de Meta`;
  return `${l.label}: anota su saldo de Meta para activar la alerta`;
}

function lineDetail(l) {
  if (l.level === 'blocked') return 'Meta no pudo cobrar la tarjeta. Entra a Facturación de Meta, pulsa "Pagar ahora" y revisa que la tarjeta tenga fondos.';
  if (l.level === 'unknown') return 'Anota abajo el "Saldo actual" que muestra Meta para esta línea y el CRM calculará cuándo se acerca el cobro.';
  return 'Revisa que la tarjeta de Meta tenga fondos antes del cobro automático.';
}

function LineCard({ line, threshold, busy, onSave }) {
  const [owed, setOwed] = useState('');
  return (
    <div className="rounded-xl bg-black/15 p-3">
      <p className="text-sm font-bold">{lineTitle(line)}</p>
      <p className="mt-0.5 text-xs opacity-90">{lineDetail(line)}</p>
      <p className="mt-0.5 text-[11px] opacity-80">En Meta: Facturación y pagos → Cuentas de mensajes → la cuenta de {line.label}.</p>
      {line.estimatedOwed != null && (
        <p className="mt-1 text-[11px] opacity-80">
          Estimado: se deben ~{usd(line.estimatedOwed)} de un umbral de {usd(threshold)}
          {line.baseline ? `, a partir de los ${usd(line.baseline.owed)} anotados el ${new Date(line.baseline.at).toLocaleDateString('es-GT', { day: 'numeric', month: 'short' })}` : ''}. Meta tarda en reportar los costos: confirma con el saldo real.
        </p>
      )}
      {line.health?.error && <p className="mt-1 text-[11px] opacity-80">No se pudo leer el estado de esta cuenta en Meta: {line.health.error}</p>}
      {line.estimateError && <p className="mt-1 text-[11px] opacity-80">No se pudo estimar el gasto: {line.estimateError}</p>}
      <div className="mt-2 flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-0.5">Saldo actual de {line.label} según Meta (US$)
          <input type="number" min="0" step="0.01" value={owed} onChange={(e) => setOwed(e.target.value)} placeholder="ej. 30.15" className="w-36 rounded-lg border border-line bg-paper px-2 py-1 text-ink" />
        </label>
        <button type="button" disabled={busy || owed === ''} onClick={() => onSave({ lineId: line.lineId, owed: Number(owed) }).then(() => setOwed(''))} className="rounded-lg bg-paper px-3 py-1.5 font-semibold text-ink disabled:opacity-50">Actualizar</button>
        <button type="button" disabled={busy} onClick={() => onSave({ lineId: line.lineId, owed: 0 })} className="rounded-lg border border-current px-3 py-1.5 font-semibold disabled:opacity-50">Ya pagué (saldo 0)</button>
      </div>
    </div>
  );
}

export default function MetaBillingAlert({ role }) {
  const isAdmin = role === 'admin';
  const [s, setS] = useState(null);
  const [threshold, setThreshold] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [mutedUntil, setMutedUntil] = useState(0);
  const mutedRef = useRef(0);
  mutedRef.current = mutedUntil;

  const load = useCallback((fresh = false) => { if (isAdmin) fetchMetaBilling(fresh).then(setS).catch(() => {}); }, [isAdmin]);
  useEffect(() => { load(); const id = setInterval(load, POLL_MS); return () => clearInterval(id); }, [load]);
  useLiveEvent('billing_alert', useCallback(() => load(true), [load]), 0);
  useEffect(() => { if (s?.threshold && !threshold) setThreshold(String(s.threshold)); }, [s, threshold]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(id); }, []);

  const level = s?.level;
  // El aviso normal se puede ocultar 2 h; el fuerte y el bloqueo, no.
  const warnHidden = level === 'warn' && lsGet('metaBillingWarnHiddenUntil') > now;
  const setupHidden = level === 'unknown' && lsGet('metaBillingSetupHiddenUntil') > now;

  // Suena al aparecer o al cambiar de nivel; el fuerte y el bloqueo se repiten cada 90 s hasta que se atiendan.
  useEffect(() => {
    if (!['warn', 'critical', 'blocked'].includes(level) || warnHidden) return undefined;
    if (Date.now() >= mutedRef.current) playAlarm();
    if (level === 'warn') return undefined;
    const id = setInterval(() => { if (Date.now() >= mutedRef.current) playAlarm(); }, REPEAT_MS);
    return () => clearInterval(id);
  }, [level, warnHidden]);

  async function save(body) {
    setBusy(true); setError(null);
    try { setS(await saveMetaBilling({ ...body, threshold: Number(threshold) || undefined })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  if (!isAdmin || !s || level === 'ok' || warnHidden || setupHidden) return null;
  const lines = (s.lines ?? []).filter((l) => l.level !== 'ok').sort((a, b) => ['blocked', 'critical', 'warn', 'unknown'].indexOf(a.level) - ['blocked', 'critical', 'warn', 'unknown'].indexOf(b.level));
  if (!lines.length) return null;

  const urgent = level === 'blocked' || level === 'critical';
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[80] flex justify-center p-3" role="alert">
      <div className={`pointer-events-auto max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border-2 p-4 shadow-2xl ${urgent ? 'animate-pulse border-white/40 bg-danger text-white' : level === 'warn' ? 'border-warning bg-warning text-white' : 'border-line bg-paper text-ink'}`}>
        <div className="flex items-start gap-3">
          <ShieldAlert size={22} className="mt-0.5 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {lines.map((l) => <LineCard key={l.lineId} line={l} threshold={s.threshold} busy={busy} onSave={save} />)}
            <div className="flex flex-wrap items-end gap-2 text-xs">
              <label className="flex flex-col gap-0.5">Umbral de cobro (US$, igual para las líneas)
                <input type="number" min="1" step="1" value={threshold} onChange={(e) => setThreshold(e.target.value)} className="w-24 rounded-lg border border-line bg-paper px-2 py-1 text-ink" />
              </label>
              <a href={BILLING_URL} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-paper px-3 py-1.5 font-semibold text-ink">Abrir facturación de Meta</a>
              {urgent && <button type="button" onClick={() => setMutedUntil(Date.now() + 10 * 60 * 1000)} className="rounded-lg border border-current px-3 py-1.5 font-semibold">Silenciar el sonido 10 min</button>}
            </div>
            {error && <p className="text-[11px] font-semibold">{error}</p>}
          </div>
          {!urgent && (
            <button type="button" title="Ocultar un rato" onClick={() => { lsSet(level === 'warn' ? 'metaBillingWarnHiddenUntil' : 'metaBillingSetupHiddenUntil', Date.now() + (level === 'warn' ? 2 : 24) * 3600000); setNow(Date.now()); }} className="rounded-lg p-1 opacity-80 hover:opacity-100"><X size={18} /></button>
          )}
        </div>
      </div>
    </div>
  );
}
