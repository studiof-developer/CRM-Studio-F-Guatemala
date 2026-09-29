import { useState, useMemo, useEffect } from 'react';
import { Search, Plus, Trash2, X, Calculator, Image as ImageIcon, Check, Loader2 } from 'lucide-react';
import { generateQuoteCardBlob } from '../lib/quoteImageGenerator.js';
import { createQuote, fetchProducts } from '../api.js';
import { showSuccess, showError } from './Toast.jsx';

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
  const [isGenerating, setIsGenerating] = useState(false);
  const [previewBlobUrl, setPreviewBlobUrl] = useState(null);

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

    // Prioriza resultados directos de la base de datos que coincidan con lo escrito
    const serverMatches = serverResults.filter(
      (p) => (p.sku || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)
    );
    if (serverMatches.length > 0) return serverMatches.slice(0, 8);

    // Fallback al catálogo precargado en memoria (también filtrando estrictamente por q)
    return catalog
      .filter((p) => (p.sku || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [search, serverResults, catalog]);

  function addItem(product) {
    const unitPrice = Number(product.price) || 0;
    const discountPct = Number(product.discount_pct) || 0;
    const finalPrice = unitPrice * (1 - discountPct / 100);

    const newItem = {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      size: product.size || '',
      color: product.color || '',
      unitPrice,
      discountPct,
      finalPrice,
      quantity: 1,
    };

    setItems((prev) => [...prev, newItem]);
    setSearch('');
    setServerResults([]);
    setPreviewBlobUrl(null);
  }

  function addCustomItem() {
    if (!search.trim()) return;
    const newItem = {
      productId: null,
      sku: search.trim().toUpperCase(),
      name: 'Prenda personalizada',
      size: '',
      color: '',
      unitPrice: 150,
      discountPct: 0,
      finalPrice: 150,
      quantity: 1,
    };
    setItems((prev) => [...prev, newItem]);
    setSearch('');
    setServerResults([]);
    setPreviewBlobUrl(null);
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
      }

      copy[index] = item;
      return copy;
    });
    setPreviewBlobUrl(null);
  }

  function removeItem(index) {
    setItems((prev) => prev.filter((_, i) => i !== index));
    setPreviewBlobUrl(null);
  }

  // Cálculos totales
  const subtotal = useMemo(() => {
    return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  }, [items]);

  const grandTotal = useMemo(() => {
    return items.reduce((sum, item) => sum + item.finalPrice * item.quantity, 0);
  }, [items]);

  const discountTotal = useMemo(() => {
    return Math.max(0, subtotal - grandTotal);
  }, [subtotal, grandTotal]);

  // Genera el texto para el mensaje de WhatsApp
  function buildQuoteMessageText(quoteNumber) {
    const brand = activeLine?.label || 'Studio F';
    let text = `✨ *Cotización ${brand}* ✨\nFolio: *${quoteNumber}*\n\n`;

    items.forEach((item) => {
      text += `👗 *${item.name}* (Ref: \`${item.sku}\`)\n`;
      text += `• Precio regular: Q${Number(item.unitPrice).toFixed(2)}\n`;
      if (item.discountPct > 0) {
        text += `• Descuento: *${item.discountPct}%*\n`;
      }
      text += `• Subtotal: *Q${(item.finalPrice * item.quantity).toFixed(2)}*\n\n`;
    });

    text += `━━━━━━━━━━━━━━━━━━━\n`;
    text += `🛍️ *Total (${items.length} prenda${items.length !== 1 ? 's' : ''}): Q${grandTotal.toFixed(2)}*\n`;
    if (discountTotal > 0) {
      text += `🎉 *¡Te ahorras Q${discountTotal.toFixed(2)}!*\n`;
    }
    text += `━━━━━━━━━━━━━━━━━━━\n`;
    text += `_Cotización válida por 48 horas sujeta a existencias._`;

    return text;
  }

  async function handleSend() {
    if (!items.length) {
      showError('Agrega al menos una prenda para cotizar');
      return;
    }
    setIsGenerating(true);
    try {
      // 1. Guardar en base de datos
      const saved = await createQuote({
        customerId: customer.id,
        whatsappNumberId: activeLine?.id || null,
        items,
        subtotal,
        discountTotal,
        grandTotal,
        notes: `Cotización de ${items.length} prendas por ${advisor?.fullName || 'Asesor'}`,
      });

      const quoteNum = saved.quoteNumber || 'COT-2026-0001';

      // 2. Generar tarjeta en imagen PNG
      const blob = await generateQuoteCardBlob({
        brandName: activeLine?.label || 'STUDIO F',
        quoteNumber: quoteNum,
        advisorName: advisor?.fullName || 'Asesor de Ventas',
        customerName: customer?.fullName || customer?.whatsappNumber || 'Cliente',
        items,
        subtotal,
        discountTotal,
        grandTotal,
      });

      const file = new File([blob], `cotizacion-${quoteNum}.png`, { type: 'image/png' });
      const caption = buildQuoteMessageText(quoteNum);

      // 3. Enviar a través del chat
      if (onSendQuoteImage) {
        await onSendQuoteImage(file, caption);
      }

      showSuccess(`Cotización ${quoteNum} generada y lista para enviar`);
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
      <div className="flex h-[90vh] max-h-[820px] w-full max-w-3xl flex-col rounded-2xl bg-paper shadow-2xl border border-line overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-6 py-4 bg-black/[0.02] dark:bg-white/[0.02]">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-white shadow-sm">
              <Calculator size={18} />
            </span>
            <div>
              <h2 className="text-base font-semibold text-ink">Cotizador de Prendas</h2>
              <p className="text-xs text-greige-ink">
                Cliente: <span className="font-medium text-ink">{customer?.fullName || customer?.whatsappNumber}</span> · Línea: <span className="font-medium text-ink">{activeLine?.label || 'Studio F'}</span>
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-greige hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink">
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Buscador de catálogo */}
          <div className="relative">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-greige-ink">
              Buscar referencia en Catálogo o SKU
            </label>
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
                placeholder="Escribe código (ej. S176012A, BLU) o nombre de prenda... (Enter para agregar)"
                className="w-full rounded-xl border border-line bg-black/[0.02] dark:bg-white/[0.04] py-2.5 pl-10 pr-24 text-sm text-ink outline-none focus:border-accent focus:bg-paper"
              />
              {searching ? (
                <Loader2 size={16} className="absolute right-3 text-greige animate-spin" />
              ) : search.trim() ? (
                <button
                  type="button"
                  onClick={addCustomItem}
                  className="absolute right-2 rounded-lg bg-black/5 dark:bg-white/10 px-2.5 py-1 text-xs font-medium text-ink hover:bg-black/10"
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
                      className="flex w-full items-center justify-between p-3 text-left hover:bg-accent-soft transition-colors"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-ink">{prod.sku}</span>
                          {Number(prod.discount_pct) > 0 && (
                            <span className="rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-bold text-danger">
                              -{Number(prod.discount_pct)}%
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-greige-ink">{prod.name} {prod.color ? `· ${prod.color}` : ''}</p>
                      </div>
                      <div className="text-right">
                        <span className="font-bold text-sm text-ink">Q{Number(prod.price || 0).toFixed(2)}</span>
                        <p className="text-[11px] text-greige">Stock: {prod.stock_quantity ?? '—'}</p>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="p-4 text-center">
                    <p className="text-xs text-greige-ink mb-2">
                      No se encontró la referencia <strong className="text-ink">"{search.trim()}"</strong> en el catálogo.
                    </p>
                    <button
                      type="button"
                      onClick={addCustomItem}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent hover:text-white transition-colors"
                    >
                      <Plus size={13} />
                      Cotizar "{search.trim().toUpperCase()}" como personalizada
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Tabla de ítems cotizados */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-greige-ink">
                Prendas en la cotización ({items.length})
              </span>
              {items.length > 0 && (
                <button
                  onClick={() => setItems([])}
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
                <p className="text-xs text-greige-ink mt-0.5">Usa el buscador arriba para agregar las referencias que consultó el cliente.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-line bg-paper overflow-hidden shadow-xs divide-y divide-line-soft">
                {items.map((item, idx) => (
                  <div key={idx} className="flex flex-wrap items-center justify-between gap-3 p-3.5 hover:bg-black/[0.01]">
                    <div className="min-w-[180px] flex-1">
                      <input
                        type="text"
                        value={item.sku}
                        onChange={(e) => updateItem(idx, 'sku', e.target.value)}
                        className="font-bold text-xs text-ink bg-transparent outline-none w-full"
                        placeholder="SKU"
                      />
                      <input
                        type="text"
                        value={item.name}
                        onChange={(e) => updateItem(idx, 'name', e.target.value)}
                        className="text-xs text-greige-ink bg-transparent outline-none w-full"
                        placeholder="Nombre de prenda"
                      />
                    </div>

                    <div className="flex items-center gap-3">
                      {/* Cantidad */}
                      <div className="flex flex-col items-center">
                        <span className="text-[10px] text-greige uppercase">Cant</span>
                        <input
                          type="number"
                          min="1"
                          value={item.quantity}
                          onChange={(e) => updateItem(idx, 'quantity', e.target.value)}
                          className="w-12 text-center rounded-lg border border-line py-1 text-xs text-ink outline-none"
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
                          className="w-20 text-right rounded-lg border border-line py-1 px-2 text-xs text-ink outline-none"
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
                          className="w-16 text-right rounded-lg border border-line py-1 px-2 text-xs font-semibold text-danger outline-none"
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
                          className="w-20 text-right rounded-lg border border-line py-1 px-2 text-xs font-semibold text-ink outline-none"
                          title="Edita el precio final o usa el % de descuento"
                        />
                      </div>

                      {/* Subtotal Ítem */}
                      <div className="flex flex-col items-end min-w-[70px]">
                        <span className="text-[10px] text-greige uppercase">Total</span>
                        <span className="text-xs font-bold text-ink py-1">
                          Q{(item.finalPrice * item.quantity).toFixed(2)}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => removeItem(idx)}
                        className="text-greige hover:text-danger p-1"
                        title="Eliminar"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Cuadro de Totales */}
          {items.length > 0 && (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between rounded-xl bg-black/[0.03] dark:bg-white/[0.04] p-4 border border-line">
              <div className="space-y-1 mb-3 sm:mb-0">
                <p className="text-xs text-greige-ink">
                  Total de prendas cotizadas: <span className="font-semibold text-ink">{items.reduce((s, i) => s + i.quantity, 0)}</span>
                </p>
                {discountTotal > 0 && (
                  <p className="text-xs font-semibold text-success flex items-center gap-1">
                    🎉 Ahorro total para el cliente: Q{discountTotal.toFixed(2)}
                  </p>
                )}
              </div>

              <div className="text-right">
                <span className="text-xs text-greige block">TOTAL A PAGAR</span>
                <span className="text-2xl font-bold tracking-tight text-ink">
                  Q{grandTotal.toFixed(2)}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between border-t border-line px-6 py-4 bg-paper">
          <p className="text-xs text-greige">
            Se generará una tarjeta PNG estilizada para enviar al chat.
          </p>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-line px-4 py-2 text-xs font-semibold text-ink hover:bg-black/5 dark:hover:bg-white/5"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={items.length === 0 || isGenerating}
              className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2 text-xs font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-50"
            >
              {isGenerating ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Generando imagen…
                </>
              ) : (
                <>
                  <ImageIcon size={14} />
                  Enviar Cotización al Chat
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
