import { useEffect, useState, useCallback, useMemo } from 'react';
import { UserPlus, Trash2, ShieldCheck, UserCog, User, Smartphone, Edit2 } from 'lucide-react';
import { fetchUsers, createUser, updateUser, deleteUser, fetchWhatsappNumbers } from './api.js';
import Badge from './components/Badge.jsx';
import { Button } from './components/ui.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import { showSuccess, showError } from './components/Toast.jsx';

const EMPTY_FORM = { full_name: '', username: '', email: '', password: '', role: 'asesor', zone: '', assigned_lines: [] };

const ROLE_LABELS = { admin: 'Admin', supervisor: 'Supervisor', asesor: 'Asesor' };
const ROLE_BADGE_VARIANT = { admin: 'danger', supervisor: 'purple', asesor: 'info' };

const DIACRITICS_RE = new RegExp('[\\u0300-\\u036f]', 'g');

function suggestUsername(fullName) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const raw = parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1]}` : parts[0];
  return raw
    .normalize('NFD').replace(DIACRITICS_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
}

function Modal({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm overflow-y-auto">
      <div className="w-full max-w-xl rounded-2xl bg-paper border border-line p-6 shadow-xl relative text-left my-8">
        <button type="button" onClick={onClose} className="absolute right-4 top-4 text-greige-ink hover:text-ink">
          ✕
        </button>
        <h2 className="mb-4 text-xl font-bold text-ink">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export default function Users() {
  const [users, setUsers] = useState([]);
  const [whatsappNumbers, setWhatsappNumbers] = useState([]);
  
  const [modal, setModal] = useState({ open: false, mode: 'create', data: null });
  const [form, setForm] = useState(EMPTY_FORM);
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(() => {
    setLoading(true);
    Promise.all([fetchUsers(), fetchWhatsappNumbers()])
      .then(([usersData, linesData]) => {
        setUsers(usersData);
        setWhatsappNumbers(linesData);
      })
      .catch(err => showError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Group lines by company, brand and branch for the assignment UI
  const groupedLines = useMemo(() => {
    const groups = {};
    for (const line of whatsappNumbers) {
      if (!line.brandName || !line.branchName) continue;
      const brandKey = line.companyName ? `${line.companyName} › ${line.brandName}` : line.brandName;
      if (!groups[brandKey]) groups[brandKey] = {};
      if (!groups[brandKey][line.branchName]) groups[brandKey][line.branchName] = [];
      groups[brandKey][line.branchName].push(line);
    }
    return groups;
  }, [whatsappNumbers]);

  function handleOpenCreate() {
    setForm(EMPTY_FORM);
    setUsernameTouched(false);
    setModal({ open: true, mode: 'create', data: null });
  }

  function handleOpenEdit(user) {
    setForm({
      full_name: user.full_name,
      username: user.username,
      email: user.email || '',
      password: '',
      role: user.role,
      zone: user.zone || '',
      assigned_lines: user.assigned_lines || []
    });
    setUsernameTouched(true);
    setModal({ open: true, mode: 'edit', data: user });
  }

  function handleNameChange(val) {
    setForm(prev => {
      const next = { ...prev, full_name: val };
      if (!usernameTouched) {
        next.username = suggestUsername(val);
      }
      return next;
    });
  }

  function handleLineToggle(lineId) {
    setForm(prev => {
      const exists = prev.assigned_lines.includes(lineId);
      return {
        ...prev,
        assigned_lines: exists
          ? prev.assigned_lines.filter(id => id !== lineId)
          : [...prev.assigned_lines, lineId]
      };
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form };
      if (modal.mode === 'edit' && !payload.password) {
        delete payload.password;
      }
      if (modal.mode === 'create') {
        await createUser(payload);
        showSuccess('Usuario creado');
      } else {
        await updateUser(modal.data.id, payload);
        showSuccess('Usuario actualizado');
      }
      setModal({ open: false, data: null });
      loadData();
    } catch (err) {
      showError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    setDeleting(true);
    try {
      await deleteUser(id);
      showSuccess('Usuario eliminado');
      setConfirmDeleteId(null);
      loadData();
    } catch (err) {
      showError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="p-8 text-center text-greige">Cargando usuarios...</div>;

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Usuarios</h1>
          <p className="mt-1 text-sm text-greige-ink">Administradores, supervisores y asesores del sistema.</p>
        </div>
        <button
          onClick={handleOpenCreate}
          className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-transform hover:bg-accent-hover hover:scale-105 active:scale-95"
        >
          <UserPlus size={16} /> Nuevo usuario
        </button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-paper shadow-sm">
        <table className="w-full text-left text-sm text-ink whitespace-nowrap">
          <thead className="border-b border-line-soft bg-black/[0.03] dark:bg-white/[0.04] text-greige-ink">
            <tr>
              <th className="p-4 font-medium">Usuario</th>
              <th className="p-4 font-medium">Nombre / Correo</th>
              <th className="p-4 font-medium">Rol</th>
              <th className="p-4 font-medium">Líneas Asignadas</th>
              <th className="p-4 font-medium text-right">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {users.map(u => (
              <tr key={u.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors">
                <td className="p-4 font-medium flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/10 dark:bg-accent/20 text-accent font-bold">
                    {u.username.charAt(0).toUpperCase()}
                  </div>
                  {u.username}
                </td>
                <td className="p-4">
                  <div className="flex flex-col">
                    <span className="font-medium text-ink">{u.full_name}</span>
                    {u.email && <span className="text-xs text-greige-ink">{u.email}</span>}
                  </div>
                </td>
                <td className="p-4">
                  <Badge variant={u.role === 'admin' ? 'success' : u.role === 'supervisor' ? 'warning' : 'neutral'}>
                    {u.role === 'admin' ? 'Admin' : u.role === 'supervisor' ? 'Supervisor' : 'Asesor'}
                  </Badge>
                </td>
                <td className="p-4 text-xs text-greige-ink">
                  {u.role === 'asesor' ? (
                    u.assigned_lines?.length > 0 ? (
                      <span className="inline-flex items-center gap-1.5 rounded-lg bg-black/5 dark:bg-white/[0.08] px-2 py-1 text-ink">
                        <Smartphone size={12} /> {u.assigned_lines.length} {u.assigned_lines.length === 1 ? 'línea' : 'líneas'}
                      </span>
                    ) : (
                      <span className="italic text-error">Sin asignar</span>
                    )
                  ) : (
                    <span className="text-greige">Todo</span>
                  )}
                </td>
                <td className="p-4 text-right">
                  <div className="flex justify-end gap-2">
                    <button onClick={() => handleOpenEdit(u)} className="rounded-lg p-2 text-greige-ink hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink transition-colors">
                      <Edit2 size={16} />
                    </button>
                    {u.username !== 'admin' && (
                      confirmDeleteId === u.id ? (
                        <button onClick={() => handleDelete(u.id)} disabled={deleting} className="rounded-lg bg-error/10 p-2 text-error hover:bg-error hover:text-white transition-colors">
                          Confirmar
                        </button>
                      ) : (
                        <button onClick={() => setConfirmDeleteId(u.id)} className="rounded-lg p-2 text-greige-ink hover:bg-error/10 hover:text-error transition-colors">
                          <Trash2 size={16} />
                        </button>
                      )
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={modal.open} onClose={() => setModal({ open: false, data: null })} title={modal.mode === 'create' ? 'Nuevo Usuario' : 'Editar Usuario'}>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-ink">Nombre completo</span>
              <input
                value={form.full_name}
                onChange={(e) => handleNameChange(e.target.value)}
                required
                className="rounded-lg border border-line bg-paper text-ink px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-ink">Usuario (login)</span>
              <input
                value={form.username}
                onChange={(e) => { setForm({ ...form, username: e.target.value }); setUsernameTouched(true); }}
                required
                pattern="^[a-z0-9._-]{3,32}$"
                title="3-32 caracteres: letras minúsculas, números, puntos, guiones"
                className="rounded-lg border border-line bg-paper text-ink px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-ink">Rol</span>
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="rounded-lg border border-line bg-paper text-ink px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
              >
                <option value="asesor">Asesor</option>
                <option value="supervisor">Supervisor</option>
                <option value="admin">Administrador</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-ink">Contraseña {modal.mode === 'edit' && '(opcional)'}</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required={modal.mode === 'create'}
                minLength={8}
                className="rounded-lg border border-line bg-paper text-ink px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent"
              />
            </label>
          </div>

          {form.role === 'asesor' && (
            <div className="mt-4 rounded-xl border border-line-soft bg-black/[0.03] dark:bg-white/[0.03] p-4">
              <h3 className="mb-3 font-semibold text-ink flex items-center gap-2"><Smartphone size={16}/> Asignación de Líneas</h3>
              <p className="mb-4 text-xs text-greige-ink">Selecciona las líneas de atención a las que este asesor tendrá acceso.</p>
              
              <div className="flex max-h-[300px] flex-col gap-4 overflow-y-auto pr-2">
                {Object.entries(groupedLines).length === 0 ? (
                  <p className="text-sm text-greige-ink italic">No hay líneas configuradas en el sistema.</p>
                ) : (
                  Object.entries(groupedLines).map(([brandName, branches]) => (
                    <div key={brandName} className="flex flex-col gap-2">
                      <h4 className="font-bold text-sm text-ink">{brandName}</h4>
                      {Object.entries(branches).map(([branchName, lines]) => (
                        <div key={branchName} className="ml-2 flex flex-col gap-2 border-l-2 border-line-soft pl-3">
                          <span className="text-xs font-semibold text-greige uppercase">{branchName}</span>
                          {lines.map(line => (
                            <label key={line.id} className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={form.assigned_lines.includes(line.id)}
                                onChange={() => handleLineToggle(line.id)}
                                className="h-4 w-4 rounded border-line text-accent focus:ring-accent"
                              />
                              <span className="text-sm text-ink">{line.label} <span className="text-xs text-greige">({line.displayPhoneNumber})</span></span>
                            </label>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="mt-6 flex items-center justify-end gap-3 pt-4 border-t border-line-soft">
            <button
              type="button"
              onClick={() => setModal({ open: false, data: null })}
              className="rounded-xl px-4 py-2 text-sm font-medium text-greige-ink hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-hover transition-transform hover:scale-105 active:scale-95 disabled:opacity-50"
            >
              {saving ? 'Guardando...' : 'Guardar usuario'}
            </button>
          </div>
        </form>
      </Modal>

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
