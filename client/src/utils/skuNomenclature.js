/**
 * The house SKU format, for suggesting one in the browser.
 *
 *   <2-digit vintage>-<wine name>    e.g. 23-papas-malbec, 24-into-the-mystic
 *   -gls  glass pour     -w  wholesale
 *
 * The server applies the same rule when a variant is saved with no SKU, and it
 * is the authority -- this exists so the field is filled in front of you rather
 * than appearing out of nowhere after a save. Keep the two in step; the server
 * copy is server/lib/skuNomenclature.js.
 */

export function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // rivière -> riviere
    .replace(/['’]/g, '')                             // Papa's -> Papas
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A 5oz variant is a glass pour; everything else is a bottle. */
export function isGlassVolume(volumeFormat) {
  return /^\s*5\s*oz\s*$/i.test(String(volumeFormat || ''));
}

export function skuBase({ sku, vintage, name } = {}) {
  if (sku && String(sku).trim()) return slugify(sku);

  const bare = String(name || '').replace(/^\s*(?:19|20)?\d{2}\s+/, '');
  // The name's year beats the vintage column: the two disagree on a number of
  // wines and the shipped SKUs follow the name.
  const fromName = (String(name || '').match(/^\s*(?:19|20)?(\d{2})\s+/) || [])[1];
  const yr = fromName
    || (vintage != null && String(vintage).trim() !== '' ? String(vintage).trim().slice(-2) : '');

  return [yr, slugify(bare) || slugify(name)].filter(Boolean).join('-');
}

export function defaultVariantSku(product, variant) {
  const base = skuBase(product);
  if (!base) return '';
  return base + (isGlassVolume(variant?.volume_format) ? '-gls' : '');
}
