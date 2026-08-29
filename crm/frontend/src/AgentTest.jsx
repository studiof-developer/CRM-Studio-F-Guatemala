import { useState, useRef, useEffect } from 'react';
import { Send, RotateCcw, TestTube, Loader2 } from 'lucide-react';
import { sendAgentTestMessage } from './api.js';
import { showError } from './components/Toast.jsx';

// A fresh id per mount/reset — n8n's own Postgres Chat Memory is what actually keeps
// the conversation's context between messages, keyed by this id. Nothing about a real
// customer conversation exists here: no WABA, no phone number, no n8n_chat_histories row.
function newTestSessionId() {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function AgentTest() {
  const [testSessionId, setTestSessionId] = useState(newTestSessionId);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  function handleReset() {
    setTestSessionId(newTestSessionId());
    setMessages([]);
  }

  async function handleSend(e) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setDraft('');
    setMessages((prev) => [...prev, { role: 'user', content, id: `u-${prev.length}` }]);
    setSending(true);
    try {
      const reply = await sendAgentTestMessage(testSessionId, content);
      setMessages((prev) => [...prev, { role: 'agent', content: reply, id: `a-${prev.length}` }]);
    } catch (err) {
      showError(err.message);
      setMessages((prev) => [...prev, { role: 'error', content: err.message, id: `e-${prev.length}` }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-8 py-8">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <TestTube size={22} className="text-cyan" /> Pruebas del agente
          </h1>
          <p className="mt-1 text-sm text-greige-ink">
            Habla directo con el agente de IA en un espacio aislado — nada de esto toca WhatsApp real ni ningún cliente.
          </p>
        </div>
        <button
          onClick={handleReset}
          className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
        >
          <RotateCcw size={14} /> Reiniciar conversación
        </button>
      </div>

      <div className="mb-4 rounded-xl border border-cyan/30 bg-cyan-bg px-4 py-2.5 text-xs text-ink">
        Sesión de prueba: <code className="font-mono text-cyan">{testSessionId}</code> — el agente recuerda esta conversación mientras no le des "Reiniciar".
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto rounded-2xl border border-line bg-paper p-5">
        {messages.length === 0 && (
          <p className="m-auto text-sm text-greige-ink">Escribe algo abajo para empezar — como si fueras un cliente nuevo.</p>
        )}
        <div className="flex flex-col gap-3">
          {messages.map((m) => (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-accent text-white'
                    : m.role === 'error'
                      ? 'bg-danger-bg text-danger'
                      : 'bg-black/[0.04] text-ink dark:bg-white/[0.06]'
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="flex items-center gap-1.5 rounded-2xl bg-black/[0.04] px-4 py-2.5 text-sm text-greige-ink dark:bg-white/[0.06]">
                <Loader2 size={13} className="animate-spin" /> El agente está escribiendo…
              </div>
            </div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSend} className="mt-4 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Escribe como si fueras el cliente…"
          disabled={sending}
          className="w-full rounded-full border border-line bg-black/[0.03] px-4 py-2.5 text-sm outline-none transition-colors focus:border-accent focus:bg-paper disabled:opacity-50 dark:bg-white/[0.05]"
        />
        <button
          type="submit"
          disabled={sending || !draft.trim()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-md shadow-accent/20 transition-transform hover:scale-105 active:scale-95 disabled:opacity-50"
          aria-label="Enviar"
        >
          <Send size={16} />
        </button>
      </form>
    </div>
  );
}
