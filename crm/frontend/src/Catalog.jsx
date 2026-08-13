import { useEffect, useMemo, useState, useRef } from 'react';
import { Upload, PackageX, Search } from 'lucide-react';
import { fetchProducts, importProducts } from './api.js';
import Badge from './components/Badge.jsx';
import Pagination from './components/Pagination.jsx';
import { Button } from './components/ui.jsx';

const PAGE_SIZE_OPTIONS = [5, 10, 15, 20, 50];

export default function Catalog() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const fileInput = useRef(null);

  function load() {
    setLoading(true);
    fetchProducts()
      .then(setProducts)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category))].sort(),
    [products]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (category !== 'all' && p.category !== category) return false;
      if (!q) return true;
      return (
        p.sku.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        (p.color ?? '').toLowerCase().includes(q)
      );
    });
  }, [products, search, category]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function updateSearch(value) {
    setSearch(value);
    setPage(1);
  }

  function updateCategory(value) {
    setCategory(value);
    setPage(1);
  }

  function updatePageSize(value) {
    setPageSize(value);
    setPage(1);
  }

  async function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const res = await importProducts(file);
      setResult(res);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="sticky top-0 z-10 bg-paper px-8 pb-4 pt-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Catálogo</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {products.length} productos · lo que el bot ofrece viene de aquí.
            </p>
          </div>
          <div>
            <input ref={fileInput} type="file" accept=".csv" className="hidden" onChange={handleFileChange} />
            <Button onClick={() => fileInput.current.click()} disabled={importing}>
              <Upload size={16} /> {importing ? 'Importando…' : 'Importar CSV'}
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => updateSearch(e.target.value)}
              placeholder="Buscar por SKU, nombre o color…"
              className="w-full rounded-lg border border-border py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-primary"
            />
          </div>
          <select
            value={category}
            onChange={(e) => updateCategory(e.target.value)}
            className="rounded-lg border border-border px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
          >
            <option value="all">Todas las categorías</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          {(search || category !== 'all') && (
            <span className="text-xs text-muted-foreground">{filtered.length} resultados</span>
          )}
        </div>
      </div>

      <div className="px-8 pb-8">
        <div className="mb-4 rounded-xl border border-border bg-muted px-4 py-3 text-xs text-muted-foreground">
          Columnas esperadas: <code className="rounded bg-paper px-1.5 py-0.5">sku, name, category, line, size, color, price, discount_pct, stock_quantity, active</code>.
          Un <code className="rounded bg-paper px-1.5 py-0.5">sku</code> que ya existe se actualiza; uno nuevo se crea.
        </div>

        {result && (
          <p className="mb-4 text-sm text-success">
            {result.imported} de {result.totalRows} filas importadas.
            {result.errors.length > 0 && ` (${result.errors.length} con problemas: ${result.errors.slice(0, 3).join('; ')})`}
          </p>
        )}
        {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      <div className="overflow-hidden rounded-2xl border border-border bg-paper">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-muted text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">SKU</th>
              <th className="px-4 py-3 font-medium">Nombre</th>
              <th className="px-4 py-3 font-medium">Talla</th>
              <th className="px-4 py-3 font-medium">Color</th>
              <th className="px-4 py-3 font-medium">Precio</th>
              <th className="px-4 py-3 font-medium">Stock</th>
              <th className="px-4 py-3 font-medium">Estado</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">Cargando…</td></tr>
            )}
            {!loading && pageItems.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">Sin resultados.</td></tr>
            )}
            {pageItems.map((p) => (
              <tr key={p.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                <td className="px-4 py-3 font-mono text-xs">{p.sku}</td>
                <td className="px-4 py-3">{p.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{p.size}</td>
                <td className="px-4 py-3 text-muted-foreground">{p.color}</td>
                <td className="px-4 py-3 font-medium">Q{p.price}</td>
                <td className="px-4 py-3">
                  {p.stock_quantity === 0 ? (
                    <span className="flex items-center gap-1.5 text-danger">
                      <PackageX size={14} /> agotado
                    </span>
                  ) : p.stock_quantity < 5 ? (
                    <span className="text-warning">{p.stock_quantity} — bajo</span>
                  ) : (
                    p.stock_quantity
                  )}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={p.active ? 'success' : 'neutral'}>{p.active ? 'Activo' : 'Inactivo'}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination
          page={safePage}
          pageCount={pageCount}
          totalItems={filtered.length}
          pageSize={pageSize}
          onChange={setPage}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageSizeChange={updatePageSize}
        />
      </div>
      </div>
    </div>
  );
}
