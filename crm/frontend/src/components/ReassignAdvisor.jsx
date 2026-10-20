import { useState } from 'react';
import { updateSale } from '../api.js';
import ConfirmDialog from './ConfirmDialog.jsx';
import { showError, showSuccess } from './Toast.jsx';

// "Esta venta no es de X": un administrador/supervisor corrige a mano la asesora de una venta mal atribuida. El cambio
// queda fijo (el motor y las auditorías ya no la mueven). options = nombres de asesoras; onDone recarga la pantalla.
export default function ReassignAdvisor({ saleId, current, options, overridden = false, onDone }) {
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState(null); // asesora elegida, pendiente de confirmar en la ventana
  const [busy, setBusy] = useState(false);

  async function confirmChange() {
    setBusy(true);
    try {
      await updateSale(saleId, { advisorName: target });
      showSuccess(`Venta pasada a ${target}`);
      setTarget(null);
      onDone?.();
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {editing ? (
        <select
          autoFocus
          defaultValue=""
          onChange={(e) => { setTarget(e.target.value || null); setEditing(false); }}
          onBlur={() => setEditing(false)}
          className="mt-1 rounded-md border border-line bg-paper px-1.5 py-0.5 text-[11px] text-ink"
        >
          <option value="" disabled>Pasar a…</option>
          {options.filter((n) => n !== current).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      ) : (
        <p className="mt-0.5 text-[11px] text-greige-ink">
          Asesora: <span className="font-semibold text-ink">{current || '—'}</span>{overridden && <span title="Corregida a mano" className="ml-1 text-warning">· ajustada a mano</span>}
          {' · '}
          <button type="button" onClick={() => setEditing(true)} className="font-semibold text-accent hover:underline">Cambiar asesora</button>
        </p>
      )}
      <ConfirmDialog
        open={!!target}
        title="Cambiar la asesora de la venta"
        message={`¿Pasar esta venta de ${current || 'sin asesora'} a ${target}? Quedará fija: las auditorías ya no la moverán.`}
        confirmLabel="Sí, cambiar"
        busy={busy}
        onConfirm={confirmChange}
        onCancel={() => setTarget(null)}
      />
    </>
  );
}
