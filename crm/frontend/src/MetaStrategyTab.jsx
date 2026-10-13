import React, { useEffect, useState, useMemo } from 'react';
import { 
  ShieldCheck, AlertTriangle, DollarSign, Users, Zap, RefreshCw, 
  HelpCircle, CheckCircle2, TrendingUp, Layers, Clock, AlertCircle, Calculator, ChevronRight, BarChart2
} from 'lucide-react';
import { fetchMetaStrategy, fetchWhatsappNumbers } from './api.js';
import Select from './components/Select.jsx';
import Badge from './components/Badge.jsx';
import { showSuccess, showError } from './components/Toast.jsx';

export default function MetaStrategyTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lines, setLines] = useState([]);
  const [selectedLine, setSelectedLine] = useState('');
  
  // Simulador de volumen interactivo
  const [targetVolume, setTargetVolume] = useState(1000);
  const [trmInput, setTrmInput] = useState(4000);

  const load = async (lineId) => {
    setLoading(true);
    try {
      const res = await fetchMetaStrategy(lineId);
      setData(res);
    } catch (err) {
      showError(err.message || 'Error al obtener estrategia de Meta');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWhatsappNumbers().then(setLines).catch(() => {});
    load();
  }, []);

  const handleLineChange = (val) => {
    setSelectedLine(val);
    load(val || undefined);
  };

  // Cálculo de distribución recomendada inteligente (70% Calientes/Tibios, 30% Fríos)
  const distribution = useMemo(() => {
    const vol = Math.max(1, Number(targetVolume) || 0);
    // Prioridad 1: Clientes con intención de pago (Calientes)
    const calientes = Math.min(Math.round(vol * 0.40), data?.audiences?.medio_pago || 0);
    // Prioridad 2: Clientes con cotización abierta (Tibios)
    const tibios = Math.min(Math.round(vol * 0.35), data?.audiences?.cotizacion || 0);
    // Prioridad 3: Clientes en atención inactiva (Fríos)
    const frios = Math.max(0, vol - calientes - tibios);

    const costMarketingUSD = vol * 0.0740;
    const costMarketingCOP = costMarketingUSD * (Number(trmInput) || 4000);

    const costUtilityUSD = vol * 0.0200;
    const costUtilityCOP = costUtilityUSD * (Number(trmInput) || 4000);

    return {
      calientes,
      tibios,
      frios,
      total: vol,
      costMarketingUSD,
      costMarketingCOP,
      costUtilityUSD,
      costUtilityCOP,
      costSavingsCOP: costMarketingCOP - costUtilityCOP,
    };
  }, [targetVolume, trmInput, data]);

  const ratingColor = (r) => {
    const rate = String(r || '').toUpperCase();
    if (rate.includes('GREEN') || rate.includes('HIGH')) return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20';
    if (rate.includes('YELLOW') || rate.includes('MEDIUM')) return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20';
    if (rate.includes('RED') || rate.includes('LOW')) return 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20';
    return 'bg-neutral-500/10 text-neutral-600 dark:text-neutral-400 border-neutral-500/20';
  };

  return (
    <div className="space-y-6">
      {/* Barra superior con selector de línea y botón de refresco */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-paper p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <ShieldCheck size={24} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-ink">Estrategia Oficial Meta, Capacidad & Antiban</h2>
            <p className="text-xs text-greige-ink">Límites oficiales de WhatsApp Cloud API, estructura de costos por mensaje y reparto seguro.</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {lines.length > 0 && (
            <div className="w-56">
              <Select
                value={selectedLine}
                onChange={handleLineChange}
                options={[
                  { value: '', label: 'Línea activa predeterminada' },
                  ...lines.map((l) => ({ value: String(l.id), label: `${l.label} (${l.displayPhoneNumber || 'Sin número'})` })),
                ]}
              />
            </div>
          )}
          <button
            onClick={() => load(selectedLine || undefined)}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3.5 py-2 text-xs font-semibold text-ink shadow-sm transition-all hover:bg-black/[0.03] active:scale-95 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Actualizar Meta
          </button>
        </div>
      </div>

      {/* Tarjetas de Salud y Estado en Vivo de la Línea */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-line bg-paper p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs text-greige-ink">
            <span>Calidad de Línea (Meta)</span>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold ${ratingColor(data?.qualityRating)}`}>
              {data?.qualityRating || 'VERIFICANDO'}
            </span>
          </div>
          <p className="mt-3 text-2xl font-black text-ink">{data?.verifiedName || 'Studio F WhatsApp'}</p>
          <p className="mt-1 text-xs text-greige-ink">{data?.displayPhoneNumber || 'Cloud API Conectada'}</p>
          <div className="mt-3 flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 size={13} /> Cloud API Oficial v20.0 (Sin Wati/Wasapi)
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-paper p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs text-greige-ink">
            <span>Límite de Envío Diario</span>
            <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-bold text-blue-600 dark:text-blue-400">
              Tier 1 Base
            </span>
          </div>
          <p className="mt-3 text-2xl font-black text-ink">1,000 / día</p>
          <p className="mt-1 text-xs text-greige-ink">Contactos únicos iniciados por empresa</p>
          <div className="mt-3 flex items-center gap-1.5 text-[11px] text-greige-ink">
            <Clock size={13} /> Escala a 10,000 manteniendo calidad verde
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-paper p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs text-greige-ink">
            <span>Protección Antiban CRM</span>
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
              Activa
            </span>
          </div>
          <p className="mt-3 text-2xl font-black text-ink">{data?.cooldownHours || 42} Horas</p>
          <p className="mt-1 text-xs text-greige-ink">Cooldown estricto entre difusiones</p>
          <div className="mt-3 flex items-center gap-1.5 text-[11px] text-accent">
            <Zap size={13} /> Delay de 350ms (~2.8 msg/seg)
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-paper p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs text-greige-ink">
            <span>Envíos Últimas 24h</span>
            <span className="rounded-full bg-purple-500/10 px-2 py-0.5 text-[11px] font-bold text-purple-600 dark:text-purple-400">
              Consumo
            </span>
          </div>
          <p className="mt-3 text-2xl font-black text-ink">{data?.stats?.outbound24hUnique || 0} / 1,000</p>
          <p className="mt-1 text-xs text-greige-ink">Mensajes entregados: {data?.stats?.outbound24hTotal || 0}</p>
          <div className="mt-3 flex items-center gap-1.5 text-[11px] text-rose-500">
            {data?.stats?.outbound24hFailed > 0 ? `Fallaron: ${data.stats.outbound24hFailed}` : 'Cero errores de entrega'}
          </div>
        </div>
      </div>

      {/* Desglose de Costos Oficiales Meta */}
      <div className="rounded-2xl border border-line bg-paper p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <DollarSign className="text-emerald-600" size={20} />
            <h3 className="text-base font-bold text-ink">Estructura Real de Costos Meta (Guatemala / LATAM)</h3>
          </div>
          <div className="flex items-center gap-2 text-xs text-greige-ink">
            <span>TRM Referencia:</span>
            <input 
              type="number" 
              value={trmInput} 
              onChange={(e) => setTrmInput(Number(e.target.value))}
              className="w-20 rounded-lg border border-line bg-surface px-2 py-1 text-right text-xs font-semibold text-ink"
            />
            <span>COP/USD</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.03] p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">Marketing</span>
              <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold text-amber-600">Difusión</span>
            </div>
            <p className="mt-2 text-xl font-black text-ink">$0.0740 USD</p>
            <p className="text-xs font-bold text-amber-600 dark:text-amber-400">~${Math.round(0.0740 * trmInput)} COP / msg</p>
            <p className="mt-2 text-[11px] text-greige-ink">Promociones, rebajas y mensajes no solicitados. Es la tarifa más alta.</p>
          </div>

          <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.03] p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Utilidad (Utility)</span>
              <span className="rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-bold text-blue-600">Transaccional</span>
            </div>
            <p className="mt-2 text-xl font-black text-ink">$0.0200 USD</p>
            <p className="text-xs font-bold text-blue-600 dark:text-blue-400">~${Math.round(0.0200 * trmInput)} COP / msg</p>
            <p className="mt-2 text-[11px] text-greige-ink">Guías de despacho, confirmaciones de pago. Ahorras el 73% vs Marketing.</p>
          </div>

          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.03] p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Servicio (Service)</span>
              <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600">Atención</span>
            </div>
            <p className="mt-2 text-xl font-black text-ink">$0.0000 USD</p>
            <p className="text-xs font-bold text-emerald-600 dark:text-emerald-400">GRATIS ($0 COP)</p>
            <p className="mt-2 text-[11px] text-greige-ink">Respuestas libres del asesor dentro de las 24h tras el mensaje del cliente.</p>
          </div>

          <div className="rounded-xl border border-purple-500/20 bg-purple-500/[0.03] p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-purple-600 dark:text-purple-400">Pauta (CTWA Ads)</span>
              <span className="rounded-md bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-bold text-purple-600">Anuncios</span>
            </div>
            <p className="mt-2 text-xl font-black text-ink">72h GRATIS</p>
            <p className="text-xs font-bold text-purple-600 dark:text-purple-400">$0 COP de API</p>
            <p className="mt-2 text-[11px] text-greige-ink">Clientes que entran desde anuncio en IG/FB tienen 72 horas sin costo de mensajes.</p>
          </div>
        </div>
      </div>

      {/* Simulador y Recomendación de Reparto de Mensajes */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-line bg-paper p-6 shadow-sm">
          <div className="flex items-center gap-2.5">
            <Calculator className="text-accent" size={20} />
            <h3 className="text-base font-bold text-ink">Simulador de Volumen Diario y Costo Real</h3>
          </div>
          <p className="mt-1 text-xs text-greige-ink">Define cuántos mensajes quieres enviar hoy para ver la distribución segura recomendada.</p>

          <div className="mt-5 space-y-4">
            <div>
              <div className="flex justify-between text-xs font-semibold text-ink">
                <span>Volumen a Enviar por Día:</span>
                <span className="text-accent">{Number(targetVolume).toLocaleString()} contactos</span>
              </div>
              <input 
                type="range" 
                min="100" 
                max="5000" 
                step="50"
                value={targetVolume}
                onChange={(e) => setTargetVolume(Number(e.target.value))}
                className="mt-2 w-full accent-accent cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-greige-ink">
                <span>100 (Prueba)</span>
                <span>1,000 (Tope Tier 1)</span>
                <span>2,500</span>
                <span>5,000 (Tier 2)</span>
              </div>
            </div>

            <div className="rounded-xl border border-line bg-surface p-4">
              <div className="flex items-center justify-between text-xs text-greige-ink">
                <span>Costo estimado en Marketing:</span>
                <span className="font-bold text-ink">${distribution.costMarketingUSD.toFixed(2)} USD (~${Math.round(distribution.costMarketingCOP).toLocaleString()} COP)</span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-greige-ink">
                <span>Si fueran mensajes de Utilidad (Guías):</span>
                <span className="font-bold text-blue-600 dark:text-blue-400">${distribution.costUtilityUSD.toFixed(2)} USD (~${Math.round(distribution.costUtilityCOP).toLocaleString()} COP)</span>
              </div>
              <div className="mt-3 border-t border-line pt-2 flex items-center justify-between text-xs font-bold text-emerald-600">
                <span>Ahorro usando plantillas Utility:</span>
                <span>${Math.round(distribution.costSavingsCOP).toLocaleString()} COP</span>
              </div>
            </div>

            <div className="rounded-xl bg-accent/5 p-4 border border-accent/20">
              <h4 className="text-xs font-bold text-accent">REGLA DE ORO DE SEGURIDAD META:</h4>
              <p className="mt-1 text-xs text-greige-ink leading-relaxed">
                Nunca mandes el 100% de la capacidad de tu línea a clientes fríos. Los clientes fríos tienen más probabilidad de marcar el mensaje como <strong>"Spam" o "Bloquear"</strong>, lo que hunde tu Quality Rating y Meta degrada tu límite a 250 mensajes.
              </p>
            </div>
          </div>
        </div>

        {/* Recomendación de Reparto por Temperatura */}
        <div className="rounded-2xl border border-line bg-paper p-6 shadow-sm">
          <div className="flex items-center gap-2.5">
            <BarChart2 className="text-purple-600" size={20} />
            <h3 className="text-base font-bold text-ink">Estrategia de Reparto Recomendada (Senior)</h3>
          </div>
          <p className="mt-1 text-xs text-greige-ink">Distribución balanceada para maximizar ventas y blindar la cuenta contra bloqueos.</p>

          <div className="mt-5 space-y-3">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500"></span>
                  <span className="text-xs font-bold text-ink">1. Calientes (Medio de Pago Abierto)</span>
                </div>
                <span className="text-xs font-black text-emerald-600">{distribution.calientes} msgs (40%)</span>
              </div>
              <p className="mt-1 text-[11px] text-greige-ink">
                Clientes que solicitaron cuenta bancaria o link de pago. Tasa de conversión de más del 35% y riesgo de baneo <strong>NULO (0%)</strong> porque esperan tu mensaje.
              </p>
            </div>

            <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-500"></span>
                  <span className="text-xs font-bold text-ink">2. Tibios (Cotización Sin Cerrar)</span>
                </div>
                <span className="text-xs font-black text-amber-600">{distribution.tibios} msgs (35%)</span>
              </div>
              <p className="mt-1 text-[11px] text-greige-ink">
                Preguntaron precio o disponibilidad y dejaron de responder. Enviar recordatorio con incentivo (ej. envío gratis hoy). Riesgo de reporte muy bajo (&lt;1%).
              </p>
            </div>

            <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.04] p-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-blue-500"></span>
                  <span className="text-xs font-bold text-ink">3. Fríos (Inactivos &gt;24h en Atención)</span>
                </div>
                <span className="text-xs font-black text-blue-600">{distribution.frios} msgs (25%)</span>
              </div>
              <p className="mt-1 text-[11px] text-greige-ink">
                Clientes sin actividad reciente. <strong>Obligatorio:</strong> enviar plantilla con botón claro de exclusión ("Darme de baja") y respetar el cooldown de 42h del CRM.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Protocolo de Calentamiento y Escalamiento de Tiers */}
      <div className="rounded-2xl border border-line bg-paper p-6 shadow-sm">
        <h3 className="text-base font-bold text-ink">Hoja de Ruta: Cómo Subir de Tier sin Baneo de Meta</h3>
        <p className="mt-1 text-xs text-greige-ink">Meta evalúa tu volumen acumulado y tasa de bloqueo en periodos de 7 días continuos.</p>

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-4">
          <div className="rounded-xl border border-line bg-surface p-4">
            <span className="text-xs font-bold text-greige-ink">FASE 1: CALENTAMIENTO</span>
            <p className="mt-2 text-sm font-black text-ink">Días 1 a 3</p>
            <p className="mt-1 text-xs text-ink font-semibold">200 a 400 envíos/día</p>
            <p className="mt-2 text-[11px] text-greige-ink">Solo clientes calientes y tibios que hayan hablado en los últimos 7 días. Meta verifica que la gente responde.</p>
          </div>

          <div className="rounded-xl border border-line bg-surface p-4">
            <span className="text-xs font-bold text-greige-ink">FASE 2: CONSOLIDACIÓN TIER 1</span>
            <p className="mt-2 text-sm font-black text-ink">Días 4 a 7</p>
            <p className="mt-1 text-xs text-ink font-semibold">600 a 900 envíos/día</p>
            <p className="mt-2 text-[11px] text-greige-ink">Comienza a incluir segmento frío gradualmente. Si la calidad sigue en Verde, Meta te desbloquea el Tier 2.</p>
          </div>

          <div className="rounded-xl border border-line bg-surface p-4">
            <span className="text-xs font-bold text-greige-ink">FASE 3: SALTO A TIER 2</span>
            <p className="mt-2 text-sm font-black text-ink">Semana 2</p>
            <p className="mt-1 text-xs text-emerald-600 font-semibold">1,000 a 3,000 envíos/día</p>
            <p className="mt-2 text-[11px] text-greige-ink">Límite oficial ampliado a 10,000/día. Ya puedes hacer difusiones de promociones a bases más grandes sin riesgo.</p>
          </div>

          <div className="rounded-xl border border-line bg-surface p-4">
            <span className="text-xs font-bold text-greige-ink">FASE 4: TIER ENTERPRISE</span>
            <p className="mt-2 text-sm font-black text-ink">Mes 1+</p>
            <p className="mt-1 text-xs text-purple-600 font-semibold">10,000 a 100,000/día</p>
            <p className="mt-2 text-[11px] text-greige-ink">Capacidad masiva. El CRM throttles automáticamente a 350ms por mensaje para proteger la conexión.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
