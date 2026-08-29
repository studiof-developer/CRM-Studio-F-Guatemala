import { Router } from 'express';

const router = Router();

// Relays to a dedicated n8n webhook that feeds the same AI Agent used for real WhatsApp
// conversations, but returns its reply synchronously instead of sending it over
// WhatsApp — that separate webhook lives in n8n and isn't built by this codebase.
// testSessionId is chosen by the frontend (not derived from the logged-in admin), so
// "reiniciar conversación" is just picking a fresh id — n8n's own Postgres Chat Memory
// is what actually remembers the conversation between messages, keyed by that id.
router.post('/message', async (req, res, next) => {
  try {
    const { message, testSessionId } = req.body ?? {};
    if (!message?.trim()) return res.status(400).json({ error: 'message required' });
    if (!testSessionId?.trim()) return res.status(400).json({ error: 'testSessionId required' });
    if (!process.env.N8N_TEST_AGENT_URL) {
      return res.status(503).json({ error: 'El webhook de prueba de n8n todavía no está configurado (N8N_TEST_AGENT_URL).' });
    }

    let response;
    try {
      response = await fetch(process.env.N8N_TEST_AGENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Test-Secret': process.env.N8N_TEST_AGENT_SECRET ?? '' },
        body: JSON.stringify({ testSessionId: testSessionId.trim(), message: message.trim() }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      return res.status(502).json({ error: `No se pudo contactar el webhook de prueba de n8n: ${err.message}` });
    }

    const text = await response.text();
    if (!response.ok) {
      return res.status(502).json({ error: `n8n respondió ${response.status}: ${text.slice(0, 300)}` });
    }
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    const reply = data?.reply ?? data?.output ?? data?.message ?? (data == null ? text : JSON.stringify(data));
    res.json({ reply });
  } catch (err) { next(err); }
});

export default router;
