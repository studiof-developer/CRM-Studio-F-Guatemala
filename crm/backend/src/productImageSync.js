import fs from 'fs';
import path from 'path';
import { pool } from './db.js';

// Same volume the product-images-sftp container writes into (see docker-compose.prod.yml)
// — this container only ever reads it.
export const PRODUCT_IMAGES_DIR = process.env.PRODUCT_IMAGES_DIR || '/app/product-images';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export async function listImageFiles() {
  try {
    const files = await fs.promises.readdir(PRODUCT_IMAGES_DIR);
    return files.filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Error reading PRODUCT_IMAGES_DIR:', err);
    return [];
  }
}

/**
 * Calcula un puntaje de similitud (0 a 100+) entre el nombre de un archivo de imagen
 * y la referencia/SKU/color de una prenda de Studio F.
 */
export function scoreImageMatch(filename, { reference, sku, barcode, color, name } = {}) {
  const baseRaw = path.parse(filename).name;
  const base = baseRaw.toLowerCase();
  const baseAlpha = base.replace(/[^a-z0-9]/gi, '');

  let score = 0;

  // 1. Coincidencia con Referencia de estilo (ej. S740866, S176012A) - PRIORIDAD MÁXIMA
  const ref = reference ? String(reference).trim().toLowerCase() : null;
  if (ref && ref.length >= 3) {
    const refAlpha = ref.replace(/[^a-z0-9]/gi, '');

    if (baseAlpha === refAlpha) {
      score = Math.max(score, 100);
    } else if (base.startsWith(ref + '_') || base.startsWith(ref + '-') || base.startsWith(ref + ' ')) {
      score = Math.max(score, 95);
    } else if (baseAlpha.startsWith(refAlpha)) {
      const diff = Math.min(15, baseAlpha.length - refAlpha.length);
      score = Math.max(score, 90 - diff);
    } else if (base.includes(ref) || baseAlpha.includes(refAlpha)) {
      score = Math.max(score, 75);
    }
  }

  // 2. Coincidencia con Barcode o SKU (ej. 7703617657065)
  for (const code of [barcode, sku]) {
    if (code && String(code).length >= 5) {
      const cStr = String(code).trim().toLowerCase();
      const cAlpha = cStr.replace(/[^a-z0-9]/gi, '');
      if (baseAlpha === cAlpha) {
        score = Math.max(score, 85);
      } else if (baseAlpha.startsWith(cAlpha)) {
        score = Math.max(score, 80);
      } else if (baseAlpha.includes(cAlpha)) {
        score = Math.max(score, 65);
      }
    }
  }

  // 3. Bonus si el color coincide con parte del nombre del archivo (ej. S740866-ROSAPETA)
  if (score >= 60 && color) {
    const colorNorm = String(color).trim().toLowerCase().replace(/[^a-z0-9]/gi, '');
    if (colorNorm.length >= 3 && baseAlpha.includes(colorNorm)) {
      score += 15;
    }
  }

  return score;
}

/**
 * Busca la imagen más similar para una referencia/color dada entre todos los archivos SFTP.
 */
export async function findBestImageMatch({ reference, sku, barcode, color, name } = {}) {
  const files = await listImageFiles();
  if (!files.length) return null;

  let bestFile = null;
  let highestScore = 0;

  for (const f of files) {
    const s = scoreImageMatch(f, { reference, sku, barcode, color, name });
    if (s > highestScore) {
      highestScore = s;
      bestFile = f;
    }
  }

  if (bestFile && highestScore >= 65) {
    return {
      filename: bestFile,
      score: highestScore,
      url: `/api/products/images/${encodeURIComponent(bestFile)}`,
    };
  }

  return null;
}

export async function syncProductImages() {
  const images = await listImageFiles();
  if (!images.length) return;

  // Consulta los productos, incluyendo su referencia, barcode y color
  const { rows: products } = await pool.query(
    `SELECT id, sku, reference, barcode, color, name, image_url FROM products`
  );

  let updated = 0;
  for (const p of products) {
    let bestFile = null;
    let maxScore = 0;

    for (const file of images) {
      const s = scoreImageMatch(file, p);
      if (s > maxScore) {
        maxScore = s;
        bestFile = file;
      }
    }

    if (bestFile && maxScore >= 65) {
      const url = `/api/products/images/${encodeURIComponent(bestFile)}`;
      if (p.image_url !== url) {
        await pool.query(`UPDATE products SET image_url = $1 WHERE id = $2`, [url, p.id]);
        updated++;
      }
    }
  }

  if (updated) console.log(`Product images: ${updated} producto(s) enlazados a una foto`);
}
