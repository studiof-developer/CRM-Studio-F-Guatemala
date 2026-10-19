import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createWorker } from 'tesseract.js';
import { UPLOAD_DIR } from './attachmentStorage.js';
import { extractText, tesseractErrorHandler } from './ocrPayment.js';

const execFileAsync = promisify(execFile);
const GS_TIMEOUT_MS = 60_000;
const RECOGNIZE_TIMEOUT_MS = 45_000;
// Un PDF "de verdad" (generado por el banco) trae el texto incrustado; uno escaneado o una foto
// metida en PDF no, y ahí hay que rasterizar y pasar OCR. Por debajo de este largo se asume escaneado.
const MIN_EMBEDDED_TEXT = 40;

// El voucher de aprobación de NeoLink/pasarela (pantalla "Aprobada ... Descargar voucher") no
// trae monto, pero SÍ prueba que el pago con link se aprobó. Se guarda aparte del monto.
export function isPaymentVoucher(ocrText) {
  return /(aprobad[ao]|descargar\s+voucher|neolink|transacci[oó]n\s+(exitosa|aprobada)|pago\s+(exitoso|aprobado))/i.test(ocrText ?? '');
}

async function withTempFile(buffer, ext, fn) {
  const file = path.join(os.tmpdir(), `${crypto.randomUUID()}${ext}`);
  try {
    await fs.promises.writeFile(file, buffer);
    return await fn(file);
  } finally {
    await fs.promises.unlink(file).catch(() => {});
  }
}

export function pdfEmbeddedText(buffer) {
  return withTempFile(buffer, '.pdf', async (pdf) => {
    try {
      const { stdout } = await execFileAsync('gs', ['-sDEVICE=txtwrite', '-dNOPAUSE', '-dQUIET', '-dBATCH', '-sOutputFile=-', pdf], { timeout: GS_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      console.error('pdfEmbeddedText failed', err.message);
      return '';
    }
  });
}

async function pdfPagesAsPng(buffer, maxPages = 2) {
  const prefix = path.join(os.tmpdir(), crypto.randomUUID());
  try {
    await withTempFile(buffer, '.pdf', (pdf) => execFileAsync(
      'gs', ['-sDEVICE=png16m', '-r150', `-dLastPage=${maxPages}`, '-dNOPAUSE', '-dQUIET', '-dBATCH', `-sOutputFile=${prefix}-%d.png`, pdf], { timeout: GS_TIMEOUT_MS }
    ));
    const pages = [];
    for (let i = 1; i <= maxPages; i++) {
      const png = await fs.promises.readFile(`${prefix}-${i}.png`).catch(() => null);
      if (png) pages.push(png);
    }
    return pages;
  } catch (err) {
    console.error('pdfPagesAsPng failed', err.message);
    return [];
  } finally {
    for (let i = 1; i <= maxPages; i++) await fs.promises.unlink(`${prefix}-${i}.png`).catch(() => {});
  }
}

// Texto de una imagen o de un PDF (texto incrustado primero; si no hay, OCR de sus primeras páginas).
export async function extractDocumentText(buffer, mimeType, recognize = extractText) {
  if (mimeType !== 'application/pdf') return recognize(buffer);
  const embedded = (await pdfEmbeddedText(buffer)).trim();
  if (embedded.replace(/\s+/g, '').length >= MIN_EMBEDDED_TEXT) return embedded;
  let text = embedded;
  for (const png of await pdfPagesAsPng(buffer)) text += `\n${await recognize(png)}`;
  return text;
}

// Un solo lector Tesseract reutilizado: cargar el modelo en español por imagen (lo que hace
// extractText) sería lo que más tarde en un recorrido de miles de adjuntos.
export async function createOcrSession() {
  const make = () => createWorker('spa', 1, { cachePath: UPLOAD_DIR, errorHandler: tesseractErrorHandler });
  let worker = await make();
  return {
    // Una imagen que cuelga al lector no puede frenar todo el recorrido: pasado el tiempo se reinicia el lector y se salta.
    recognize: async (buffer) => {
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OCR timeout')), RECOGNIZE_TIMEOUT_MS); });
        return (await Promise.race([worker.recognize(buffer), timeout])).data.text;
      } catch (err) {
        if (err.message === 'OCR timeout') { await worker.terminate().catch(() => {}); worker = await make(); }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => worker.terminate(),
  };
}
