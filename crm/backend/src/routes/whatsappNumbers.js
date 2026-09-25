import { Router } from 'express';
import { pool } from '../db.js';
import { logAccess } from '../auditLog.js';
import { encryptToken, decryptToken, tokenLast4 } from '../tokenCrypto.js';
import * as whatsapp from '../whatsapp.js';
import { seedDefaultWhatsappNumber } from '../seedWhatsappNumber.js';

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
    branchId: row.branch_id,
    brandId: row.brand_id,
    branchName: row.branch_name,
    brandName: row.brand_name,
    companyId: row.company_id,
    companyName: row.company_name,
  };
}

router.get('/', async (req, res, next) => {
  try {
    let { rows } = await pool.query(
      `SELECT w.id, w.label, w.waba_id, w.phone_number_id, w.display_phone_number, w.verified_name,
              w.access_token_enc, w.is_active, w.last_tested_at, w.created_at, w.updated_at, w.updated_by,
              w.branch_id, br.name AS branch_name, brnd.id AS brand_id, brnd.name AS brand_name,
              c.id AS company_id, c.name AS company_name
       FROM whatsapp_numbers w
       LEFT JOIN branches br ON w.branch_id = br.id
       LEFT JOIN brands brnd ON br.brand_id = brnd.id
       LEFT JOIN companies c ON brnd.company_id = c.id
       ORDER BY w.id ASC`
    );

    if (rows.length === 0) {
      await seedDefaultWhatsappNumber();
      const refetched = await pool.query(
        `SELECT w.id, w.label, w.waba_id, w.phone_number_id, w.display_phone_number, w.verified_name,
                w.access_token_enc, w.is_active, w.last_tested_at, w.created_at, w.updated_at, w.updated_by,
                w.branch_id, br.name AS branch_name, brnd.id AS brand_id, brnd.name AS brand_name,
                c.id AS company_id, c.name AS company_name
         FROM whatsapp_numbers w
         LEFT JOIN branches br ON w.branch_id = br.id
         LEFT JOIN brands brnd ON br.brand_id = brnd.id
         LEFT JOIN companies c ON brnd.company_id = c.id
         ORDER BY w.id ASC`
      );
      rows = refetched.rows;
    }

    res.json(rows.map((r) => serialize({ ...r, token_last4: tokenLast4(decryptToken(r.access_token_enc)) })));
  } catch (err) { next(err); }
});

// Validates a number/token pair against Meta before it's ever saved — mirrors the
// "probar conexión" step so a typo doesn't get discovered by a customer not getting
// their message instead of by whoever's setting this up.
router.post('/test', async (req, res, next) => {
  try {
    const { phoneNumberId, accessToken, wabaId } = req.body ?? {};
    if (!phoneNumberId?.trim() || !accessToken?.trim()) {
      return res.status(400).json({ error: 'phoneNumberId and accessToken required' });
    }
    const info = await whatsapp.verifyNumber(phoneNumberId.trim(), accessToken.trim(), wabaId?.trim());
    res.json({ ok: true, displayPhoneNumber: info.display_phone_number, verifiedName: info.verified_name });
  } catch (err) {
    res.status(400).json({ error: `No se pudo validar con WhatsApp: ${err.message}` });
  }
});

router.post('/:id/test', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM whatsapp_numbers WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });

    const token = decryptToken(rows[0].access_token_enc);
    const info = await whatsapp.verifyNumber(rows[0].phone_number_id, token, rows[0].waba_id);

    await pool.query(`UPDATE whatsapp_numbers SET last_tested_at = now() WHERE id = $1`, [req.params.id]);

    res.json({
      ok: true,
      displayPhoneNumber: info.display_phone_number,
      verifiedName: info.verified_name,
      qualityRating: info.quality_rating,
      codeVerificationStatus: info.code_verification_status,
    });
  } catch (err) {
    res.status(400).json({ error: `No se pudo validar con WhatsApp: ${err.message}` });
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { label, wabaId, phoneNumberId, accessToken, branchId, pin } = req.body ?? {};
    if (!label?.trim() || !wabaId?.trim() || !phoneNumberId?.trim() || !accessToken?.trim() || !branchId) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios (incluyendo la sucursal)' });
    }

    const cleanBranchId = Number(branchId);
    if (!cleanBranchId || isNaN(cleanBranchId)) {
      return res.status(400).json({ error: 'Debes seleccionar una sucursal válida' });
    }

    let info;
    try {
      info = await whatsapp.verifyNumber(phoneNumberId.trim(), accessToken.trim(), wabaId?.trim());
    } catch (err) {
      return res.status(400).json({ error: `No se pudo validar con WhatsApp: ${err.message}` });
    }

    // Auto-register number on Meta Cloud API with PIN
    const pinToTry = pin?.trim() || '123456';
    try {
      await whatsapp.registerNumber(phoneNumberId.trim(), pinToTry, accessToken.trim());
      console.log(`[whatsappNumbers] Number ${phoneNumberId.trim()} successfully registered on Cloud API`);
    } catch (regErr) {
      console.warn(`[whatsappNumbers] Cloud API register note:`, regErr.message);
    }

    const { rows } = await pool.query(
      `INSERT INTO whatsapp_numbers
         (label, waba_id, phone_number_id, display_phone_number, verified_name, access_token_enc, last_tested_at, updated_by, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8)
       RETURNING id, label, waba_id, phone_number_id, display_phone_number, verified_name, branch_id,
                 access_token_enc, is_active, last_tested_at, created_at, updated_at, updated_by`,
      [label.trim(), wabaId.trim(), phoneNumberId.trim(), info.display_phone_number ?? null, info.verified_name ?? null,
       encryptToken(accessToken.trim()), req.user.fullName, cleanBranchId]
    );
    logAccess(req.user, null, 'whatsapp_number_created');
    if (rows[0].waba_id && rows[0].is_active) {
      whatsapp.subscribeWaba(rows[0].waba_id, accessToken.trim()).catch((err) =>
        console.warn(`[whatsappNumbers] Note subscribing WABA ${rows[0].waba_id}:`, err.message)
      );
    }
    res.status(201).json(serialize({ ...rows[0], token_last4: tokenLast4(accessToken.trim()) }));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ese número ya está registrado' });
    if (err.code === '23503') return res.status(400).json({ error: 'La sucursal seleccionada no existe' });
    next(err);
  }
});

