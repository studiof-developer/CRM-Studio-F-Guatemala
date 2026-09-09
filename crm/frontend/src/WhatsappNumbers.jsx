import { useEffect, useState, useCallback } from 'react';
import { Smartphone, Plus, Trash2, CheckCircle2, ShieldAlert, Settings2, LayoutGrid, ChevronUp, ChevronDown, Radar, Info, X } from 'lucide-react';
import {
  fetchWhatsappNumbers, testWhatsappNumber, createWhatsappNumber, updateWhatsappNumber, deleteWhatsappNumber,
  fetchSettings, updateSetting,
} from './api.js';
import Badge from './components/Badge.jsx';
import { Button } from './components/ui.jsx';
import Select from './components/Select.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import { showSuccess, showError } from './components/Toast.jsx';
import { COLUMN_ORDER, DEFAULT_COLUMN_META, PIPELINE_ICON_MAP, PIPELINE_ICON_NAMES, PIPELINE_COLOR_CLASSES, PIPELINE_COLOR_NAMES } from './lib/pipelineColumns.js';

const EMPTY_FORM = { label: '', wabaId: '', phoneNumberId: '', accessToken: '', isActive: true };

function formatDate(iso) {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleString('es-GT', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function Configuracion() {
  const [tab, setTab] = useState('numbers');

  return (
    <div className="mx-auto max-w-6xl">
      <div className="sticky top-0 z-10 bg-paper px-4 pb-4 pt-8 md:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Configuración</h1>
          <p className="mt-1 text-sm text-greige-ink">Ajustes del CRM y del bot que un administrador puede cambiar sin necesitar un despliegue.</p>
        </div>

        <div className="inline-flex flex-wrap rounded-xl border border-line bg-black/[0.03] dark:bg-white/[0.05] p-1">
          {[
            { key: 'numbers', label: 'Números de WhatsApp', icon: Smartphone },
            { key: 'pipeline', label: 'Pipeline', icon: LayoutGrid },
            { key: 'deteccion', label: 'Detección', icon: Radar },
            { key: 'general', label: 'General', icon: Settings2 },
          ].map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all ${
                tab === key ? 'bg-paper text-ink shadow-sm' : 'text-greige-ink hover:text-ink'
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pb-8 md:px-8">
        {tab === 'numbers' && <NumbersTab />}
        {tab === 'pipeline' && <PipelineTab />}
        {tab === 'deteccion' && <DeteccionTab />}
        {tab === 'general' && <GeneralTab />}
      </div>
    </div>
  );
}

// Plain number-input settings only — pipeline_columns has its own tab/editor since an
// array of {key,label,icon,color} doesn't fit a single <input type="number">.
const GENERAL_SETTING_KEYS = ['ocr_context_hours', 'sla_minutes', 'awaiting_reply_overdue_minutes', 'broadcast_cooldown_hours'];

function GeneralTab() {
  const [settings, setSettings] = useState([]);
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(null);

  const load = useCallback(() => {
    fetchSettings().then((rows) => {
      const numeric = rows.filter((r) => GENERAL_SETTING_KEYS.includes(r.key));
      setSettings(numeric);
      setValues(Object.fromEntries(numeric.map((r) => [r.key, r.value ?? ''])));
    }).catch((err) => showError(err.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSave(key) {
    setSaving(key);
    try {
      await updateSetting(key, Number(values[key]));
      load();
      showSuccess('Ajuste guardado');
    } catch (err) {
      showError(err.message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="max-w-md rounded-2xl border border-line bg-paper p-4 md:p-8">
      {settings.map((s, i) => (
        <div key={s.key} className={i > 0 ? 'mt-6 border-t border-line-soft pt-6' : ''}>
          <label className="mb-1.5 block text-sm font-medium text-ink">{s.label}</label>
          <p className="mb-2 text-xs text-greige-ink">{s.description}</p>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min="1"
              value={values[s.key] ?? ''}
              onChange={(e) => setValues({ ...values, [s.key]: e.target.value })}
              className="w-32 rounded-lg border border-line px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
            />
            <Button type="button" onClick={() => handleSave(s.key)} disabled={saving === s.key}>
              {saving === s.key ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
          {s.updatedAt && <p className="mt-1.5 text-xs text-greige">Última edición: {formatDate(s.updatedAt)}</p>}
        </div>
      ))}
    </section>
  );
}

function PipelineTab() {
  const [rows, setRows] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetchSettings().then((all) => {
      const s = all.find((r) => r.key === 'pipeline_columns');
      // Falls back to today's real board (db/init/042 seeds this same shape) rather
      // than an empty editor if the setting was somehow never saved.
      setRows(s?.value ?? COLUMN_ORDER.map((key) => ({ key, ...DEFAULT_COLUMN_META[key] })));
      setUpdatedAt(s?.updatedAt ?? null);
    }).catch((err) => showError(err.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  function move(index, delta) {
    setRows((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  function updateRow(index, patch) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const result = await updateSetting('pipeline_columns', rows);
      setUpdatedAt(result.updatedAt);
      showSuccess('Columnas del pipeline actualizadas');
    } catch (err) {
      showError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!rows) return null;

  return (
    <section className="max-w-2xl rounded-2xl border border-line bg-paper p-4 md:p-8">
      <p className="mb-4 text-sm text-greige-ink">
        Nombre, ícono, color y orden de las 7 columnas del tablero — las columnas en sí no se pueden agregar ni quitar desde aquí.
      </p>

      <div className="flex flex-col gap-2">
        {rows.map((row, i) => {
          const Icon = PIPELINE_ICON_MAP[row.icon] ?? CheckCircle2;
          const colorClasses = PIPELINE_COLOR_CLASSES[row.color] ?? PIPELINE_COLOR_CLASSES.info;
          return (
            <div key={row.key} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
              <div className="flex shrink-0 flex-col gap-0.5">
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label="Subir"
                  className="rounded p-0.5 text-greige-ink transition-colors hover:bg-black/[0.05] disabled:opacity-30 dark:hover:bg-white/[0.08]"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  disabled={i === rows.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label="Bajar"
                  className="rounded p-0.5 text-greige-ink transition-colors hover:bg-black/[0.05] disabled:opacity-30 dark:hover:bg-white/[0.08]"
                >
                  <ChevronDown size={14} />
                </button>
              </div>

              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${colorClasses.iconBg}`}>
                <Icon size={16} className={colorClasses.iconText} />
              </div>

              <input
                value={row.label}
                onChange={(e) => updateRow(i, { label: e.target.value })}
                maxLength={40}
                className="min-w-[140px] flex-1 rounded-lg border border-line px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
              />

              <Select
                value={row.icon}
                onChange={(icon) => updateRow(i, { icon })}
                options={PIPELINE_ICON_NAMES.map((name) => ({ value: name, label: name, icon: PIPELINE_ICON_MAP[name] }))}
                className="w-36 shrink-0"
              />

              <div className="flex shrink-0 items-center gap-1.5 px-1">
                {PIPELINE_COLOR_NAMES.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => updateRow(i, { color: name })}
                    aria-label={name}
                    className={`h-5 w-5 rounded-full ${PIPELINE_COLOR_CLASSES[name].dot} ${
                      row.color === name ? 'ring-2 ring-accent ring-offset-2 ring-offset-paper' : ''
                    }`}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button type="button" onClick={handleSave} disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </Button>
        {updatedAt && <p className="text-xs text-greige">Última edición: {formatDate(updatedAt)}</p>}
      </div>
    </section>
  );
}

function DeteccionTab() {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex items-start gap-2 rounded-lg border border-line-soft bg-black/[0.02] p-3 text-xs text-greige-ink dark:bg-white/[0.03]">
        <Info size={14} className="mt-0.5 shrink-0 text-accent" />
        <span>
          Estas listas <strong>se suman</strong> a la detección que ya trae el sistema — nunca la reemplazan ni la desactivan.
          Cada frase se busca tal cual (no es una fórmula ni un código), así que no hay forma de "romper" la detección
          existente agregando o quitando una de aquí.
        </span>
      </div>
      <PhraseListEditor
        settingKey="extra_caliente_phrases"
        title='Frases que mueven a un cliente a "Medio de pago" (Caliente)'
        helpText='Si un asesor pregunta el medio de pago de una forma que el sistema no reconoce todavía, agrégala aquí tal cual se escribe — ej. "cómo me harías el pago". No hace falta que sea una frase exacta completa; con que aparezca dentro del mensaje del asesor es suficiente.'
        placeholder="ej. cómo me harías el pago"
      />
      <PhraseListEditor
        settingKey="extra_receipt_keywords"
        title="Palabras que confirman que una foto es un comprobante real (OCR)"
        helpText='Útil cuando aparece un banco o pasarela de pago nueva cuya captura de pantalla no contiene ninguna de las palabras que el sistema ya reconoce (monto, cuenta, referencia, comprobante, depósito, etc.) — ej. el nombre del banco.'
        placeholder="ej. bac credomatic"
      />
    </div>
  );
}

function PhraseListEditor({ settingKey, title, helpText, placeholder }) {
  const [phrases, setPhrases] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetchSettings().then((rows) => {
      const s = rows.find((r) => r.key === settingKey);
      setPhrases(Array.isArray(s?.value) ? s.value : []);
      setUpdatedAt(s?.updatedAt ?? null);
    }).catch((err) => showError(err.message));
  }, [settingKey]);
  useEffect(() => { load(); }, [load]);

  async function persist(nextPhrases) {
    setSaving(true);
    setError(null);
    try {
      const result = await updateSetting(settingKey, nextPhrases);
      setPhrases(result.value);
      setUpdatedAt(result.updatedAt);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function handleAdd(e) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed.length < 3) {
      setError('La frase debe tener al menos 3 caracteres.');
      return;
    }
    if (phrases.some((p) => p.toLowerCase() === trimmed.toLowerCase())) {
      setError('Esa frase ya está en la lista.');
      return;
    }
    setDraft('');
    persist([...phrases, trimmed]);
  }

  function handleRemove(phrase) {
    persist(phrases.filter((p) => p !== phrase));
  }

  if (!phrases) return null;

  return (
    <section className="rounded-2xl border border-line bg-paper p-4 md:p-6">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-xs text-greige-ink">{helpText}</p>

      <form onSubmit={handleAdd} className="mt-4 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
          placeholder={placeholder}
          maxLength={80}
          className="min-w-0 flex-1 rounded-lg border border-line px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
        />
        <Button type="submit" disabled={saving || phrases.length >= 20}>
          <Plus size={14} /> Agregar
        </Button>
      </form>
      {phrases.length >= 20 && <p className="mt-1.5 text-xs text-warn">Máximo 20 frases — elimina una para agregar otra.</p>}
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}

      {phrases.length === 0 ? (
        <p className="mt-4 text-xs text-greige-ink">Ninguna todavía — la detección incorporada sigue funcionando igual.</p>
      ) : (
        <ul className="mt-4 flex flex-wrap gap-2">
          {phrases.map((phrase) => (
            <li key={phrase} className="flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent">
              {phrase}
              <button type="button" onClick={() => handleRemove(phrase)} disabled={saving} aria-label={`Quitar "${phrase}"`} className="hover:opacity-70 disabled:opacity-50">
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {updatedAt && <p className="mt-3 text-xs text-greige">Última edición: {formatDate(updatedAt)}</p>}
    </section>
  );
}

function NumbersTab() {
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
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-greige-ink">
          Números de WhatsApp conectados al CRM. Cambiar un token o número aquí no requiere redeploy.
        </p>
        <Button onClick={selectNew}>
          <Plus size={16} /> Conectar número
        </Button>
      </div>

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
    </>
  );
}
