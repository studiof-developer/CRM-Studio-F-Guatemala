import fs from 'fs';
import path from 'path';
import { pool } from './db.js';

// Same volume the product-images-sftp container writes into (see docker-compose.prod.yml)
// — this container only ever reads it.
export const PRODUCT_IMAGES_DIR = process.env.PRODUCT_IMAGES_DIR || '/app/product-images';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Confirmed 2026-08-31: the SKU is embedded in the filename itself, not a separate
// mapping file — so "starts with the SKU" is the match, not an exact-name match, to
// tolerate whatever the ERP's export naming adds after it (a suffix, a extra angle
// number, etc.). Longest-SKU-first so a SKU that happens to be a prefix of a longer one
// (e.g. "1234" vs "12345") can't steal a file that actually belongs to the longer SKU.
export async function syncProductImages() {
  let files;
  try {
    files = await fs.promises.readdir(PRODUCT_IMAGES_DIR);
  } catch (err) {
    // Folder not mounted (local dev without the sftp service) — nothing to sync, not an error.
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const images = files.filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()));
  if (!images.length) return;

  const { rows: products } = await pool.query(`SELECT id, sku, image_url FROM products`);
  const bySkuLength = products.slice().sort((a, b) => b.sku.length - a.sku.length);

  let updated = 0;
  for (const file of images) {
    const base = path.parse(file).name.toLowerCase();
    const match = bySkuLength.find((p) => base.startsWith(p.sku.toLowerCase()));
    if (!match) continue;
    const url = `/api/products/images/${encodeURIComponent(file)}`;
    if (match.image_url === url) continue;
    await pool.query(`UPDATE products SET image_url = $1 WHERE id = $2`, [url, match.id]);
    updated++;
  }
  if (updated) console.log(`Product images: ${updated} producto(s) enlazados a una foto`);
}
