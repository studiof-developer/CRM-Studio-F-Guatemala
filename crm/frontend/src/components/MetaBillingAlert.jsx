import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { fetchMetaBilling, saveMetaBilling } from '../api.js';
import { useLiveEvent } from '../lib/liveEvents.js';
import { playAlarm } from '../lib/notifications.js';

// Alerta del saldo de la API de WhatsApp (Meta). Normal (aviso): faltan ~US$7 para el cobro automático. Fuerte: faltan ~US$4,
// o el cobro falló / Meta rechazó un envío por pago: banner que no se cierra, con alarma que se repite hasta que se atienda.
const BILLING_URL = 'https://business.facebook.com/billing_hub/accounts';
const POLL_MS = 5 * 60 * 1000;
const REPEAT_MS = 90 * 1000;
const lsGet = (k) => { try { return Number(localStorage.getItem(k)) || 0; } catch { return 0; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* sin almacenamiento: solo no recuerda */ } };
const usd = (n) => `US$ ${Number(n).toFixed(2)}`;

export default function MetaBillingAlert({ role }) {
  const canManage = role === 'admin' || role === 'supervisor';
  const [s, setS] = useState(null);
  const [owed, setOwed] = useState('');
  const [threshold, setThreshold] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [mutedUntil, setMutedUntil] = useState(0);
  const mutedRef = useRef(0);
  mutedRef.current = mutedUntil;

  const load = useCallback((fresh = false) => { fetchMetaBilling(fresh).then(setS).catch(() => {}); }, []);
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
    try { setS(await saveMetaBilling(body)); setOwed(''); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  if (!s || level === 'ok' || warnHidden || setupHidden) return null;
  if (level === 'unknown' && !canManage) return null;
  if (!canManage && level !== 'blocked') return null;

  const urgent = level === 'blocked' || level === 'critical';
  const title = level === 'blocked' ? 'WhatsApp restringido por pago: no se pueden enviar mensajes'
    : level === 'critical' ? `Saldo de WhatsApp por acabarse: faltan ~${usd(Math.max(s.remaining ?? 0, 0))} para el cobro de Meta`
      : level === 'warn' ? `Aviso: faltan ~${usd(s.remaining)} para el próximo cobro de Meta`
        : 'Activa la alerta de saldo de Meta';
  const detail = level === 'blocked'
    ? (canManage ? 'Meta no pudo cobrar la tarjeta. Entra a Facturación de Meta, pulsa "Pagar ahora" y revisa que la tarjeta tenga fondos.' : 'Hay un pago pendiente en Meta. Avisa al administrador.')
    : level === 'unknown' ? 'Anota abajo el "Saldo actual" que muestra Meta en Facturación y el CRM calculará cuándo se acerca el cobro.'
      : 'Revisa que la tarjeta de Meta tenga fondos antes del cobro automático.';

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[80] flex justify-center p-3" role="alert">
      <div className={`pointer-events-auto w-full max-w-2xl rounded-2xl border-2 p-4 shadow-2xl ${urgent ? 'animate-pulse border-white/40 bg-danger text-white' : level === 'warn' ? 'border-warning bg-warning text-white' : 'border-line bg-paper text-ink'}`}>
        <div className="flex items-start gap-3">
          <ShieldAlert size={22} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">{title}</p>
            <p className="mt-0.5 text-xs opacity-90">{detail}</p>
            {canManage && s.estimatedOwed != null && (
              <p className="mt-1 text-[11px] opacity-80">
                Estimado: se deben ~{usd(s.estimatedOwed)} de un umbral de {usd(s.threshold)}. Meta tarda en reportar los costos: confirma con el saldo real.
              </p>
            )}
            {canManage && s.health?.error && <p className="mt-1 text-[11px] opacity-80">No se pudo leer el estado de la cuenta en Meta: {s.health.error}</p>}
            {canManage && (
              <div className="mt-3 flex flex-wrap items-end gap-2 text-xs">
                <label className="flex flex-col gap-0.5">Saldo actual según Meta (US$)
                  <input type="number" min="0" step="0.01" value={owed} onChange={(e) => setOwed(e.target.value)} placeholder="ej. 30.15" className="w-32 rounded-lg border border-line bg-paper px-2 py-1 text-ink" />
                </label>
                <label className="flex flex-col gap-0.5">Umbral de cobro (US$)
                  <input type="number" min="1" step="1" value={threshold} onChange={(e) => setThreshold(e.target.value)} className="w-24 rounded-lg border border-line bg-paper px-2 py-1 text-ink" />
                </label>
                <button type="button" disabled={busy || owed === ''} onClick={() => save({ owed: Number(owed), threshold: Number(threshold) || undefined })} className="rounded-lg bg-paper px-3 py-1.5 font-semibold text-ink disabled:opacity-50">Actualizar</button>
                <button type="button" disabled={busy} onClick={() => save({ owed: 0, threshold: Number(threshold) || undefined })} className="rounded-lg border border-current px-3 py-1.5 font-semibold disabled:opacity-50">Ya pagué (saldo 0)</button>
              </div>
            )}
            {error && <p className="mt-1 text-[11px] font-semibold">{error}</p>}
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {canManage && <a href={BILLING_URL} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-paper px-3 py-1.5 font-semibold text-ink">Abrir facturación de Meta</a>}
              {urgent && <button type="button" onClick={() => setMutedUntil(Date.now() + 10 * 60 * 1000)} className="rounded-lg border border-current px-3 py-1.5 font-semibold">Silenciar el sonido 10 min</button>}
            </div>
          </div>
          {!urgent && canManage && (
            <button type="button" title="Ocultar un rato" onClick={() => { lsSet(level === 'warn' ? 'metaBillingWarnHiddenUntil' : 'metaBillingSetupHiddenUntil', Date.now() + (level === 'warn' ? 2 : 24) * 3600000); setNow(Date.now()); }} className="rounded-lg p-1 opacity-80 hover:opacity-100"><X size={18} /></button>
          )}
        </div>
      </div>
    </div>
  );
}
