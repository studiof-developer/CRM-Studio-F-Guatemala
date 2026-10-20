// Prendas vendidas: junta las filas (venta × prenda de su cotización) en un resumen por prenda. La prenda de una venta sale de su
// cotización (la enlazada, o la última del cliente en los 30 días anteriores); una venta sin cotización no dice qué se llevó.
const sizeKey = (s) => String(s ?? '').trim().toUpperCase() || 'Sin talla';

// rows: [{ sale_id, amount, quote_id, grand_total, sku, name, size, color, quantity, final_price }] (una por prenda; sin prenda si no hay cotización)
export function aggregateItems(rows) {
  const sales = new Map();
  const groups = new Map();
  for (const r of rows) {
    const s = sales.get(r.sale_id) ?? { id: r.sale_id, amount: Number(r.amount), hasQuote: r.quote_id != null, quoteTotal: r.grand_total != null ? Number(r.grand_total) : null, items: 0 };
    sales.set(r.sale_id, s);
    if (r.sku == null) continue;
    s.items += Number(r.quantity);
    const g = groups.get(r.sku) ?? { sku: r.sku, name: r.name, units: 0, total: 0, sales: new Set(), sizes: {} };
    const qty = Number(r.quantity);
    g.units += qty; g.total += Number(r.final_price) * qty; g.sales.add(r.sale_id);
    g.sizes[sizeKey(r.size)] = (g.sizes[sizeKey(r.size)] ?? 0) + qty;
    groups.set(r.sku, g);
  }
  const list = [...sales.values()];
  return {
    groups: [...groups.values()].map((g) => ({ ...g, sales: g.sales.size })).sort((a, b) => b.units - a.units || b.total - a.total),
    totalUnits: list.reduce((n, s) => n + s.items, 0),
    salesTotal: list.length,
    salesWithItems: list.filter((s) => s.items > 0).length,
    salesWithoutItems: list.filter((s) => s.items === 0).length,
    // la cotización no coincide con lo cobrado (otro precio, otra prenda): la prenda es una pista, no una certeza
    salesMismatch: list.filter((s) => s.items > 0 && s.quoteTotal != null && Math.abs(s.quoteTotal - s.amount) > 1).length,
  };
}
