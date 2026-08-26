import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const execFileAsync = promisify(execFile);
// A hung/malformed PDF must not tie up the process indefinitely — this is a background
// storage optimization, never worth blocking anything else on.
const GS_TIMEOUT_MS = 60_000;
// Most of the multi-MB PDFs seen in production are a single phone-camera photo of a
// receipt/guía wrapped in a PDF container by a phone's "scan" feature, at full camera
// resolution — Ghostscript's /ebook preset downsamples embedded images to ~150dpi,
// still clearly legible for a receipt or label, without touching real vector text.
const GS_ARGS = ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4', '-dPDFSETTINGS=/ebook', '-dNOPAUSE', '-dQUIET', '-dBATCH'];
const MIN_SIZE_TO_COMPRESS = 300 * 1024;

export async function compressPdfBuffer(buffer) {
  if (buffer.length < MIN_SIZE_TO_COMPRESS) return null;
  const id = crypto.randomUUID();
  const inPath = path.join(os.tmpdir(), `${id}-in.pdf`);
  const outPath = path.join(os.tmpdir(), `${id}-out.pdf`);
  try {
    await fs.promises.writeFile(inPath, buffer);
    await execFileAsync('gs', [...GS_ARGS, `-sOutputFile=${outPath}`, inPath], { timeout: GS_TIMEOUT_MS });
    const out = await fs.promises.readFile(outPath);
    return out.length < buffer.length ? out : null;
  } catch (err) {
    console.error('compressPdfBuffer failed', err);
    return null;
  } finally {
    await fs.promises.unlink(inPath).catch(() => {});
    await fs.promises.unlink(outPath).catch(() => {});
  }
}
