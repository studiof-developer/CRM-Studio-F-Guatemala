import { useState } from 'react';
import { updateSale } from '../api.js';

// "Esta venta no es de X": un administrador/supervisor corrige a mano la asesora de una venta mal atribuida. El cambio
// queda fijo (el motor y las auditorías ya no la mueven). options = nombres de asesoras; onDone recarga la pantalla.
export default function ReassignAdvisor({ saleId, current, options, overridden = false, onDone }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function change(e) {
    const name = e.target.value;
    if (!name || name === current) { setEditing(false); return; }
    if (!window.confirm(`¿Pasar esta venta de ${current || 'sin asesora'} a ${name}?\nQuedará fija: las auditorías ya no la moverán.`)) { setEditing(false); return; }
    setBusy(true);
    try { await updateSale(saleId, { advisorName: name }); onDone?.(); } catch (err) { window.alert(err.message); } finally { setBusy(false); setEditing(false); }
  }

  if (editing) {
    return (
      <select autoFocus defaultValue="" disabled={busy} onChange={change} onBlur={() => setEditing(false)} className="mt-1 rounded-md border border-line bg-paper px-1.5 py-0.5 text-[11px] text-ink">
        <option value="" disabled>Pasar a…</option>
        {options.filter((n) => n !== current).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    );
  }
  return (
    <p className="mt-0.5 text-[11px] text-greige-ink">
      Asesora: <span className="font-semibold text-ink">{current || '—'}</span>{overridden && <span title="Corregida a mano" className="ml-1 text-warning">· ajustada a mano</span>}
      {' · '}
      <button type="button" onClick={() => setEditing(true)} className="font-semibold text-accent hover:underline">Cambiar asesora</button>
    </p>
  );
}
