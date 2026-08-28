import https from 'https';

// The ERP's server presents a self-signed cert with CN=localhost — hostname verification
// can never pass against its real IP regardless of what we do, so instead of disabling
// TLS verification outright, the exact certificate is pinned by its SHA-256 fingerprint
// (confirmed directly with whoever administers that server on 2026-08-26). Any other
// cert — a real rotation we weren't told about, or a machine-in-the-middle — is rejected.
const HOST = process.env.ERP_HOST || '50.21.176.81';
const PORT = Number(process.env.ERP_PORT || 8443);
const API_KEY = process.env.ERP_API_KEY;
const PINNED_FINGERPRINT = (process.env.ERP_CERT_FINGERPRINT || '').toUpperCase();
const TIMEOUT_MS = 30_000;

function get(path) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) return reject(new Error('ERP_API_KEY no está configurado'));
    if (!PINNED_FINGERPRINT) return reject(new Error('ERP_CERT_FINGERPRINT no está configurado'));

    const req = https.request({
      hostname: HOST,
      port: PORT,
      path,
      method: 'GET',
      headers: { 'X-Api-Key': API_KEY },
      // Only rejectUnauthorized:false because checkServerIdentity below does the real
      // verification — against the pinned fingerprint, not against a CA chain that a
      // self-signed CN=localhost cert could never satisfy anyway.
      rejectUnauthorized: false,
      checkServerIdentity: (_hostname, cert) => {
        if (cert.fingerprint256 !== PINNED_FINGERPRINT) {
          return new Error(
            `Certificado del ERP no coincide con el fijado — posible cambio de certificado sin avisar, o intercepción de red. Recibido: ${cert.fingerprint256}`
          );
        }
        return undefined;
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`ERP API ${res.statusCode}: ${data.slice(0, 300)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`ERP API devolvió JSON inválido: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('ERP API: tiempo de espera agotado')));
    req.end();
  });
}

export async function fetchErpCustomers() {
  const body = await get('/api/data/cliente-resumen-crm');
  return body?.data ?? [];
}

export async function fetchErpInventory() {
  const body = await get('/api/data/existencia');
  return body?.data ?? [];
}
