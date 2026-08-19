import { useState, useEffect } from 'react';
import ConfirmDialog from './ConfirmDialog.jsx';
import { updateCustomerProfile } from '../api.js';
import { showSuccess, showError } from './Toast.jsx';

const FIELDS = [
  { key: 'full_name', label: 'Nombre completo' },
  { key: 'dpi', label: 'DPI' },
  { key: 'email', label: 'Correo' },
  { key: 'department', label: 'Departamento' },
  { key: 'municipio', label: 'Municipio' },
  { key: 'address', label: 'Dirección' },
  { key: 'preferred_line', label: 'Línea preferida' },
  { key: 'preferred_size', label: 'Talla' },
  { key: 'birth_date', label: 'Fecha de nacimiento', type: 'date' },
];

// Bot's intake only collects name + consent now — this fills in everything else
// (DPI, dirección, talla…) as the customer gives it to whoever takes the ticket.
export default function EditCustomerModal({ open, customer, onCancel, onSaved }) {
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !customer) return;
    setForm(Object.fromEntries(FIELDS.map((f) => [
      f.key,
      f.key === 'birth_date' ? (customer.birth_date ? String(customer.birth_date).slice(0, 10) : '') : (customer[f.key] ?? ''),
    ])));
    // Keyed on id, not the whole object — the parent (Conversations) polls every few
    // seconds and passes a brand-new `customer` object each time even when nothing
    // changed, which was resetting the form (wiping what the advisor had just typed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, customer?.id]);

  async function handleSave() {
    setBusy(true);
    try {
      const updated = await updateCustomerProfile(customer.id, form);
      showSuccess('Datos del cliente actualizados');
      onSaved(updated);
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      wide
      title="Editar cliente"
      message="Actualiza lo que el agente ya no pregunta — se guarda directo en el perfil."
      confirmLabel="Guardar"
      busy={busy}
      onConfirm={handleSave}
      onCancel={onCancel}
    >
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-xs font-medium text-greige-ink">
            {f.label}
            <input
              type={f.type ?? 'text'}
              value={form[f.key] ?? ''}
              onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
              className="rounded-lg border border-line bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:bg-paper"
            />
          </label>
        ))}
      </div>
    </ConfirmDialog>
  );
}
