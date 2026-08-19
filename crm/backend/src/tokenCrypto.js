import crypto from 'crypto';

// WhatsApp access tokens now live in the database (editable from Configuración)
// instead of only in env vars — this is what keeps them unreadable to anyone who
// gets a DB dump. The master key itself stays in an env var on purpose: it's the
// one secret that must never sit next to the data it protects.
const ALGO = 'aes-256-gcm';

function getKey() {
  const raw = process.env.WHATSAPP_ENCRYPTION_KEY;
  if (!raw) throw new Error('WHATSAPP_ENCRYPTION_KEY not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('WHATSAPP_ENCRYPTION_KEY must decode to 32 bytes (base64)');
  return key;
}

export function encryptToken(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map((b) => b.toString('base64')).join(':');
}

export function decryptToken(stored) {
  const [ivB64, tagB64, dataB64] = stored.split(':');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function tokenLast4(plainText) {
  return plainText.slice(-4);
}
