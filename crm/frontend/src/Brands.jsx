import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Building2, Plus, Edit2, Trash2, Store, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { fetchBrands, createBrand, updateBrand, deleteBrand, createBranch, updateBranch, deleteBranch, fetchCompanies } from './api.js';

function Modal({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-paper border border-line p-6 shadow-xl relative text-left">
        <button onClick={onClose} className="absolute right-4 top-4 text-greige-ink hover:text-ink">
          ✕
        </button>
        <h2 className="mb-4 text-lg font-bold text-ink">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export default function Brands() {
  const [brands, setBrands] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingBrand, setSavingBrand] = useState(false);
  const [savingBranch, setSavingBranch] = useState(false);
  
  const [brandModal, setBrandModal] = useState({ open: false, mode: 'create', data: null });
  const [branchModal, setBranchModal] = useState({ open: false, mode: 'create', brandId: null, data: null });

  const loadData = useCallback(() => {
    setLoading(true);
    Promise.all([fetchBrands(), fetchCompanies()])
      .then(([brs, comps]) => {
        setBrands(brs);
        setCompanies(comps);
      })
      .catch(err => toast.error(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleBrandSave = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = fd.get('name')?.trim();
    if (!name) {
      toast.error('El nombre de la marca es obligatorio');
      return;
    }
    const companyIdVal = fd.get('companyId');
    const companyId = companyIdVal ? Number(companyIdVal) : null;
    setSavingBrand(true);
    try {
      if (brandModal.mode === 'create') {
        await createBrand({ name, companyId });
        toast.success('Marca creada');
      } else {
        await updateBrand(brandModal.data.id, { name, companyId });
        toast.success('Marca actualizada');
      }
      setBrandModal({ open: false, mode: 'create', data: null });
      loadData();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingBrand(false);
    }
  };

  const handleBrandDelete = async (id) => {
    if (!confirm('¿Seguro que deseas eliminar esta marca?')) return;
    try {
      await deleteBrand(id);
      toast.success('Marca eliminada');
      loadData();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleBranchSave = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = fd.get('name')?.trim();
    if (!name) {
      toast.error('El nombre de la sucursal es obligatorio');
      return;
    }
    setSavingBranch(true);
    try {
      if (branchModal.mode === 'create') {
        await createBranch(branchModal.brandId, { name });
        toast.success('Sucursal creada');
      } else {
        await updateBranch(branchModal.brandId, branchModal.data.id, { name });
        toast.success('Sucursal actualizada');
      }
      setBranchModal({ open: false, mode: 'create', brandId: null, data: null });
      loadData();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingBranch(false);
    }
  };

  const handleBranchDelete = async (brandId, id) => {
    if (!confirm('¿Seguro que deseas eliminar esta sucursal?')) return;
    try {
      await deleteBranch(brandId, id);
      toast.success('Sucursal eliminada');
      loadData();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (loading) return <div className="p-8 text-center text-greige">Cargando...</div>;

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">Marcas y Sucursales</h1>
          <p className="mt-1 text-sm text-greige">Administra la estructura de marcas y sus sucursales por empresa</p>
        </div>
        <button
          onClick={() => setBrandModal({ open: true, mode: 'create', data: null })}
          className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-transform hover:bg-accent-hover hover:scale-105 active:scale-95"
        >
          <Plus size={16} />
          Nueva Marca
        </button>
      </div>

      <div className="grid gap-6">
        {brands.map(brand => (
          <motion.div key={brand.id} className="overflow-hidden rounded-2xl border border-line bg-paper shadow-sm">
            <div className="flex items-center justify-between border-b border-line-soft bg-black/[0.03] dark:bg-white/[0.04] p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-accent/10 p-2 text-accent shadow-sm"><Store size={20} /></div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold text-ink">{brand.name}</h2>
                    {brand.company_name ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
                        <Building2 size={12} /> {brand.company_name}
                      </span>
                    ) : (
                      <span className="rounded-md bg-black/5 dark:bg-white/[0.06] px-2 py-0.5 text-xs text-greige italic">
                        Sin empresa asignada
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setBrandModal({ open: true, mode: 'edit', data: brand })}
                  className="rounded-lg p-2 text-greige hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink transition-colors"
                  title="Editar Marca"
                >
                  <Edit2 size={16} />
                </button>
                <button
                  onClick={() => handleBrandDelete(brand.id)}
                  className="rounded-lg p-2 text-greige hover:bg-red-500/10 hover:text-red-500 transition-colors"
                  title="Eliminar Marca"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            
            <div className="p-4">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-greige">Sucursales ({brand.branches?.length ?? 0})</h3>
                <button
                  onClick={() => setBranchModal({ open: true, mode: 'create', brandId: brand.id, data: null })}
                  className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <Plus size={14} />
                  Añadir Sucursal
                </button>
              </div>
              
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {brand.branches?.map(branch => (
                  <div key={branch.id} className="group flex items-center justify-between rounded-xl border border-line-soft bg-paper-soft/50 dark:bg-white/[0.02] p-3 transition-colors hover:border-line">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg bg-black/5 dark:bg-white/[0.06] p-1.5"><Building2 size={16} className="text-greige" /></div>
                      <span className="text-sm font-medium text-ink">{branch.name}</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => setBranchModal({ open: true, mode: 'edit', brandId: brand.id, data: branch })}
                        className="rounded p-1.5 text-greige hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink transition-colors"
                        title="Editar Sucursal"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => handleBranchDelete(brand.id, branch.id)}
                        className="rounded p-1.5 text-greige hover:bg-red-500/10 hover:text-red-500 transition-colors"
                        title="Eliminar Sucursal"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                {(!brand.branches || brand.branches.length === 0) && (
                  <div className="col-span-full rounded-xl border border-dashed border-line-soft p-6 text-center text-sm text-greige">
                    No hay sucursales registradas para esta marca.
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        ))}
        {brands.length === 0 && (
          <div className="rounded-2xl border border-dashed border-line-soft p-12 text-center text-greige">
            No hay marcas registradas. Crea una para empezar.
          </div>
        )}
      </div>

      {/* Modal Marca */}
      <Modal open={brandModal.open} onClose={() => setBrandModal({ open: false, mode: 'create', data: null })} title={brandModal.mode === 'create' ? 'Nueva Marca' : 'Editar Marca'}>
        <form key={brandModal.mode + (brandModal.data?.id || 'new')} onSubmit={handleBrandSave} className="flex flex-col gap-4 p-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">Nombre de la marca</span>
            <input
              name="name"
              defaultValue={brandModal.data?.name || ''}
              required
              autoFocus
              className="rounded-xl border border-line bg-paper text-ink px-4 py-2 text-sm outline-none transition-colors focus:border-accent"
              placeholder="Ej. Studio F, H&M, Puma..."
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">Empresa matriz</span>
            <select
              name="companyId"
              defaultValue={brandModal.data?.company_id ?? ''}
              className="rounded-xl border border-line bg-paper text-ink px-4 py-2 text-sm outline-none transition-colors focus:border-accent"
            >
              <option value="">Sin empresa asignada</option>
              {companies.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <span className="text-xs text-greige">También puedes asignar marcas desde la pestaña "Empresas".</span>
          </label>

          <div className="flex justify-end gap-3 pt-4 border-t border-line">
            <button type="button" disabled={savingBrand} onClick={() => setBrandModal({ open: false, mode: 'create', data: null })} className="rounded-xl px-4 py-2 text-sm font-medium text-greige-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors">Cancelar</button>
            <button type="submit" disabled={savingBrand} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-hover transition-transform hover:scale-105 active:scale-95 disabled:opacity-50">
              {savingBrand ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Modal Sucursal */}
      <Modal open={branchModal.open} onClose={() => setBranchModal({ open: false, mode: 'create', brandId: null, data: null })} title={branchModal.mode === 'create' ? 'Nueva Sucursal' : 'Editar Sucursal'}>
        <form key={branchModal.mode + (branchModal.data?.id || 'new')} onSubmit={handleBranchSave} className="flex flex-col gap-4 p-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">Nombre de la sucursal</span>
            <input
              name="name"
              defaultValue={branchModal.data?.name || ''}
              required
              autoFocus
              className="rounded-xl border border-line bg-paper text-ink px-4 py-2 text-sm outline-none transition-colors focus:border-accent"
              placeholder="Ej. Virtual, Naranjos, Pance..."
            />
          </label>
          <div className="flex justify-end gap-3 pt-4 border-t border-line">
            <button type="button" disabled={savingBranch} onClick={() => setBranchModal({ open: false, mode: 'create', brandId: null, data: null })} className="rounded-xl px-4 py-2 text-sm font-medium text-greige-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors">Cancelar</button>
            <button type="submit" disabled={savingBranch} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-hover transition-transform hover:scale-105 active:scale-95 disabled:opacity-50">
              {savingBranch ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
