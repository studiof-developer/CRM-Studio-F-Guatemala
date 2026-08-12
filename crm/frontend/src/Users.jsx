import { useEffect, useState, useCallback } from 'react';
import { UserPlus, Trash2 } from 'lucide-react';
import { fetchUsers, createUser, updateUser, deleteUser } from './api.js';
import Badge from './components/Badge.jsx';
import { Button } from './components/ui.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import { showSuccess, showError } from './components/Toast.jsx';

const EMPTY_FORM = { full_name: '', email: '', password: '', role: 'asesor', zone: '' };

export default function Users() {
  const [users, setUsers] = useState([]);
  const [selectedId, setSelectedId] = useState('new');
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    fetchUsers().then(setUsers).catch((err) => setError(err.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  function selectUser(user) {
    setSelectedId(user.id);
    setForm({ full_name: user.full_name, email: user.email, password: '', role: user.role, zone: user.zone ?? '' });
    setError(null);
  }

  function selectNew() {
    setSelectedId('new');
    setForm(EMPTY_FORM);
    setError(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (selectedId === 'new') {
        await createUser(form);
      } else {
        const patch = { full_name: form.full_name, role: form.role, zone: form.zone || null };
        if (form.password) patch.password = form.password;
        await updateUser(selectedId, patch);
      }
      load();
      selectNew();
      showSuccess(selectedId === 'new' ? 'Usuario creado' : 'Cambios guardados');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteUser(confirmDeleteId);
      load();
      selectNew();
      showSuccess('Usuario eliminado');
    } catch (err) {
      showError(err.message);
    } finally {
      setDeleting(false);
      setConfirmDeleteId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Usuarios</h1>
          <p className="mt-1 text-sm text-muted-foreground">Asesores y supervisores con acceso al CRM.</p>
        </div>
        <Button onClick={selectNew}>
          <UserPlus size={16} /> Nuevo usuario
        </Button>
      </div>

      <div className="grid grid-cols-[360px_1fr] gap-6">
        <ul className="flex flex-col gap-2">
          {users.map((u) => (
            <li
              key={u.id}
              onClick={() => selectUser(u)}
              className={`cursor-pointer rounded-xl border p-4 transition-all ${
                u.id === selectedId
                  ? 'border-accent bg-accent-soft shadow-sm'
                  : 'border-border bg-paper hover:border-foreground/20 hover:shadow-sm'
              }`}
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{u.full_name}</p>
                <Badge variant={u.role === 'supervisor' ? 'purple' : 'info'}>
                  {u.role === 'supervisor' ? 'Supervisor' : 'Asesor'}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{u.email}</p>
              {u.zone && <p className="mt-0.5 text-xs text-muted-foreground">Zona: {u.zone}</p>}
            </li>
          ))}
        </ul>

        <section className="rounded-2xl border border-border bg-paper p-8">
          <form onSubmit={handleSubmit} className="max-w-md">
            <h2 className="text-lg font-semibold">
              {selectedId === 'new' ? 'Crear usuario' : 'Editar usuario'}
            </h2>

            <label className="mb-1.5 mt-5 block text-sm font-medium">Nombre completo</label>
            <input
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              required
              className="w-full rounded-lg border border-border px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-primary"
            />

            <label className="mb-1.5 mt-4 block text-sm font-medium">Correo</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
              disabled={selectedId !== 'new'}
              className="w-full rounded-lg border border-border px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-primary disabled:bg-muted disabled:text-muted-foreground"
            />

            <label className="mb-1.5 mt-4 block text-sm font-medium">
              {selectedId === 'new' ? 'Contraseña' : 'Nueva contraseña (opcional)'}
            </label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required={selectedId === 'new'}
              placeholder={selectedId === 'new' ? 'Mínimo 8 caracteres' : 'Dejar vacío para no cambiarla'}
              className="w-full rounded-lg border border-border px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-primary"
            />

            <label className="mb-1.5 mt-4 block text-sm font-medium">Rol</label>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="w-full rounded-lg border border-border px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-primary"
            >
              <option value="asesor">Asesor de zona</option>
              <option value="supervisor">Supervisor</option>
            </select>

            {form.role === 'asesor' && (
              <>
                <label className="mb-1.5 mt-4 block text-sm font-medium">Zona</label>
                <input
                  value={form.zone}
                  onChange={(e) => setForm({ ...form, zone: e.target.value })}
                  placeholder="capital, interior…"
                  className="w-full rounded-lg border border-border px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-primary"
                />
              </>
            )}

            {error && <p className="mt-4 text-sm text-danger">{error}</p>}

            <div className="mt-6 flex items-center gap-3">
              <Button type="submit" disabled={saving}>
                {selectedId === 'new' ? 'Crear' : 'Guardar cambios'}
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
        title="Eliminar usuario"
        message="Esta acción no se puede deshacer."
        confirmLabel="Eliminar"
        danger
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}
