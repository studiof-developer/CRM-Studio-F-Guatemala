import { useEffect, useState, useCallback } from 'react';
import { Smartphone, Plus, Trash2, ShieldAlert, Edit2, X, RefreshCw, Activity } from 'lucide-react';
import {
  fetchBrands, fetchWhatsappNumbers, testWhatsappNumber, createWhatsappNumber, updateWhatsappNumber, deleteWhatsappNumber
} from './api.js';
import Badge from './components/Badge.jsx';
import { showSuccess, showError } from './components/Toast.jsx';

const EMPTY_FORM = { label: '', branchId: '', wabaId: '', phoneNumberId: '', accessToken: '', isActive: true };

function formatDate(iso) {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' });
}

function Modal({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm overflow-y-auto">
      <div className="w-full max-w-lg rounded-2xl bg-paper border border-line p-6 shadow-xl relative text-left my-auto">
        <button onClick={onClose} className="absolute right-4 top-4 text-greige-ink hover:text-ink">
          <X size={20} />
        </button>
        <h2 className="mb-4 text-xl font-bold text-ink">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export default function WhatsappNumbers() {
  const [numbers, setNumbers] = useState([]);
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  
  const [modal, setModal] = useState({ open: false, mode: 'create', data: null });
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fetchWhatsappNumbers(), fetchBrands()])
      .then(([nums, brs]) => {
        setNumbers(nums);
        setBrands(brs);
      })
      .catch((err) => showError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setTestResult(null);
    setError(null);
    setModal({ open: true, mode: 'create', data: null });
  }

  function openEdit(n) {
    setForm({ label: n.label, branchId: n.branchId || '', wabaId: n.wabaId, phoneNumberId: n.phoneNumberId, accessToken: '', isActive: n.isActive });
    setTestResult(null);
    setError(null);
    setModal({ open: true, mode: 'edit', data: n });
  }

  async function handleTest() {
    if (!form.phoneNumberId.trim() || !form.accessToken.trim()) {
      setError('Completa el ID de número y el token para poder probar la conexión.');
      return;
    }
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await testWhatsappNumber({ phoneNumberId: form.phoneNumberId.trim(), accessToken: form.accessToken.trim() });
      setTestResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (modal.mode === 'create') {
        await createWhatsappNumber(form);
      } else {
        const patch = { label: form.label, branchId: form.branchId, wabaId: form.wabaId, phoneNumberId: form.phoneNumberId, isActive: form.isActive };
        if (form.accessToken.trim()) patch.accessToken = form.accessToken.trim();
        await updateWhatsappNumber(modal.data.id, patch);
      }
      load();
      setModal({ open: false, mode: 'create', data: null });
      showSuccess(modal.mode === 'create' ? 'Número conectado' : 'Cambios guardados');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    setDeleting(true);
    try {
      await deleteWhatsappNumber(id);
      load();
      showSuccess('Número eliminado');
    } catch (err) {
      showError(err.message);
    } finally {
      setDeleting(false);
      setConfirmDeleteId(null);
    }
  }

  if (loading) return <div className="p-8 text-center text-greige">Cargando...</div>;

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">Líneas de WhatsApp</h1>
          <p className="mt-1 text-sm text-greige">Administra los números conectados al CRM.</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-transform hover:bg-accent-hover hover:scale-105 active:scale-95"
        >
          <Plus size={16} />
          Conectar número
        </button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-paper shadow-sm">
        <table className="w-full text-left text-sm text-ink whitespace-nowrap">
          <thead className="border-b border-line-soft bg-black/[0.03] dark:bg-white/[0.04] text-greige-ink">
            <tr>
              <th className="p-4 font-medium">Línea</th>
              <th className="p-4 font-medium">Empresa / Marca / Sucursal</th>
              <th className="p-4 font-medium">Phone Number ID</th>
              <th className="p-4 font-medium">Última Prueba</th>
              <th className="p-4 font-medium">Estado</th>
              <th className="p-4 font-medium text-right">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {numbers.length === 0 ? (
              <tr>
                <td colSpan="6" className="p-8 text-center text-greige-ink">Sin números conectados todavía.</td>
              </tr>
            ) : numbers.map(n => (
              <tr key={n.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors">
                <td className="p-4 font-medium flex items-center gap-2">
                  <Smartphone size={16} className="text-greige" /> {n.label}
                </td>
                <td className="p-4">
                  {n.brandName ? (
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {n.companyName && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-black/5 dark:bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-greige-ink">
                            {n.companyName}
                          </span>
                        )}
                        <span className="font-semibold text-xs text-ink">{n.brandName}</span>
                      </div>
                      <span className="text-xs text-greige-ink">{n.branchName}</span>
                    </div>
                  ) : (
                    <span className="text-xs text-error italic">Sin asignar</span>
                  )}
                </td>
                <td className="p-4 font-mono text-xs text-greige">{n.phoneNumberId}</td>
                <td className="p-4 text-xs text-greige">{formatDate(n.lastTestedAt)}</td>
                <td className="p-4">
                  <Badge variant={n.isActive ? 'success' : 'neutral'}>
                    {n.isActive ? 'Activa' : 'Inactiva'}
                  </Badge>
                </td>
                <td className="p-4 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => openEdit(n)}
                      className="rounded-lg p-2 text-greige hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink transition-colors"
                      title="Editar"
                    >
                      <Edit2 size={16} />
                    </button>
                    {confirmDeleteId === n.id ? (
                      <button onClick={() => handleDelete(n.id)} disabled={deleting} className="rounded-lg bg-error/10 p-2 text-error hover:bg-error hover:text-white transition-colors">
                        {deleting ? <RefreshCw size={16} className="animate-spin" /> : 'Confirmar'}
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(n.id)}
                        className="rounded-lg p-2 text-greige hover:bg-red-500/10 hover:text-red-500 transition-colors"
                        title="Eliminar"
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

      <Modal open={modal.open} onClose={() => setModal({ open: false, mode: 'create', data: null })} title={modal.mode === 'create' ? 'Conectar nueva línea' : 'Editar línea'}>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error && <div className="rounded-lg bg-error/10 p-3 text-sm text-error">{error}</div>}
          
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Sucursal y Marca</label>
            <select
              value={form.branchId}
              onChange={(e) => setForm({ ...form, branchId: e.target.value })}
              required
              className="w-full rounded-lg border border-line bg-paper text-ink px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
            >
              <option value="" disabled>Selecciona una sucursal...</option>
              {brands.map(brand => (
                <optgroup key={brand.id} label={`${brand.company_name ? `[${brand.company_name}] ` : ''}${brand.name}`}>
                  {(brand.branches || []).map(branch => (
                    <option key={branch.id} value={branch.id}>{branch.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Nombre de la línea</label>
            <input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              required
              placeholder="Ventas, Soporte, Studio F..."
              className="w-full rounded-lg border border-line bg-paper text-ink px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">WABA ID</label>
            <input
              value={form.wabaId}
              onChange={(e) => setForm({ ...form, wabaId: e.target.value })}
              required
              placeholder="ID de la cuenta de WhatsApp Business"
              className="w-full rounded-lg border border-line bg-paper text-ink px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">ID del número de teléfono</label>
            <input
              value={form.phoneNumberId}
              onChange={(e) => { setForm({ ...form, phoneNumberId: e.target.value }); setTestResult(null); }}
              required
              placeholder="Phone Number ID de Meta"
              className="w-full rounded-lg border border-line bg-paper text-ink px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">
              {modal.mode === 'create' ? 'Token de acceso' : 'Nuevo token (opcional)'}
            </label>
            <input
              type="password"
              value={form.accessToken}
              onChange={(e) => { setForm({ ...form, accessToken: e.target.value }); setTestResult(null); }}
              required={modal.mode === 'create'}
              placeholder={modal.mode === 'create' ? 'Token permanente de Meta' : 'Dejar vacío para no cambiarlo'}
              className="w-full rounded-lg border border-line bg-paper text-ink px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
            />
          </div>

          <div className="flex items-center gap-2">
            <input 
              type="checkbox" 
              id="isActiveCheck"
              checked={form.isActive} 
              onChange={e => setForm({...form, isActive: e.target.checked})} 
              className="h-4 w-4 rounded border-line text-accent focus:ring-accent"
            />
            <label htmlFor="isActiveCheck" className="text-sm font-medium text-ink">Línea activa</label>
          </div>

          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="flex items-center justify-center gap-2 rounded-xl bg-black/5 dark:bg-white/10 px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-black/10 dark:hover:bg-white/15 disabled:opacity-50"
          >
            {testing ? <RefreshCw size={16} className="animate-spin" /> : <ShieldAlert size={16} />}
            {testing ? 'Probando...' : 'Probar conexión'}
          </button>

          {testResult && (
            <div className={`rounded-xl border p-4 ${testResult.ok ? 'border-success bg-success-soft text-success-ink' : 'border-error bg-error-soft text-error-ink'}`}>
              <p className="flex items-center gap-2 text-sm font-bold">
                <Activity size={16} /> {testResult.ok ? 'Conexión exitosa' : 'Error de conexión'}
              </p>
              {!testResult.ok && <p className="mt-1 text-xs opacity-90">{testResult.error}</p>}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-3 border-t border-line pt-4">
            <button type="button" onClick={() => setModal({ open: false, mode: 'create', data: null })} className="rounded-xl px-4 py-2.5 text-sm font-medium text-greige-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-transform hover:bg-accent-hover hover:scale-105 active:scale-95 disabled:opacity-50">
              {saving ? <RefreshCw size={16} className="animate-spin" /> : null}
              {modal.mode === 'create' ? 'Guardar' : 'Actualizar'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
