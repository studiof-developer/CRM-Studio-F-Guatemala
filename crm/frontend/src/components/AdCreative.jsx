import { useEffect, useRef, useState } from 'react';
import { ImageOff, Play, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchMetaAdCreative } from '../api.js';

// Imagen del anuncio tal como la sirve Meta en el momento (no se guarda en el CRM). Una promesa por anuncio: la miniatura de la tabla y
// el visor comparten la misma llamada, y un error se puede reintentar la próxima vez.
const creatives = new Map();
function loadCreative(adId) {
  if (!creatives.has(adId)) creatives.set(adId, fetchMetaAdCreative(adId).catch((err) => { creatives.delete(adId); throw err; }));
  return creatives.get(adId);
}

function useCreative(adId, enabled = true) {
  const [state, setState] = useState({ creative: null, error: null });
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setState({ creative: null, error: null });
    loadCreative(adId).then((creative) => { if (!cancelled) setState({ creative, error: null }); }).catch((err) => { if (!cancelled) setState({ creative: null, error: err.message }); });
    return () => { cancelled = true; };
  }, [adId, enabled]);
  return state;
}

export function AdThumb({ adId, name, onOpen }) {
  // Solo se pide a Meta la imagen de las filas que llegan a verse: una cuenta con decenas de anuncios no dispara decenas de llamadas juntas.
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } });
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  const { creative, error } = useCreative(adId, seen);
  const src = creative?.thumbnailUrl ?? creative?.imageUrl;
  return (
    <button ref={ref} type="button" onClick={onOpen} title={error ?? `Ver imagen de ${name}`} className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-muted text-greige-ink hover:border-ink">
      {src ? <img src={src} alt={name} loading="lazy" className="h-full w-full object-cover" /> : error ? <ImageOff size={16} /> : <span className="h-full w-full animate-pulse bg-black/5 dark:bg-white/10" />}
      {creative?.videoUrl && <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-white"><Play size={14} fill="currentColor" /></span>}
    </button>
  );
}

// Visor a pantalla completa: imagen grande (o video), flechas/teclado para recorrer los anuncios de la tabla en el orden en que se ven.
export function AdViewer({ ads, index, onIndex, onClose }) {
  const ad = ads[index];
  const { creative, error } = useCreative(ad.id);
  const [play, setPlay] = useState(false);
  useEffect(() => { setPlay(false); }, [ad.id]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && index < ads.length - 1) onIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, ads.length, onIndex, onClose]);
  const src = creative?.imageUrl ?? creative?.thumbnailUrl;
  const nav = 'absolute top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 disabled:hidden';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label={ad.name}>
      <div className="relative flex max-h-full w-full max-w-3xl flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 text-white">
          <div className="min-w-0"><div className="truncate text-sm font-semibold">{ad.name}</div><div className="truncate text-[11px] text-white/70">{[ad.campaign, ad.adset].filter(Boolean).join(' › ')} · {index + 1} de {ads.length}</div></div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-full bg-black/50 p-1.5 hover:bg-black/70"><X size={16} /></button>
        </div>
        <div className="relative flex min-h-[200px] items-center justify-center overflow-hidden rounded-2xl bg-black/40">
          {play && creative?.videoUrl ? <video src={creative.videoUrl} poster={src} controls autoPlay className="max-h-[70vh] w-full" />
            : src ? <img src={src} alt={ad.name} className="max-h-[70vh] w-full object-contain" />
            : error ? <p className="p-8 text-center text-sm text-white/80">No se pudo cargar la imagen: {error}</p>
            : <span className="h-48 w-full animate-pulse bg-white/10" />}
          {!play && creative?.videoUrl && <button type="button" onClick={() => setPlay(true)} className="absolute flex h-14 w-14 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80" aria-label="Reproducir video"><Play size={22} fill="currentColor" /></button>}
          <button type="button" className={`${nav} left-2`} disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Anterior"><ChevronLeft size={20} /></button>
          <button type="button" className={`${nav} right-2`} disabled={index === ads.length - 1} onClick={() => onIndex(index + 1)} aria-label="Siguiente"><ChevronRight size={20} /></button>
        </div>
        <p className="text-center text-[11px] text-white/60">Imagen en vivo desde Meta — no se almacena en el CRM.</p>
      </div>
    </div>
  );
}
