import { useEffect, useState, useCallback } from 'react';
import { Smartphone, Plus, Trash2, CheckCircle2, ShieldAlert } from 'lucide-react';
import {
  fetchWhatsappNumbers, testWhatsappNumber, createWhatsappNumber, updateWhatsappNumber, deleteWhatsappNumber,
} from './api.js';
import Badge from './components/Badge.jsx';
import { Button } from './components/ui.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import { showSuccess, showError } from './components/Toast.jsx';

const EMPTY_FORM = { label: '', wabaId: '', phoneNumberId: '', accessToken: '', isActive: true };

function formatDate(iso) {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function WhatsappNumbers() {
  const [numbers, setNumbers] = useState([]);
  const [selectedId, setSelectedId] = useState('new');
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    fetchWhatsappNumbers().then(setNumbers).catch((err) => setError(err.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  function selectNumber(n) {
    setSelectedId(n.id);
    setForm({ label: n.label, wabaId: n.wabaId, phoneNumberId: n.phoneNumberId, accessToken: '', isActive: n.isActive });
    setTestResult(null);
    setError(null);
  }

  function selectNew() {
    setSelectedId('new');
    setForm(EMPTY_FORM);
    setTestResult(null);
    setError(null);
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
      if (selectedId === 'new') {
        await createWhatsappNumber(form);
      } else {
        const patch = { label: form.label, wabaId: form.wabaId, phoneNumberId: form.phoneNumberId, isActive: form.isActive };
        if (form.accessToken.trim()) patch.accessToken = form.accessToken.trim();
        await updateWhatsappNumber(selectedId, patch);
      }
      load();
      selectNew();
      showSuccess(selectedId === 'new' ? 'Número conectado' : 'Cambios guardados');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteWhatsappNumber(confirmDeleteId);
      load();
      selectNew();
      showSuccess('Número eliminado');
    } catch (err) {
      showError(err.message);
    } finally {
      setDeleting(false);
      setConfirmDeleteId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="sticky top-0 z-10 mb-6 flex flex-wrap items-center justify-between gap-3 bg-paper px-4 pb-4 pt-8 md:px-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Configuración</h1>
          <p className="mt-1 text-sm text-greige-ink">
            Números de WhatsApp conectados al CRM. Cambiar un token o número aquí no requiere redeploy.
          </p>
        </div>
        <Button onClick={selectNew}>
          <Plus size={16} /> Conectar número
        </Button>
      </div>

      <div className="px-4 pb-8 md:px-8">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
        <ul className="flex flex-col gap-2">
          {numbers.length === 0 && (
            <li className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-greige-ink">
              Sin números conectados todavía.
            </li>
          )}
          {numbers.map((n) => (
            <li
              key={n.id}
              onClick={() => selectNumber(n)}
              className={`cursor-pointer rounded-xl border p-4 transition-all ${
                n.id === selectedId
                  ? 'border-accent bg-accent-soft shadow-sm'
                  : 'border-line bg-paper hover:border-line-soft hover:shadow-sm'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="flex min-w-0 items-center gap-2 truncate text-sm font-medium text-ink">
                  <Smartphone size={14} className="shrink-0 text-greige" /> <span className="truncate">{n.label}</span>
                </p>
                <Badge variant={n.isActive ? 'success' : 'neutral'}>{n.isActive ? 'Activa' : 'Inactiva'}</Badge>
              </div>
              <p className="mt-1 text-sm text-greige-ink">{n.displayPhoneNumber ?? n.phoneNumberId}</p>
              <p className="mt-0.5 text-xs text-greige">Token termina en •••{n.tokenLast4} — probado {formatDate(n.lastTestedAt)}</p>
            </li>
          ))}
        </ul>

        <section className="rounded-2xl border border-line bg-paper p-4 md:p-8">
          <form onSubmit={handleSubmit} className="max-w-md">
            <h2 className="text-lg font-semibold text-ink">
              {selectedId === 'new' ? 'Conectar número de WhatsApp' : 'Editar número'}
            </h2>

            <label className="mb-1.5 mt-5 block text-sm font-medium text-ink">Nombre de la línea</label>
            <input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              required
              placeholder="Ventas, Soporte, Studio F…"
              className="w-full rounded-lg border border-line px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
            />

            <label className="mb-1.5 mt-4 block text-sm font-medium text-ink">WABA ID</label>
            <input
              value={form.wabaId}
              onChange={(e) => setForm({ ...form, wabaId: e.target.value })}
              required
              placeholder="ID de la cuenta de WhatsApp Business"
              className="w-full rounded-lg border border-line px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
            />

            <label className="mb-1.5 mt-4 block text-sm font-medium text-ink">ID del número de teléfono</label>
            <input
              value={form.phoneNumberId}
              onChange={(e) => { setForm({ ...form, phoneNumberId: e.target.value }); setTestResult(null); }}
              required
              placeholder="Phone Number ID de Meta"
              className="w-full rounded-lg border border-line px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
            />

            <label className="mb-1.5 mt-4 block text-sm font-medium text-ink">
              {selectedId === 'new' ? 'Token de acceso' : 'Nuevo token (opcional)'}
            </label>
            <input
              type="password"
              value={form.accessToken}
              onChange={(e) => { setForm({ ...form, accessToken: e.target.value }); setTestResult(null); }}
              required={selectedId === 'new'}
              placeholder={selectedId === 'new' ? 'Token permanente de Meta' : 'Dejar vacío para no cambiarlo'}
              className="w-full rounded-lg border border-line px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
            />

            <button
              type="button"
              onClick={handleTest}
              disabled={testing}
              className="mt-3 flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            >
              <ShieldAlert size={13} /> {testing ? 'Probando…' : 'Probar conexión'}
            </button>

            {testResult && (
              <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-ok">
                <CheckCircle2 size={13} /> {testResult.verifiedName ?? 'Verificado'} — {testResult.displayPhoneNumber}
              </p>
            )}

            {selectedId !== 'new' && (
              <label className="mt-4 flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                Línea activa
              </label>
            )}

            {error && <p className="mt-4 text-sm text-danger">{error}</p>}

            <div className="mt-6 flex items-center gap-3">
              <Button type="submit" disabled={saving}>
                {selectedId === 'new' ? 'Conectar' : 'Guardar cambios'}
              </Button>
              {selectedId !== 'new' && (
                <Button type="button" variant="danger" onClick={() => setConfirmDeleteId(selectedId)}>
                  <Trash2 size={14} /> Eliminar
                </Button>
              )}
            </div>
          </form>
        </section>
      </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Eliminar número"
        message="Esta acción no se puede deshacer. Los mensajes ya enviados no se ven afectados, pero esta línea dejará de poder enviar/recibir."
        confirmLabel="Eliminar"
        danger
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}
