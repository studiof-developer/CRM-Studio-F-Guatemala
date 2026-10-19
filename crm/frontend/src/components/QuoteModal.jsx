import { useState, useMemo, useEffect } from 'react';
import {
  Search,
  Plus,
  Trash2,
  X,
  Calculator,
  Image as ImageIcon,
  Loader2,
  Download,
  Send,
  Eye,
  Copy,
  Sparkles,
  Truck,
  Tag,
} from 'lucide-react';
import { generateQuoteCardBlob } from '../lib/quoteImageGenerator.js';
import { createQuote, fetchProducts, productImageUrl } from '../api.js';
import { showSuccess, showError } from './Toast.jsx';

const QUICK_DISCOUNTS = [0, 10, 15, 20, 30, 40, 50];

export default function QuoteModal({
  open,
  onClose,
  customer,
  activeLine,
  advisor,
  catalog = [],
  onSendQuoteImage,
}) {
  const [search, setSearch] = useState('');
  const [serverResults, setServerResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [items, setItems] = useState([]);
  const [shippingCost, setShippingCost] = useState(0);
  const [customNote, setCustomNote] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [previewBlobUrl, setPreviewBlobUrl] = useState(null);
  const [showPreview, setShowPreview] = useState(false);

  // Limpiar vista previa al cerrar
  useEffect(() => {
    if (!open) {
      setShowPreview(false);
      if (previewBlobUrl) {
        URL.revokeObjectURL(previewBlobUrl);
        setPreviewBlobUrl(null);
      }
    }
  }, [open, previewBlobUrl]);

  // Búsqueda dinámica en backend / catálogo cuando el usuario escribe
  useEffect(() => {
    const q = search.trim();
    if (!q || q.length < 2) {
      setServerResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const timer = setTimeout(() => {
      fetchProducts(q)
        .then((res) => {
          if (search.trim() === q) {
            setServerResults(Array.isArray(res) ? res : []);
          }
        })
        .catch(() => {
          if (search.trim() === q) setServerResults([]);
        })
        .finally(() => {
          if (search.trim() === q) setSearching(false);
        });
    }, 200);

    return () => clearTimeout(timer);
  }, [search]);

  // Combina resultados locales precargados y los encontrados dinámicamente en servidor
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || q.length < 2) return [];

    const matchesFilter = (p) =>
      (p.reference || '').toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q) ||
      (p.name || '').toLowerCase().includes(q) ||
      (p.color || '').toLowerCase().includes(q) ||
      (p.barcode || '').toLowerCase().includes(q);

    const serverMatches = serverResults.filter(matchesFilter);
    if (serverMatches.length > 0) return serverMatches.slice(0, 12);

    return catalog.filter(matchesFilter).slice(0, 12);
  }, [search, serverResults, catalog]);

  function invalidatePreview() {
    if (previewBlobUrl) {
      URL.revokeObjectURL(previewBlobUrl);
      setPreviewBlobUrl(null);
    }
  }

  function addItem(product) {
    const unitPrice = Number(product.price) || 0;
    const discountPct = Number(product.discount_pct) || 0;
    const finalPrice = unitPrice * (1 - discountPct / 100);

    const newItem = {
      productId: product.id || null,
      sku: String(product.reference || product.sku || 'REF'),
      reference: product.reference || null,
      barcode: product.barcode || null,
      name: String(product.name || 'Prenda Studio F'),
      size: String(product.size || ''),
      color: String(product.color || ''),
      imageUrl: product.image_url || null,
      unitPrice,
      discountPct,
      finalPrice,
      quantity: 1,
    };

    setItems((prev) => [...prev, newItem]);
    setSearch('');
    setServerResults([]);
    invalidatePreview();
  }

  function addCustomItem() {
    const raw = search.trim();
    const newItem = {
      productId: null,
      sku: raw ? raw.toUpperCase() : `REF-${items.length + 1}`,
      name: 'Prenda personalizada',
      size: '',
      color: '',
      imageUrl: null,
      unitPrice: 499,
      discountPct: 0,
      finalPrice: 499,
      quantity: 1,
    };
    setItems((prev) => [...prev, newItem]);
    setSearch('');
    setServerResults([]);
    invalidatePreview();
  }

  function updateItem(index, field, value) {
    setItems((prev) => {
      const copy = [...prev];
      const item = { ...copy[index] };

      if (field === 'quantity') {
        item.quantity = Math.max(1, Number(value) || 1);
      } else if (field === 'unitPrice') {
        item.unitPrice = Math.max(0, Number(value) || 0);
        item.finalPrice = item.unitPrice * (1 - item.discountPct / 100);
      } else if (field === 'discountPct') {
        item.discountPct = Math.min(100, Math.max(0, Number(value) || 0));
        item.finalPrice = item.unitPrice * (1 - item.discountPct / 100);
      } else if (field === 'finalPrice') {
        item.finalPrice = Math.max(0, Number(value) || 0);
        if (item.unitPrice > 0) {
          const calculatedPct = ((item.unitPrice - item.finalPrice) / item.unitPrice) * 100;
          item.discountPct = Math.round(Math.max(0, Math.min(100, calculatedPct)));
        }
      } else if (field === 'name') {
        item.name = value;
      } else if (field === 'sku') {
        item.sku = value;
      } else if (field === 'size') {
        item.size = value;
      } else if (field === 'color') {
        item.color = value;
      }

      copy[index] = item;
      return copy;
    });
    invalidatePreview();
  }

  function applyGlobalDiscount(pct) {
    setItems((prev) =>
      prev.map((item) => {
        const discountPct = Math.min(100, Math.max(0, Number(pct) || 0));
        return {
          ...item,
          discountPct,
          finalPrice: item.unitPrice * (1 - discountPct / 100),
        };
      })
    );
    invalidatePreview();
  }

  function removeItem(index) {
    setItems((prev) => prev.filter((_, i) => i !== index));
    invalidatePreview();
  }

  // Cálculos totales
  const subtotal = useMemo(() => {
    return items.reduce((sum, item) => sum + (Number(item.unitPrice) || 0) * (Number(item.quantity) || 1), 0);
  }, [items]);

  const itemsTotalAfterDiscount = useMemo(() => {
    return items.reduce((sum, item) => sum + (Number(item.finalPrice) || 0) * (Number(item.quantity) || 1), 0);
  }, [items]);

  const discountTotal = useMemo(() => {
    return Math.max(0, subtotal - itemsTotalAfterDiscount);
  }, [subtotal, itemsTotalAfterDiscount]);

  const grandTotal = useMemo(() => {
    return itemsTotalAfterDiscount + (Math.max(0, Number(shippingCost) || 0));
  }, [itemsTotalAfterDiscount, shippingCost]);

  // Genera el texto para el mensaje de WhatsApp / Red Social. Sin folio ni leyenda de vigencia (el folio va en la
  // tarjeta). Una sola prenda: el detalle completo. Varias: una línea por prenda (referencia, talla, precio) para
  // que una cotización larga no sature el chat. El total va en "Total a pagar", que lee el motor de ventas.
  function buildQuoteMessageText() {
    const brand = activeLine?.label || 'Studio F';
    let text = `✨ *Cotización ${brand}* ✨\n\n`;
    const totalPieces = items.reduce((s, i) => s + (Number(i.quantity) || 1), 0);
    const money = (n) => `Q${(Number(n) || 0).toFixed(2)}`;

    if (items.length === 1) {
      const item = items[0];
      const qty = Math.max(1, Number(item.quantity) || 1);
      const detail = [item.size ? `Talla ${item.size}` : '', item.color ? `Color ${item.color}` : '', qty > 1 ? `${qty} uds` : ''].filter(Boolean).join(' · ');
      text += `👗 *${item.name || 'Prenda'}* (Ref: \`${item.sku || 'N/A'}\`)${detail ? ` — _${detail}_` : ''}\n`;
      text += `• Precio regular: ${money(item.unitPrice)}\n`;
      if (Number(item.discountPct) > 0) text += `• Descuento: *-${Number(item.discountPct)}%*\n`;
      text += `• Subtotal: *${money((Number(item.finalPrice) || 0) * qty)}*\n\n`;
    } else {
      items.forEach((item) => {
        const qty = Math.max(1, Number(item.quantity) || 1);
        const regular = (Number(item.unitPrice) || 0) * qty;
        const final = (Number(item.finalPrice) || 0) * qty;
        const price = Number(item.discountPct) > 0 ? `${money(regular)} → *${money(final)}*` : `*${money(final)}*`;
        const detail = [item.size ? `Talla ${item.size}` : '', qty > 1 ? `x${qty}` : ''].filter(Boolean).join(' · ');
        text += `👗 ${item.sku || 'N/A'}${detail ? ` · ${detail}` : ''} · ${price}\n`;
      });
      text += '\n';
    }

    text += `━━━━━━━━━━━━━━━━━━━\n`;
    if (Number(shippingCost) > 0) text += `🚚 Envío a domicilio: ${money(shippingCost)}\n`;
    if (customNote.trim()) text += `📌 _${customNote.trim()}_\n`;
    text += `🛍️ *Total a pagar (${totalPieces} prenda${totalPieces !== 1 ? 's' : ''}): ${money(grandTotal)}*`;
    if (items.length === 1 && discountTotal > 0) text += `\n🎉 *¡Te ahorras ${money(discountTotal)}!*`;

    return text;
  }

  async function handlePreview() {
    if (!items.length) {
      showError('Agrega al menos una prenda para previsualizar');
      return;
    }
    setIsGenerating(true);
    try {
      const blob = await generateQuoteCardBlob({
        brandName: activeLine?.label || 'STUDIO F',
        quoteNumber: 'COT-VISTA-PREVIA',
        advisorName: advisor?.fullName || 'Asesor de Ventas',
        customerName: customer?.fullName || customer?.whatsappNumber || 'Cliente',
        items,
        subtotal,
        discountTotal,
        shippingCost: Number(shippingCost) || 0,
        grandTotal,
        customNote,
      });
      if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
      const url = URL.createObjectURL(blob);
      setPreviewBlobUrl(url);
      setShowPreview(true);
    } catch (err) {
      showError(err.message || 'No se pudo generar la vista previa');
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleCopyTextOnly() {
    if (!items.length) return;
    const text = buildQuoteMessageText(`COT-${new Date().getFullYear()}`);
    try {
      await navigator.clipboard.writeText(text);
      showSuccess('Resumen de cotización copiado al portapapeles');
    } catch {
      showError('No se pudo copiar al portapapeles');
    }
  }

  /**
   * mode:
   * - 'send_now': envía directo al chat del cliente (toma la conversación automáticamente si estaba en espera)
   * - 'stage': pasa la imagen y el texto a la caja de escritura del chat para editar antes de enviar
   * - 'download': descarga el PNG y copia el texto al portapapeles
   */
  async function handleProcessQuote(mode = 'send_now') {
    if (!items.length) {
      showError('Agrega al menos una prenda para cotizar');
      return;
    }
    setIsGenerating(true);
    try {
      // 1. Guardar en base de datos (con fallback resiliente para que NUNCA bloquee al asesor)
      let quoteNum = `COT-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`;
      try {
        const saved = await createQuote({
          customerId: customer?.id || null,
          whatsappNumber: customer?.whatsappNumber || null,
          whatsappNumberId: activeLine?.id || null,
          items,
          subtotal,
          discountTotal,
          grandTotal,
          notes:
            customNote.trim() ||
            `Cotización de ${items.length} prendas por ${advisor?.fullName || 'Asesor'}`,
        });
        if (saved?.quoteNumber) {
          quoteNum = saved.quoteNumber;
        }
      } catch (dbErr) {
        console.warn('Fallback a correlativo local de cotización:', dbErr);
      }

      // 2. Generar tarjeta en imagen PNG de alta resolución
      const blob = await generateQuoteCardBlob({
        brandName: activeLine?.label || 'STUDIO F',
        quoteNumber: quoteNum,
        advisorName: advisor?.fullName || 'Asesor de Ventas',
        customerName: customer?.fullName || customer?.whatsappNumber || 'Cliente',
        items,
        subtotal,
        discountTotal,
        shippingCost: Number(shippingCost) || 0,
        grandTotal,
        customNote,
      });

      const file = new File([blob], `cotizacion-${quoteNum}.png`, { type: 'image/png' });
      const caption = buildQuoteMessageText(quoteNum);

      if (mode === 'download' || !onSendQuoteImage) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cotizacion-${quoteNum}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        try {
          await navigator.clipboard.writeText(caption);
        } catch {
          /* ignore */
        }
        showSuccess(`Cotización ${quoteNum} descargada y texto copiado al portapapeles`);
        return;
      }

      // 3. Enviar directo al chat o pasar al borrador
      await onSendQuoteImage(file, caption, { sendImmediately: mode === 'send_now' });

      if (mode === 'send_now') {
        showSuccess(`Cotización ${quoteNum} enviada al cliente`);
      } else {
        showSuccess(`Cotización ${quoteNum} cargada en la barra de mensaje`);
      }
      onClose();
    } catch (err) {
      showError(err.message || 'Error al procesar la cotización');
    } finally {
      setIsGenerating(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <div className="flex h-[92vh] max-h-[860px] w-full max-w-4xl flex-col rounded-2xl bg-paper shadow-2xl border border-line overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-6 py-4 bg-black/[0.02] dark:bg-white/[0.02]">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-white shadow-sm">
              <Calculator size={18} />
            </span>
            <div>
              <h2 className="text-base font-semibold text-ink">Cotizador / Calculadora de Prendas</h2>
              <p className="text-xs text-greige-ink">
                Cliente: <span className="font-medium text-ink">{customer?.fullName || customer?.whatsappNumber || 'General'}</span> · Línea:{' '}
                <span className="font-medium text-ink">{activeLine?.label || 'Studio F'}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {items.length > 0 && (
              <button
                type="button"
                onClick={handlePreview}
                disabled={isGenerating}
                className="flex items-center gap-1.5 rounded-xl border border-line bg-paper px-3 py-1.5 text-xs font-semibold text-ink hover:bg-black/5 dark:hover:bg-white/5"
              >
                <Eye size={14} />
                {showPreview ? 'Actualizar Vista Previa' : 'Vista Previa PNG'}
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-greige hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Buscador de catálogo */}
          <div className="relative">
            <div className="mb-1.5 flex items-center justify-between">
              <label className="block text-xs font-semibold uppercase tracking-wider text-greige-ink">
                Buscar referencia en Catálogo o agregar prenda manual
              </label>
              <button
                type="button"
                onClick={addCustomItem}
                className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
              >
                <Plus size={13} /> + Agregar fila manual
              </button>
            </div>
            <div className="relative flex items-center">
              <Search size={16} className="absolute left-3.5 text-greige pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (searchResults.length > 0) {
                      addItem(searchResults[0]);
                    } else if (search.trim()) {
                      addCustomItem();
                    }
                  }
                }}
                placeholder="Escribe referencia (ej. S176012A, S042), nombre, color o código de barras... (Enter para agregar)"
                className="w-full rounded-xl border border-line bg-black/[0.02] dark:bg-white/[0.04] py-2.5 pl-10 pr-28 text-sm text-ink outline-none focus:border-accent focus:bg-paper"
              />
              {searching ? (
                <Loader2 size={16} className="absolute right-3 text-greige animate-spin" />
              ) : search.trim() ? (
                <button
                  type="button"
                  onClick={addCustomItem}
                  className="absolute right-2 rounded-lg bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent hover:bg-accent hover:text-white transition-colors"
                >
                  + Personalizada
                </button>
              ) : null}
            </div>

            {/* Dropdown de coincidencias */}
            {search.trim().length >= 2 && (
              <div className="absolute top-full left-0 z-20 mt-1.5 w-full rounded-xl border border-line bg-paper shadow-xl overflow-hidden divide-y divide-line-soft max-h-72 overflow-y-auto">
                {searching ? (
                  <div className="flex items-center gap-2.5 p-4 text-xs text-greige-ink">
                    <Loader2 size={16} className="animate-spin text-accent" />
                    <span>Buscando referencia en el catálogo...</span>
                  </div>
                ) : searchResults.length > 0 ? (
                  searchResults.map((prod) => (
                    <button
                      key={prod.id}
                      type="button"
                      onClick={() => addItem(prod)}
                      className="flex w-full items-center justify-between p-3 text-left hover:bg-accent-soft transition-colors gap-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {prod.image_url ? (
                          <img
                            src={productImageUrl(prod.image_url)}
                            alt=""
                            className="h-11 w-11 shrink-0 rounded-lg object-cover border border-line bg-white shadow-xs"
                          />
                        ) : (
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-black/5 dark:bg-white/5 text-greige">
                            <ImageIcon size={18} />
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-sm text-ink truncate">
                              {prod.reference || prod.sku}
                            </span>
                            {prod.reference && prod.sku && prod.sku !== prod.reference && (
                              <span className="text-[10px] font-mono text-greige truncate">({prod.sku})</span>
                            )}
                            {Number(prod.discount_pct) > 0 && (
                              <span className="rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-bold text-danger shrink-0">
                                -{Number(prod.discount_pct)}%
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-greige-ink truncate">
                            {prod.name} {prod.color ? `· ${prod.color}` : ''} {prod.size ? `· Talla ${prod.size}` : ''}
                          </p>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-bold text-sm text-ink">Q{Number(prod.price || 0).toFixed(2)}</span>
                        <p className="text-[11px] text-greige">Stock: {prod.stock_quantity ?? '—'}</p>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="p-4 text-center">
                    <p className="text-xs text-greige-ink mb-2">
                      No se encontró la referencia <strong className="text-ink">"{search.trim()}"</strong> en el catálogo cargado.
                    </p>
                    <button
                      type="button"
                      onClick={addCustomItem}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent hover:text-white transition-colors"
                    >
                      <Plus size={13} />
                      Cotizar "{search.trim().toUpperCase()}" manualmente
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Barra rápida de descuento global */}
          {items.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-black/[0.015] dark:bg-white/[0.02] px-3.5 py-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-greige-ink">
                <Tag size={13} className="text-accent" />
                <span>Aplicar descuento rápido a todas las prendas:</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {QUICK_DISCOUNTS.map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => applyGlobalDiscount(pct)}
                    className="rounded-lg border border-line bg-paper px-2.5 py-1 text-[11px] font-semibold text-ink hover:border-accent hover:bg-accent hover:text-white transition-colors"
                  >
                    {pct === 0 ? 'Sin desc.' : `-${pct}%`}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Tabla de ítems cotizados */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-greige-ink">
                Prendas en la cotización ({items.length})
              </span>
              {items.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setItems([]);
                    invalidatePreview();
                  }}
                  className="text-xs text-danger hover:underline"
                >
                  Vaciar lista
                </button>
              )}
            </div>

            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line p-8 text-center bg-black/[0.01]">
                <Calculator size={32} className="text-greige/50 mb-2" />
                <p className="text-sm font-medium text-ink">No hay prendas agregadas</p>
                <p className="text-xs text-greige-ink mt-0.5">
                  Busca por código o nombre arriba, o haz clic en "+ Agregar fila manual".
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-line bg-paper overflow-hidden shadow-xs divide-y divide-line-soft">
                {items.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex flex-wrap items-center justify-between gap-3 p-3.5 hover:bg-black/[0.01]"
                  >
                    <div className="flex items-start gap-2.5 min-w-[220px] flex-1">
                      {item.imageUrl ? (
                        <img
                          src={productImageUrl(item.imageUrl)}
                          alt=""
                          className="h-11 w-11 shrink-0 rounded-lg object-cover border border-line bg-white shadow-xs mt-0.5"
                        />
                      ) : null}
                      <div className="flex-1 min-w-0 space-y-1.5">
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={item.sku}
                            onChange={(e) => updateItem(idx, 'sku', e.target.value)}
                            className="font-bold text-xs text-ink bg-black/[0.03] dark:bg-white/[0.05] rounded px-2 py-0.5 outline-none focus:ring-1 focus:ring-accent w-28"
                            placeholder="Ref / SKU"
                          />
                          <input
                            type="text"
                            value={item.name}
                            onChange={(e) => updateItem(idx, 'name', e.target.value)}
                            className="text-xs font-medium text-ink bg-transparent border-b border-transparent focus:border-line outline-none flex-1 min-w-0"
                            placeholder="Nombre de la prenda"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={item.size}
                            onChange={(e) => updateItem(idx, 'size', e.target.value)}
                            className="text-[11px] text-greige-ink bg-black/[0.02] dark:bg-white/[0.04] border border-line-soft rounded px-2 py-0.5 outline-none focus:border-accent w-20"
                            placeholder="Talla (ej. 8, M)"
                          />
                          <input
                            type="text"
                            value={item.color}
                            onChange={(e) => updateItem(idx, 'color', e.target.value)}
                            className="text-[11px] text-greige-ink bg-black/[0.02] dark:bg-white/[0.04] border border-line-soft rounded px-2 py-0.5 outline-none focus:border-accent w-28"
                            placeholder="Color (ej. Negro)"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2.5">
                      {/* Cantidad */}
                      <div className="flex flex-col items-center">
                        <span className="text-[10px] text-greige uppercase">Cant</span>
                        <input
                          type="number"
                          min="1"
                          value={item.quantity}
                          onChange={(e) => updateItem(idx, 'quantity', e.target.value)}
                          className="w-12 text-center rounded-lg border border-line py-1 text-xs text-ink outline-none focus:border-accent"
                        />
                      </div>

                      {/* Precio Regular */}
                      <div className="flex flex-col items-end">
                        <span className="text-[10px] text-greige uppercase">Precio (Q)</span>
                        <input
                          type="number"
                          step="0.01"
                          value={item.unitPrice}
                          onChange={(e) => updateItem(idx, 'unitPrice', e.target.value)}
                          className="w-20 text-right rounded-lg border border-line py-1 px-2 text-xs text-ink outline-none focus:border-accent"
                        />
                      </div>

                      {/* % Descuento */}
                      <div className="flex flex-col items-end">
                        <span className="text-[10px] text-greige uppercase">% Desc</span>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={item.discountPct}
                          onChange={(e) => updateItem(idx, 'discountPct', e.target.value)}
                          className="w-16 text-right rounded-lg border border-line py-1 px-2 text-xs font-semibold text-danger outline-none focus:border-accent"
                        />
                      </div>

                      {/* Precio Final c/u */}
                      <div className="flex flex-col items-end">
                        <span className="text-[10px] text-greige uppercase">P. Final (Q)</span>
                        <input
                          type="number"
                          step="0.01"
                          value={item.finalPrice ? Number(item.finalPrice.toFixed(2)) : 0}
                          onChange={(e) => updateItem(idx, 'finalPrice', e.target.value)}
                          className="w-20 text-right rounded-lg border border-line py-1 px-2 text-xs font-semibold text-ink outline-none focus:border-accent"
                          title="Edita el precio final o usa el % de descuento"
                        />
                      </div>

                      {/* Subtotal Ítem */}
                      <div className="flex flex-col items-end min-w-[72px]">
                        <span className="text-[10px] text-greige uppercase">Subtotal</span>
                        <span className="text-xs font-bold text-ink py-1">
                          Q{((Number(item.finalPrice) || 0) * (Number(item.quantity) || 1)).toFixed(2)}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => removeItem(idx)}
                        className="text-greige hover:text-danger p-1"
                        title="Eliminar prenda"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Opciones de Envío y Nota + Cuadro de Totales */}
          {items.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Envío y Observación */}
              <div className="rounded-xl border border-line bg-black/[0.015] dark:bg-white/[0.02] p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                    <Truck size={14} className="text-accent" />
                    Envío a domicilio (Q)
                  </label>
                  <div className="flex items-center gap-1.5">
                    {[0, 56].map((cost) => (
                      <button
                        key={cost}
                        type="button"
                        onClick={() => {
                          setShippingCost(cost);
                          invalidatePreview();
                        }}
                        className={`rounded-lg px-2 py-0.5 text-[11px] font-semibold border transition-colors ${
                          Number(shippingCost) === cost
                            ? 'bg-accent text-white border-accent'
                            : 'bg-paper text-greige-ink border-line hover:text-ink'
                        }`}
                      >
                        {cost === 0 ? 'Gratis' : `Q${cost}`}
                      </button>
                    ))}
                    <input
                      type="number"
                      min="0"
                      value={shippingCost}
                      onChange={(e) => {
                        setShippingCost(Math.max(0, Number(e.target.value) || 0));
                        invalidatePreview();
                      }}
                      className="w-16 rounded-lg border border-line bg-paper px-2 py-0.5 text-right text-xs font-semibold text-ink outline-none focus:border-accent"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium text-greige-ink">
                    Nota u observación en la tarjeta (opcional)
                  </label>
                  <input
                    type="text"
                    value={customNote}
                    onChange={(e) => {
                      setCustomNote(e.target.value);
                      invalidatePreview();
                    }}
                    placeholder="Ej. Envío gratis por compra mayor a Q500 / Reserva en sede Oakland Mall"
                    className="w-full rounded-lg border border-line bg-paper px-3 py-1.5 text-xs text-ink outline-none focus:border-accent"
                  />
                </div>
              </div>

              {/* Resumen Financiero */}
              <div className="flex flex-col justify-between rounded-xl bg-black/[0.03] dark:bg-white/[0.04] p-4 border border-line">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-greige-ink">
                    <span>Subtotal regular ({items.reduce((s, i) => s + (Number(i.quantity) || 1), 0)} prendas):</span>
                    <span className="font-medium text-ink">Q{subtotal.toFixed(2)}</span>
                  </div>
                  {discountTotal > 0 && (
                    <div className="flex justify-between text-xs font-semibold text-success">
                      <span>🎉 Ahorro por descuento:</span>
                      <span>-Q{discountTotal.toFixed(2)}</span>
                    </div>
                  )}
                  {Number(shippingCost) > 0 && (
                    <div className="flex justify-between text-xs text-greige-ink">
                      <span>Envío a domicilio:</span>
                      <span className="font-medium text-ink">Q{Number(shippingCost).toFixed(2)}</span>
                    </div>
                  )}
                </div>

                <div className="mt-3 pt-2.5 border-t border-line flex items-baseline justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-greige-ink">TOTAL A PAGAR</span>
                  <span className="text-2xl font-bold tracking-tight text-ink">Q{grandTotal.toFixed(2)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Vista previa de la tarjeta generada */}
          {showPreview && previewBlobUrl && (
            <div className="rounded-xl border border-line bg-black/[0.02] p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-ink flex items-center gap-1.5">
                  <Sparkles size={14} className="text-accent" />
                  Vista previa de la tarjeta PNG que recibirá el cliente
                </span>
                <button
                  type="button"
                  onClick={() => setShowPreview(false)}
                  className="text-xs text-greige hover:text-ink"
                >
                  Ocultar vista previa
                </button>
              </div>
              <div className="flex justify-center overflow-hidden rounded-lg border border-line bg-white p-2">
                <img
                  src={previewBlobUrl}
                  alt="Vista previa de cotización"
                  className="max-h-96 w-auto object-contain rounded shadow-sm"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-6 py-4 bg-paper">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopyTextOnly}
              disabled={items.length === 0 || isGenerating}
              className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-xs font-semibold text-greige-ink hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink disabled:opacity-50"
              title="Copiar únicamente el desglose en texto"
            >
              <Copy size={13} />
              Copiar Texto
            </button>
            <button
              type="button"
              onClick={() => handleProcessQuote('download')}
              disabled={items.length === 0 || isGenerating}
              className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-xs font-semibold text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
              title="Descargar imagen PNG y copiar texto al portapapeles"
            >
              <Download size={14} />
              Descargar PNG
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-line px-3.5 py-2 text-xs font-semibold text-ink hover:bg-black/5 dark:hover:bg-white/5"
            >
              Cancelar
            </button>

            {onSendQuoteImage ? (
              <>
                <button
                  type="button"
                  onClick={() => handleProcessQuote('stage')}
                  disabled={items.length === 0 || isGenerating}
                  className="flex items-center gap-1.5 rounded-xl border border-accent/40 bg-accent/10 px-3.5 py-2 text-xs font-semibold text-accent hover:bg-accent/20 disabled:opacity-50"
                  title="Coloca la imagen y el texto en la caja del chat para que puedas editarlo antes de enviar"
                >
                  <ImageIcon size={14} />
                  Pasar al Borrador
                </button>
                <button
                  type="button"
                  onClick={() => handleProcessQuote('send_now')}
                  disabled={items.length === 0 || isGenerating}
                  className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2 text-xs font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-50"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Enviando…
                    </>
                  ) : (
                    <>
                      <Send size={14} />
                      Enviar Cotización al Chat
                    </>
                  )}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => handleProcessQuote('download')}
                disabled={items.length === 0 || isGenerating}
                className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2 text-xs font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-50"
              >
                {isGenerating ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Generando…
                  </>
                ) : (
                  <>
                    <Download size={14} />
                    Descargar Cotización PNG
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
