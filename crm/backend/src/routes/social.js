// CRM-facing routes for the Instagram/Messenger inbox — deliberately simple, no Pipeline
// stages/temperature/SLA concepts (those don't exist for a social contact yet, see the
// 2026-09-14 plan). Logged-in advisors/admins only, same as conversations.js.
import { Router } from 'express';
import { pool } from '../db.js';
import { sendMessengerText, sendInstagramText } from '../metaMessaging.js';
import { logBusinessAction } from '../auditLog.js';

const router = Router();

router.get('/contacts', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT sc.id, sc.provider, sc.external_id, sc.display_name, sc.profile_pic_url,
             sc.last_message_at, sc.unread_count,
             sm.body AS last_message_body, sm.direction AS last_message_direction
      FROM social_contacts sc
      LEFT JOIN LATERAL (
        SELECT body, direction FROM social_messages
        WHERE contact_id = sc.id ORDER BY created_at DESC LIMIT 1
      ) sm ON true
      ORDER BY sc.last_message_at DESC NULLS LAST
    `);
    res.json(rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      externalId: r.external_id,
      displayName: r.display_name,
      profilePicUrl: r.profile_pic_url,
      lastMessageAt: r.last_message_at,
      unreadCount: r.unread_count,
      lastMessage: r.last_message_body,
      lastMessageDirection: r.last_message_direction,
    })));
  } catch (err) { next(err); }
});

router.get('/contacts/:id/messages', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, direction, body, created_at FROM social_messages
       WHERE contact_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    // Opening the thread is what "reading" it means here — no separate read-state table
    // like WhatsApp's conversation_reads, this inbox doesn't have the same shared-team
    // "who read what" nuance yet.
    await pool.query(`UPDATE social_contacts SET unread_count = 0 WHERE id = $1`, [req.params.id]);
    res.json(rows.map((r) => ({ id: r.id, direction: r.direction, body: r.body, createdAt: r.created_at })));
  } catch (err) { next(err); }
});

router.post('/contacts/:id/messages', async (req, res, next) => {
  try {
    const { body } = req.body ?? {};
    if (!body?.trim()) return res.status(400).json({ error: 'body required' });
    const { rows: contactRows } = await pool.query(`SELECT provider, external_id FROM social_contacts WHERE id = $1`, [req.params.id]);
    if (!contactRows.length) return res.status(404).json({ error: 'not found' });
    const { provider, external_id: externalId } = contactRows[0];

    const send = provider === 'instagram' ? sendInstagramText : sendMessengerText;
    let externalMessageId = null;
    try {
      const result = await send(externalId, body.trim());
      externalMessageId = result?.message_id ?? null;
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }

    const { rows } = await pool.query(
      `INSERT INTO social_messages (contact_id, direction, body, external_message_id)
       VALUES ($1, 'out', $2, $3) RETURNING id, created_at`,
      [req.params.id, body.trim(), externalMessageId]
    );
    await pool.query(`UPDATE social_contacts SET last_message_at = now() WHERE id = $1`, [req.params.id]);
    logBusinessAction(req.user, null, 'social_message_sent', `${provider}:${externalId}`);
    res.status(201).json({ id: rows[0].id, direction: 'out', body: body.trim(), createdAt: rows[0].created_at });
  } catch (err) { next(err); }
});

export default router;
