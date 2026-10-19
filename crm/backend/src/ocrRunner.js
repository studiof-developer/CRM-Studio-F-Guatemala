import fs from 'fs';
import { pool } from './db.js';
import { extractReceiptAmount } from './ocrPayment.js';
import { createOcrSession, extractDocumentText, isPaymentVoucher } from './ocrDocument.js';
import { getSetting } from './routes/settings.js';

// Lee adjuntos (imagen/PDF) de clientes y guarda cada resultado en attachment_ocr, para que un
// adjunto se lea una sola vez. El lector Tesseract se crea al primer uso: si todo ya está en
// caché (o no hay nada que leer) no se paga el costo de cargarlo. Lo usan el análisis histórico
// y la auditoría; maxReads evita que una sola auditoría se alargue sin límite.
// Tras cada lectura se espera hasta el mismo tiempo que tomó (máx. 4 s): el trabajo usa ~la mitad de la CPU.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createLazyOcrRunner({ maxReads = Infinity } = {}) {
  let session = null;
  let extraKeywords = null;
  let reads = 0;
  return {
    async run(att) {
      if (reads >= maxReads) return { amount: null, voucher: false, skipped: true };
      reads++;
      const t0 = Date.now();
      let amount = null;
      let voucher = false;
      let snippet = null;
      try {
        if (!session) {
          extraKeywords = await getSetting('extra_receipt_keywords', []);
          session = await createOcrSession();
        }
        const text = await extractDocumentText(await fs.promises.readFile(att.file_path), att.mime_type, session.recognize);
        amount = extractReceiptAmount(text, extraKeywords);
        voucher = isPaymentVoucher(text);
        snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);
      } catch (err) {
        console.error('OCR failed for attachment', att.id, err.message);
      }
      await pool.query(
        'INSERT INTO attachment_ocr (attachment_id, amount, voucher, snippet) VALUES ($1, $2, $3, $4) ON CONFLICT (attachment_id) DO NOTHING',
        [att.id, amount, voucher, snippet]
      );
      await sleep(Math.min(Date.now() - t0, 4000));
      return { amount, voucher };
    },
    async close() {
      if (session) await session.close();
    },
  };
}
