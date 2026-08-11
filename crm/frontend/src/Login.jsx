import { useState } from 'react';
import { motion } from 'framer-motion';
import { login } from './api.js';
import { Field, Button } from './components/ui.jsx';

export default function Login({ onLoggedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const user = await login(email, password);
      onLoggedIn(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <motion.form
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        onSubmit={handleSubmit}
        className="glass-card w-full max-w-sm rounded-3xl p-8"
      >
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-sm font-semibold text-white shadow-md shadow-accent/20">
            SF
          </div>
          <h1 className="text-lg font-semibold text-ink">Studio F CRM</h1>
          <p className="mt-1 text-sm text-greige-ink">Inicia sesión para continuar</p>
        </div>

        <div className="flex flex-col gap-4">
          <Field
            label="Correo"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            placeholder="tu@studiof.gt"
          />

          <Field
            label="Contraseña"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            placeholder="••••••••"
          />
        </div>

        {error && <p className="mt-4 text-sm text-danger">{error}</p>}

        <Button type="submit" disabled={loading} className="mt-6 w-full">
          {loading ? 'Ingresando…' : 'Ingresar'}
        </Button>
      </motion.form>
    </div>
  );
}
