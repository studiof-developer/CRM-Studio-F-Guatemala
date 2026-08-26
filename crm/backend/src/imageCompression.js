import sharp from 'sharp';

// 1600px keeps a photo clearly identifiable (product detail, a screenshot's text) while
// cutting the multi-MB originals phone cameras produce down to a few hundred KB. Quality
// 78 is the point where JPEG artifacts start being visible on close inspection but not at
// a normal viewing size — well above "al pelo".
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 78;
// Below this, recompressing risks making the file bigger (JPEG overhead) for no real
// storage win — not worth the CPU or the (tiny) risk of touching the file at all.
const MIN_SIZE_TO_COMPRESS = 200 * 1024;

export async function compressImageBuffer(buffer) {
  if (buffer.length < MIN_SIZE_TO_COMPRESS) return null;
  const out = await sharp(buffer)
    .rotate() // bakes in the EXIF orientation before it's stripped below
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return out.length < buffer.length ? out : null;
}
