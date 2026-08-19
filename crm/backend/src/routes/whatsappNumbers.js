import { Router } from 'express';
import { pool } from '../db.js';
import { logAccess } from '../auditLog.js';
import { encryptToken, decryptToken, tokenLast4 } from '../tokenCrypto.js';
import * as whatsapp from '../whatsapp.js';

const router = Router();

function serialize(row) {
  return {
    id: row.id,
    label: row.label,
    wabaId: row.waba_id,
    phoneNumberId: row.phone_number_id,
    displayPhoneNumber: row.display_phone_number,
    verifiedName: row.verified_name,
    tokenLast4: row.token_last4,
    isActive: row.is_active,
    lastTestedAt: row.last_tested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, label, waba_id, phone_number_id, display_phone_number, verified_name,
              access_token_enc, is_active, last_tested_at, created_at, updated_at, updated_by
       FROM whatsapp_numbers ORDER BY id ASC`
    );
    res.json(rows.map((r) => serialize({ ...r, token_last4: tokenLast4(decryptToken(r.access_token_enc)) })));
  } catch (err) { next(err); }
});

// Validates a number/token pair against Meta before it's ever saved — mirrors the
// "probar conexión" step so a typo doesn't get discovered by a customer not getting
// their message instead of by whoever's setting this up.
router.post('/test', async (req, res, next) => {
  try {
    const { phoneNumberId, accessToken } = req.body ?? {};
    if (!phoneNumberId?.trim() || !accessToken?.trim()) {
      return res.status(400).json({ error: 'phoneNumberId and accessToken required' });
    }
    const info = await whatsapp.verifyNumber(phoneNumberId.trim(), accessToken.trim());
    res.json({ ok: true, displayPhoneNumber: info.display_phone_number, verifiedName: info.verified_name });
  } catch (err) {
    res.status(400).json({ error: `No se pudo validar con WhatsApp: ${err.message}` });
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { label, wabaId, phoneNumberId, accessToken } = req.body ?? {};
    if (!label?.trim() || !wabaId?.trim() || !phoneNumberId?.trim() || !accessToken?.trim()) {
      return res.status(400).json({ error: 'label, wabaId, phoneNumberId and accessToken required' });
    }

    let info;
    try {
      info = await whatsapp.verifyNumber(phoneNumberId.trim(), accessToken.trim());
    } catch (err) {
      return res.status(400).json({ error: `No se pudo validar con WhatsApp: ${err.message}` });
    }

    const { rows } = await pool.query(
      `INSERT INTO whatsapp_numbers
         (label, waba_id, phone_number_id, display_phone_number, verified_name, access_token_enc, last_tested_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
       RETURNING id, label, waba_id, phone_number_id, display_phone_number, verified_name,
                 access_token_enc, is_active, last_tested_at, created_at, updated_at, updated_by`,
      [label.trim(), wabaId.trim(), phoneNumberId.trim(), info.display_phone_number ?? null, info.verified_name ?? null,
       encryptToken(accessToken.trim()), req.user.fullName]
    );
    logAccess(req.user, null, 'whatsapp_number_created');
    res.status(201).json(serialize({ ...rows[0], token_last4: tokenLast4(accessToken.trim()) }));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ese número ya está registrado' });
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query(`SELECT * FROM whatsapp_numbers WHERE id = $1`, [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'not found' });

    const { label, wabaId, phoneNumberId, accessToken, isActive } = req.body ?? {};
    let displayPhoneNumber = existing[0].display_phone_number;
    let verifiedName = existing[0].verified_name;
    let accessTokenEnc = existing[0].access_token_enc;
    let lastTestedAt = existing[0].last_tested_at;

    // Only re-validate against Meta when the token or the number actually changed —
    // no need to burn an API call just for a label rename or an activate/deactivate toggle.
    if (accessToken?.trim() || phoneNumberId?.trim()) {
      const testPhoneNumberId = phoneNumberId?.trim() || existing[0].phone_number_id;
      const testToken = accessToken?.trim() || decryptToken(existing[0].access_token_enc);
      let info;
      try {
        info = await whatsapp.verifyNumber(testPhoneNumberId, testToken);
      } catch (err) {
        return res.status(400).json({ error: `No se pudo validar con WhatsApp: ${err.message}` });
      }
      displayPhoneNumber = info.display_phone_number ?? null;
      verifiedName = info.verified_name ?? null;
      lastTestedAt = new Date();
      if (accessToken?.trim()) accessTokenEnc = encryptToken(accessToken.trim());
    }

    const { rows } = await pool.query(
      `UPDATE whatsapp_numbers SET
         label = COALESCE($1, label),
         waba_id = COALESCE($2, waba_id),
         phone_number_id = COALESCE($3, phone_number_id),
         display_phone_number = $4,
         verified_name = $5,
         access_token_enc = $6,
         is_active = COALESCE($7, is_active),
         last_tested_at = $8,
         updated_at = now(),
         updated_by = $9
       WHERE id = $10
       RETURNING id, label, waba_id, phone_number_id, display_phone_number, verified_name,
                 access_token_enc, is_active, last_tested_at, created_at, updated_at, updated_by`,
      [label?.trim() || null, wabaId?.trim() || null, phoneNumberId?.trim() || null, displayPhoneNumber, verifiedName,
       accessTokenEnc, isActive ?? null, lastTestedAt, req.user.fullName, req.params.id]
    );
    logAccess(req.user, null, 'whatsapp_number_updated');
    res.json(serialize({ ...rows[0], token_last4: tokenLast4(decryptToken(rows[0].access_token_enc)) }));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ese número ya está registrado' });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`DELETE FROM whatsapp_numbers WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    logAccess(req.user, null, 'whatsapp_number_deleted');
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
