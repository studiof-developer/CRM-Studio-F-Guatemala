import { useState } from 'react';
import { X, Search, Database, RefreshCw, CheckCircle2, AlertCircle, ListFilter, Server } from 'lucide-react';
import { inspectErp } from '../api.js';
import { Button } from './ui.jsx';

export default function ErpInspectModal({ onClose }) {
  const [query, setQuery] = useState('S176012A');
  const [loading, setLoading] = useState(false);
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState(null);
  const [probeResult, setProbeResult] = useState(null);
  const [error, setError] = useState(null);

  async function handleSearch(e) {
    if (e) e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await inspectErp({ q: query.trim() });
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleProbeEndpoints() {
    setProbing(true);
    setError(null);
    try {
      const data = await inspectErp({ probe: 'endpoints' });
      setProbeResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-paper border border-border shadow-2xl animate-in fade-in-50 zoom-in-95">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Database size={20} />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Diagnóstico y Consulta al ERP</h2>
              <p className="text-xs text-muted-foreground">
                Inspecciona en vivo los campos, referencias con "S", y precios provistos por el ERP.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Controls */}
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
            <form onSubmit={handleSearch} className="flex flex-1 items-center gap-2">
              <div className="relative flex-1">
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Ej. S176012A o letra S..."
                  className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none transition focus:border-primary"
                />
              </div>
              <Button type="submit" disabled={loading}>
                {loading ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
                Consultar en ERP
              </Button>
            </form>

            <Button variant="outline" onClick={handleProbeEndpoints} disabled={probing} className="shrink-0">
              {probing ? <RefreshCw size={14} className="animate-spin" /> : <Server size={14} />}
              Probar Endpoints
            </Button>
          </div>

          {/* Error notice */}
          {error && (
            <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              <AlertCircle size={18} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Error al consultar el ERP</p>
                <p className="mt-0.5 text-xs opacity-90">{error}</p>
              </div>
            </div>
          )}

          {/* Not configured notice */}
          {result && !result.configured && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertCircle size={18} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Conexión al ERP no configurada localmente</p>
                <p className="mt-1 text-xs opacity-90">
                  {result.message}
                </p>
                <p className="mt-2 text-xs font-semibold">
                  En el servidor de producción (donde están activas las variables ERP_API_KEY y ERP_CERT_FINGERPRINT), esta consulta devolverá los datos reales del ERP de inmediato.
                </p>
              </div>
            </div>
          )}

          {/* Probe Results */}
          {probeResult && probeResult.results && (
            <div className="space-y-3 rounded-xl border border-border p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Server size={16} className="text-primary" />
                Endpoints disponibles en el servidor ERP:
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {probeResult.results.map((res) => (
                  <div
                    key={res.path}
                    className={`rounded-lg border p-3 text-xs ${
                      res.ok && res.hasData
                        ? 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20'
                        : 'border-border bg-muted/20 opacity-75'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold">{res.path}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        res.ok && res.hasData
                          ? 'bg-emerald-600 text-white'
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {res.ok ? (res.hasData ? `${res.rowCount} filas` : '200 OK (vacío)') : 'No disponible'}
                      </span>
                    </div>
                    {res.columns && res.columns.length > 0 && (
                      <p className="mt-1 text-[11px] text-muted-foreground line-clamp-1">
                        Columnas: {res.columns.join(', ')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Main Inspection Result */}
          {result && result.ok && (
            <div className="space-y-6">
              {/* Summary cards */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-border bg-card p-3">
                  <span className="text-[11px] text-muted-foreground">Total filas en ERP</span>
                  <p className="mt-1 text-xl font-bold">{result.totalRows.toLocaleString()}</p>
                </div>
                <div className="rounded-xl border border-border bg-card p-3">
                  <span className="text-[11px] text-muted-foreground">Total columnas</span>
                  <p className="mt-1 text-xl font-bold">{result.columns?.length || 0}</p>
                </div>
                <div className="rounded-xl border border-border bg-card p-3">
                  <span className="text-[11px] text-muted-foreground">Coincidencias con "{query}"</span>
                  <p className="mt-1 text-xl font-bold text-primary">
                    {result.search ? result.search.totalFound : '-'}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-card p-3">
                  <span className="text-[11px] text-muted-foreground">Endpoint consultado</span>
                  <p className="mt-1 font-mono text-xs truncate" title={result.path}>{result.path}</p>
                </div>
              </div>

              {/* Columns detected */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <ListFilter size={14} /> Columnas devueltas por el ERP:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {result.columns?.map((col) => {
                    const isId = result.fieldAnalysis?.identifierCandidates?.includes(col);
                    const isPrice = result.fieldAnalysis?.priceCandidates?.includes(col);
                    return (
                      <span
                        key={col}
                        className={`rounded-md px-2 py-1 font-mono text-xs ${
                          isPrice
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 font-bold border border-emerald-300'
                            : isId
                            ? 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 font-semibold border border-blue-300'
                            : 'bg-muted text-foreground'
                        }`}
                      >
                        {col} {isPrice && '💰 (Precio)'} {isId && '🔑 (ID/Ref)'}
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* Matches found */}
              {result.search && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">
                      Resultados para "{result.search.query}":
                    </span>
                    {result.search.columnMatchCounts && (
                      <span className="text-xs text-muted-foreground">
                        Encontrado en:{' '}
                        {Object.entries(result.search.columnMatchCounts)
                          .map(([col, count]) => `${col} (${count})`)
                          .join(', ')}
                      </span>
                    )}
                  </div>

                  {result.search.matches?.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                      No se encontraron registros que contengan "{result.search.query}" en este endpoint.
                    </div>
                  ) : (
                    <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                      {result.search.matches.map((m, idx) => (
                        <div key={idx} className="rounded-xl border border-border bg-card p-3.5 text-xs space-y-2">
                          <div className="flex items-center gap-2">
                            <span className="rounded bg-primary/10 px-2 py-0.5 font-medium text-primary">
                              Item #{idx + 1}
                            </span>
                            <span className="text-muted-foreground">
                              Match en: <strong className="text-foreground">{m.matchedColumns.join(', ')}</strong>
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 rounded-lg bg-muted/40 p-2.5 font-mono text-[11px]">
                            {Object.entries(m.data).map(([key, val]) => (
                              <div key={key} className={m.matchedColumns.includes(key) ? 'font-bold text-primary bg-primary/10 rounded px-1' : ''}>
                                <span className="text-muted-foreground text-[10px] block">{key}</span>
                                <span className="truncate block" title={String(val)}>{String(val ?? 'null')}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Sample Raw Row */}
              {result.sampleRows && result.sampleRows.length > 0 && (
                <div className="space-y-2">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Ejemplo de registro completo del ERP:
                  </span>
                  <pre className="max-h-48 overflow-auto rounded-xl bg-neutral-900 p-3.5 text-[11px] font-mono text-neutral-100">
                    {JSON.stringify(result.sampleRows[0], null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-border bg-muted/20 px-6 py-3">
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    </div>
  );
}
