import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, MessageSquareText, Users2 } from 'lucide-react';
import { fetchQuickReplies, createQuickReply, updateQuickReply, deleteQuickReply } from './api.js';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import Badge from './components/Badge.jsx';
import { showSuccess, showError } from './components/Toast.jsx';

export default function QuickReplies() {
  const [tab, setTab] = useState('personal');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [shortcut, setShortcut] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchQuickReplies());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = items.filter((i) => i.scope === tab);

  function openCreate() {
    setEditing(null);
    setShortcut('');
    setContent('');
    setFormOpen(true);
  }

  function openEdit(item) {
    setEditing(item);
    setShortcut(item.shortcut);
    setContent(item.content);
    setFormOpen(true);
  }

  async function handleSave() {
    setBusy(true);
    try {
      if (editing) {
        await updateQuickReply(editing.id, { shortcut, content });
        showSuccess('Plantilla actualizada');
      } else {
        await createQuickReply({ shortcut, content, scope: tab });
        showSuccess('Plantilla creada');
      }
      setFormOpen(false);
      load();
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deleteQuickReply(deleteTarget.id);
      showSuccess('Plantilla eliminada');
      setDeleteTarget(null);
      load();
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="sticky top-0 z-10 bg-paper px-8 pb-4 pt-8">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Respuestas rápidas</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Escribe <code className="rounded bg-muted px-1.5 py-0.5 text-xs">/</code> en cualquier chat para insertarlas.
            </p>
          </div>
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus size={15} /> Nueva plantilla
          </button>
        </div>
        <div className="inline-flex rounded-xl border border-border bg-muted p-1">
          <button
            onClick={() => setTab('personal')}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all ${
              tab === 'personal' ? 'bg-paper text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <MessageSquareText size={14} /> Mis plantillas
          </button>
          <button
            onClick={() => setTab('global')}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all ${
              tab === 'global' ? 'bg-paper text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Users2 size={14} /> Equipo
          </button>
        </div>
      </div>

      <div className="px-8 pb-8">
        {error && <p className="mb-4 text-sm text-danger">{error}</p>}
        {loading && <p className="text-sm text-muted-foreground">Cargando…</p>}
        {!loading && visible.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {tab === 'personal' ? 'Todavía no tienes plantillas personales.' : 'Todavía no hay plantillas de equipo.'}
          </div>
        )}
        <div className="flex flex-col gap-2">
          {visible.map((item) => (
            <div key={item.id} className="flex items-start justify-between gap-4 rounded-xl border border-border bg-paper p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="info">/{item.shortcut}</Badge>
                  {item.scope === 'global' && <span className="text-xs text-muted-foreground">por {item.ownerName}</span>}
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground">{item.content}</p>
              </div>
              {item.canManage && (
                <div className="flex shrink-0 items-center gap-1">
                  <button onClick={() => openEdit(item)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => setDeleteTarget(item)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-danger/10 hover:text-danger">
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={formOpen}
        title={editing ? 'Editar plantilla' : `Nueva plantilla ${tab === 'global' ? 'de equipo' : 'personal'}`}
        message="El atajo es lo que escribes después de la diagonal para insertarla en el chat."
        confirmLabel={editing ? 'Guardar' : 'Crear'}
        busy={busy}
        confirmDisabled={!shortcut.trim() || !content.trim()}
        onConfirm={handleSave}
        onCancel={() => setFormOpen(false)}
      >
        <div className="flex flex-col gap-2.5">
          <label className="flex flex-col gap-1 text-xs font-medium text-greige-ink">
            Atajo (sin espacios)
            <input
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value.replace(/\s/g, ''))}
              placeholder="ej. saludo"
              className="rounded-lg border border-line bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:bg-paper"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-greige-ink">
            Texto
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
              placeholder="Escribe el mensaje completo que se va a insertar…"
              className="rounded-lg border border-line bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:bg-paper"
            />
          </label>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Eliminar plantilla"
        message={`¿Eliminar "/${deleteTarget?.shortcut}"? Esta acción no se puede deshacer.`}
        confirmLabel="Eliminar"
        danger
        busy={busy}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
