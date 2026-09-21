import { useState, useEffect, useCallback } from 'react';
import { Building2, Plus, Edit2, Trash2, Store, Lock, Check, X, RefreshCw, SlidersHorizontal } from 'lucide-react';
import toast from 'react-hot-toast';
import { fetchCompanies, createCompany, updateCompany, deleteCompany, updateCompanyBrands, fetchBrands } from './api.js';
import Badge from './components/Badge.jsx';

function Modal({ open, onClose, title, children, maxWidth = 'max-w-md' }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm overflow-y-auto">
      <div className={`w-full ${maxWidth} rounded-2xl bg-paper p-6 shadow-xl relative text-left my-8`}>
        <button type="button" onClick={onClose} className="absolute right-4 top-4 text-greige-ink hover:text-ink">
          <X size={20} />
        </button>
        <h2 className="mb-4 text-xl font-bold text-ink">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export default function Companies() {
  const [companies, setCompanies] = useState([]);
  const [allBrands, setAllBrands] = useState([]);
  const [loading, setLoading] = useState(true);

  // Modal Crear / Editar Empresa
  const [companyModal, setCompanyModal] = useState({ open: false, mode: 'create', data: null });
  const [formName, setFormName] = useState('');
  const [formActive, setFormActive] = useState(true);
  const [savingCompany, setSavingCompany] = useState(false);

  // Modal Gestión de Marcas
  const [brandsModal, setBrandsModal] = useState({ open: false, company: null });
  const [selectedBrandIds, setSelectedBrandIds] = useState([]);
  const [savingBrands, setSavingBrands] = useState(false);

  // Confirmar eliminación
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const loadData = useCallback(() => {
    setLoading(true);
    Promise.all([fetchCompanies(), fetchBrands()])
      .then(([comps, brs]) => {
        setCompanies(comps);
        setAllBrands(brs);
      })
      .catch(err => toast.error(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Abrir modal de creación
  const handleOpenCreate = () => {
    setFormName('');
    setFormActive(true);
    setCompanyModal({ open: true, mode: 'create', data: null });
  };

  // Abrir modal de edición
  const handleOpenEdit = (comp) => {
    setFormName(comp.name);
    setFormActive(comp.active);
    setCompanyModal({ open: true, mode: 'edit', data: comp });
  };

  // Guardar empresa
  const handleSaveCompany = async (e) => {
    e.preventDefault();
    if (!formName.trim()) {
      toast.error('El nombre es obligatorio');
      return;
    }
    setSavingCompany(true);
    try {
      if (companyModal.mode === 'create') {
        await createCompany({ name: formName.trim(), active: formActive });
        toast.success('Empresa creada');
      } else {
        await updateCompany(companyModal.data.id, { name: formName.trim(), active: formActive });
        toast.success('Empresa actualizada');
      }
      setCompanyModal({ open: false, mode: 'create', data: null });
      loadData();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingCompany(false);
    }
  };

  // Eliminar empresa
  const handleDeleteCompany = async (id) => {
    setDeleting(true);
    try {
      await deleteCompany(id);
      toast.success('Empresa eliminada');
      setConfirmDeleteId(null);
      loadData();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  };

  // Abrir modal de asignación de marcas
  const handleOpenBrands = (company) => {
    const currentBrandIds = company.brands?.map(b => b.id) || [];
    setSelectedBrandIds(currentBrandIds);
    setBrandsModal({ open: true, company });
  };

  // Toggle de marca en modal
  const handleToggleBrand = (brandId, isOwnedByOther) => {
    if (isOwnedByOther) return; // Bloqueada
    setSelectedBrandIds(prev => 
      prev.includes(brandId) ? prev.filter(id => id !== brandId) : [...prev, brandId]
    );
  };

  // Guardar asignación de marcas
  const handleSaveBrands = async () => {
    if (!brandsModal.company) return;
    setSavingBrands(true);
    try {
      await updateCompanyBrands(brandsModal.company.id, selectedBrandIds);
      toast.success('Marcas actualizadas para ' + brandsModal.company.name);
      setBrandsModal({ open: false, company: null });
      loadData();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingBrands(false);
    }
  };

  if (loading) return <div className="p-8 text-center text-greige">Cargando empresas...</div>;

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8">
      {/* Encabezado */}
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Empresas</h1>
          <p className="mt-1 text-sm text-greige-ink">
            Estructura corporativa superior. Cada empresa gestiona sus marcas de forma exclusiva.
          </p>
        </div>
        <button
          onClick={handleOpenCreate}
          className="flex items-center gap-2 rounded-xl bg-ink px-4 py-2 text-sm font-medium text-white transition-transform hover:scale-105 active:scale-95"
        >
          <Plus size={16} /> Nueva Empresa
        </button>
      </div>

      {/* Tabla de empresas */}
      <div className="overflow-x-auto rounded-2xl border border-line bg-white shadow-sm">
        <table className="w-full text-left text-sm text-ink whitespace-nowrap">
          <thead className="border-b border-line-soft bg-black/5 text-greige-ink">
            <tr>
              <th className="p-4 font-medium">Empresa</th>
              <th className="p-4 font-medium">Marcas Asociadas</th>
              <th className="p-4 font-medium">Estructura</th>
              <th className="p-4 font-medium">Estado</th>
              <th className="p-4 font-medium text-right">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {companies.length === 0 ? (
              <tr>
                <td colSpan="5" className="p-8 text-center text-greige-ink">
                  No hay empresas registradas. Crea una para empezar.
                </td>
              </tr>
            ) : companies.map(comp => (
              <tr key={comp.id} className="hover:bg-black/[0.02] transition-colors">
                <td className="p-4 font-medium flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <Building2 size={20} />
                  </div>
                  <div>
                    <span className="font-bold text-ink text-base">{comp.name}</span>
                    <p className="text-xs text-greige">ID #{comp.id}</p>
                  </div>
                </td>
                <td className="p-4 max-w-xs truncate">
                  <div className="flex flex-wrap gap-1.5 items-center">
                    {comp.brands && comp.brands.length > 0 ? (
                      comp.brands.map(b => (
                        <span
                          key={b.id}
                          className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent"
                        >
                          <Store size={12} /> {b.name}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs italic text-greige">Sin marcas asignadas</span>
                    )}
                  </div>
                </td>
                <td className="p-4 text-xs text-greige-ink">
                  <div className="flex items-center gap-2">
                    <span className="rounded-lg bg-black/5 px-2 py-1 font-medium">
                      {comp.branch_count ?? 0} sucursales
                    </span>
                    <span className="rounded-lg bg-black/5 px-2 py-1 font-medium">
                      {comp.line_count ?? 0} líneas
                    </span>
                  </div>
                </td>
                <td className="p-4">
                  <Badge variant={comp.active ? 'success' : 'neutral'}>
                    {comp.active ? 'Activa' : 'Inactiva'}
                  </Badge>
                </td>
                <td className="p-4 text-right">
                  <div className="flex justify-end items-center gap-2">
                    <button
                      onClick={() => handleOpenBrands(comp)}
                      className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink hover:border-accent hover:text-accent transition-colors"
                      title="Gestionar Marcas"
                    >
                      <SlidersHorizontal size={14} />
                      Marcas ({comp.brand_count ?? 0})
                    </button>
                    <button
                      onClick={() => handleOpenEdit(comp)}
                      className="rounded-lg p-2 text-greige-ink hover:bg-black/5 hover:text-ink transition-colors"
                      title="Editar Empresa"
                    >
                      <Edit2 size={16} />
                    </button>
                    {confirmDeleteId === comp.id ? (
                      <button
                        onClick={() => handleDeleteCompany(comp.id)}
                        disabled={deleting}
                        className="rounded-lg bg-error/10 px-3 py-1.5 text-xs font-medium text-error hover:bg-error hover:text-white transition-colors"
                      >
                        {deleting ? <RefreshCw size={14} className="animate-spin" /> : 'Confirmar'}
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(comp.id)}
                        className="rounded-lg p-2 text-greige-ink hover:bg-error/10 hover:text-error transition-colors"
                        title="Eliminar Empresa"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal Crear / Editar Empresa */}
      <Modal
        open={companyModal.open}
        onClose={() => setCompanyModal({ open: false, mode: 'create', data: null })}
        title={companyModal.mode === 'create' ? 'Nueva Empresa' : 'Editar Empresa'}
      >
        <form onSubmit={handleSaveCompany} className="flex flex-col gap-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Nombre de la Empresa</label>
            <input
              value={formName}
              onChange={e => setFormName(e.target.value)}
              required
              autoFocus
              placeholder="Ej. Bagneres, Vyntra Orbit..."
              className="w-full rounded-xl border border-line px-3.5 py-2.5 text-sm text-ink outline-none transition-colors focus:border-accent"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="companyActiveCheck"
              checked={formActive}
              onChange={e => setFormActive(e.target.checked)}
              className="h-4 w-4 rounded border-line text-accent focus:ring-accent"
            />
            <label htmlFor="companyActiveCheck" className="text-sm font-medium text-ink cursor-pointer">
              Empresa activa
            </label>
          </div>

          <div className="mt-4 flex justify-end gap-3 border-t border-line pt-4">
            <button
              type="button"
              onClick={() => setCompanyModal({ open: false, mode: 'create', data: null })}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-greige-ink hover:bg-black/5 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={savingCompany}
              className="flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-white transition-transform hover:scale-105 active:scale-95 disabled:opacity-50"
            >
              {savingCompany && <RefreshCw size={14} className="animate-spin" />}
              {companyModal.mode === 'create' ? 'Guardar' : 'Actualizar'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Modal Asignación de Marcas (Sí/No exclusivo) */}
      <Modal
        open={brandsModal.open}
        onClose={() => setBrandsModal({ open: false, company: null })}
        title={`Gestionar Marcas - ${brandsModal.company?.name ?? ''}`}
        maxWidth="max-w-xl"
      >
        <div className="flex flex-col gap-4">
          <p className="text-xs text-greige-ink">
            Activa las marcas que pertenecerán a esta empresa. Una marca solo puede pertenecer a una empresa a la vez; si ya pertenece a otra, aparecerá bloqueada.
          </p>

          <div className="max-h-96 overflow-y-auto divide-y divide-line-soft rounded-xl border border-line">
            {allBrands.length === 0 ? (
              <div className="p-6 text-center text-sm text-greige">
                No hay marcas creadas en el sistema. Puedes crearlas en la pestaña "Marcas".
              </div>
            ) : allBrands.map(brand => {
              const isSelected = selectedBrandIds.includes(brand.id);
              const isOwnedByOther = brand.company_id && brand.company_id !== brandsModal.company?.id;
              const otherCompanyName = brand.company_name || 'Otra empresa';

              return (
                <div
                  key={brand.id}
                  onClick={() => !isOwnedByOther && handleToggleBrand(brand.id, isOwnedByOther)}
                  className={`flex items-center justify-between p-3.5 transition-colors ${
                    isOwnedByOther
                      ? 'bg-black/[0.02] opacity-60 cursor-not-allowed'
                      : 'cursor-pointer hover:bg-black/[0.03]'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${
                      isSelected ? 'bg-accent text-white' : 'bg-black/5 text-greige'
                    }`}>
                      <Store size={18} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-ink">{brand.name}</span>
                        {isOwnedByOther && (
                          <span className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:border-amber-700/50 dark:text-amber-300">
                            <Lock size={10} /> Propiedad de {otherCompanyName}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-greige">
                        {brand.branches?.length ?? 0} sucursales configuradas
                      </span>
                    </div>
                  </div>

                  <div>
                    {isOwnedByOther ? (
                      <div className="flex items-center gap-1 text-xs text-greige px-2 py-1 rounded bg-black/5">
                        <Lock size={12} /> Bloqueada
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleBrand(brand.id, false);
                        }}
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                          isSelected ? 'bg-accent' : 'bg-gray-200 dark:bg-gray-700'
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                            isSelected ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-line pt-4">
            <span className="text-xs text-greige">
              {selectedBrandIds.length} {selectedBrandIds.length === 1 ? 'marca seleccionada' : 'marcas seleccionadas'}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setBrandsModal({ open: false, company: null })}
                className="rounded-xl px-4 py-2.5 text-sm font-medium text-greige-ink hover:bg-black/5 transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleSaveBrands}
                disabled={savingBrands}
                className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-transform hover:bg-accent-hover hover:scale-105 active:scale-95 disabled:opacity-50"
              >
                {savingBrands ? <RefreshCw size={14} className="animate-spin" /> : <Check size={16} />}
                Guardar Marcas
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
