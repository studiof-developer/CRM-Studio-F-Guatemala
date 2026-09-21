import { pool } from './db.js';
import { encryptToken } from './tokenCrypto.js';
import { verifyNumber } from './whatsapp.js';

export async function seedDefaultWhatsappNumber() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

  if (!token?.trim() || !phoneNumberId?.trim()) {
    return;
  }

  try {
    // Check if a row with this phone_number_id exists
    const { rows: existing } = await pool.query(
      'SELECT id, branch_id FROM whatsapp_numbers WHERE phone_number_id = $1 LIMIT 1',
      [phoneNumberId.trim()]
    );

    if (existing.length > 0) {
      const numId = existing[0].id;
      // Link unassigned tickets and users to this line
      await pool.query('UPDATE tickets SET whatsapp_number_id = $1 WHERE whatsapp_number_id IS NULL', [numId]);
      await pool.query(
        `INSERT INTO user_whatsapp_numbers (user_id, whatsapp_number_id)
         SELECT u.id, $1 FROM users u
         ON CONFLICT DO NOTHING`,
        [numId]
      );
      return;
    }

    // Find the default branch (Studio F -> Sucursal Virtual)
    let branchId = null;
    const { rows: branchRows } = await pool.query(`
      SELECT b.id 
      FROM branches b 
      JOIN brands br ON b.brand_id = br.id 
      WHERE br.name = 'Studio F' AND b.name = 'Sucursal Virtual'
      LIMIT 1
    `);
    if (branchRows.length > 0) {
      branchId = branchRows[0].id;
    } else {
      const { rows: anyBranch } = await pool.query('SELECT id FROM branches ORDER BY id ASC LIMIT 1');
      if (anyBranch.length > 0) branchId = anyBranch[0].id;
    }

    let displayPhoneNumber = null;
    let verifiedName = 'Studio F Virtual';
    try {
      const info = await verifyNumber(phoneNumberId.trim(), token.trim());
      displayPhoneNumber = info.display_phone_number || null;
      verifiedName = info.verified_name || 'Studio F Virtual';
    } catch (err) {
      console.warn('[seedDefaultWhatsappNumber] Meta verification note:', err.message);
    }

    const { rows: inserted } = await pool.query(
      `INSERT INTO whatsapp_numbers
         (label, waba_id, phone_number_id, display_phone_number, verified_name, access_token_enc, is_active, last_tested_at, updated_by, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, true, now(), $7, $8)
       ON CONFLICT (phone_number_id) DO UPDATE SET
         branch_id = COALESCE(whatsapp_numbers.branch_id, EXCLUDED.branch_id),
         updated_at = now()
       RETURNING id`,
      [
        'Studio F Virtual',
        wabaId?.trim() || 'default',
        phoneNumberId.trim(),
        displayPhoneNumber,
        verifiedName,
        encryptToken(token.trim()),
        'Sistema (Auto-migración)',
        branchId
      ]
    );

    const numId = inserted[0]?.id;
    if (numId) {
      await pool.query('UPDATE tickets SET whatsapp_number_id = $1 WHERE whatsapp_number_id IS NULL', [numId]);
      await pool.query(
        `INSERT INTO user_whatsapp_numbers (user_id, whatsapp_number_id)
         SELECT u.id, $1 FROM users u
         ON CONFLICT DO NOTHING`,
        [numId]
      );
      console.log(`[seedDefaultWhatsappNumber] Default WhatsApp line registered & linked (ID: ${numId}, Branch: ${branchId})`);
    }
  } catch (err) {
    console.error('[seedDefaultWhatsappNumber] Error auto-seeding WhatsApp line:', err.message);
  }
}