router.post('/:id/register', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM whatsapp_numbers WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const { pin } = req.body ?? {};
    const pinToUse = pin?.trim() || '123456';
    const token = decryptToken(rows[0].access_token_enc);
    const result = await whatsapp.registerNumber(rows[0].phone_number_id, pinToUse, token);
    console.log(`[whatsappNumbers] Number ${rows[0].phone_number_id} successfully registered on Cloud API via /register`);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ error: `Error registrando número en WhatsApp Cloud API: ${err.message}` });
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query(`SELECT * FROM whatsapp_numbers WHERE id = $1`, [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'not found' });

    const { label, wabaId, phoneNumberId, accessToken, isActive, branchId, pin } = req.body ?? {};
    let displayPhoneNumber = existing[0].display_phone_number;
    let verifiedName = existing[0].verified_name;
    let accessTokenEnc = existing[0].access_token_enc;
    let lastTestedAt = existing[0].last_tested_at;

    // Only re-validate against Meta when the token or the number actually changed —
    // no need to burn an API call just for a label rename or an activate/deactivate toggle.
    if (accessToken?.trim() || phoneNumberId?.trim() || pin?.trim()) {
      const testPhoneNumberId = phoneNumberId?.trim() || existing[0].phone_number_id;
      const testToken = accessToken?.trim() || decryptToken(existing[0].access_token_enc);
      const testWabaId = wabaId?.trim() || existing[0].waba_id;
      let info;
      try {
        info = await whatsapp.verifyNumber(testPhoneNumberId, testToken, testWabaId);
      } catch (err) {
        return res.status(400).json({ error: `No se pudo validar con WhatsApp: ${err.message}` });
      }
      displayPhoneNumber = info.display_phone_number ?? null;
      verifiedName = info.verified_name ?? null;
      lastTestedAt = new Date();
      if (accessToken?.trim()) accessTokenEnc = encryptToken(accessToken.trim());

      // Auto-register number on Meta Cloud API with PIN
      const testPin = pin?.trim() || '123456';
      try {
        await whatsapp.registerNumber(testPhoneNumberId, testPin, testToken);
        console.log(`[whatsappNumbers] Number ${testPhoneNumberId} successfully registered on Cloud API with PIN ${testPin}`);
      } catch (regErr) {
        console.warn(`[whatsappNumbers] Cloud API register note:`, regErr.message);
        if (pin?.trim()) {
          return res.status(400).json({ error: `El PIN ingresado fue rechazado por WhatsApp: ${regErr.message}` });
        }
      }
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
         updated_by = $9,
         branch_id = COALESCE($10, branch_id)
       WHERE id = $11
       RETURNING id, label, waba_id, phone_number_id, display_phone_number, verified_name, branch_id,
                 access_token_enc, is_active, last_tested_at, created_at, updated_at, updated_by`,
      [label?.trim() || null, wabaId?.trim() || null, phoneNumberId?.trim() || null, displayPhoneNumber, verifiedName,
       accessTokenEnc, isActive ?? null, lastTestedAt, req.user.fullName, branchId || null, req.params.id]
    );
    logAccess(req.user, null, 'whatsapp_number_updated');
    const activeToken = decryptToken(rows[0].access_token_enc);
    if (rows[0].waba_id && rows[0].is_active && activeToken) {
      whatsapp.subscribeWaba(rows[0].waba_id, activeToken).catch((err) =>
        console.warn(`[whatsappNumbers] Note subscribing WABA ${rows[0].waba_id}:`, err.message)
      );
    }
    res.json(serialize({ ...rows[0], token_last4: tokenLast4(activeToken) }));
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
