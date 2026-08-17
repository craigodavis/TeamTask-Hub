/**
 * The house SKU format, in one place.
 *
 *   <2-digit vintage>-<wine name>    e.g. 23-papas-malbec, 24-into-the-mystic
 *
 * All lowercase, hyphens only -- no underscores, apostrophes or accents. The
 * older catalogue is a museum of everything that happens without a rule
 * (`2020Papas`, `18ORPinotNoir`, `22_papas_malbec`, `23-into-the-mystic-estate-
 * pinot-noir-duplicate`), and matching TeamHub to Square and Commerce7 is done
 * on SKU, so a typo here is a product that silently fails to line up.
 *
 * Suffixes:
 *   -gls   glass pour
 *   -w     wholesale
 *
 * This only ever supplies a DEFAULT. A SKU that is already set is left alone,
 * including the historical ones -- renaming a live SKU would orphan it from the
 * Square and Commerce7 rows that match on it.
 *
 * That is not hypothetical: `skuBase` used to slugify an already-set SKU, which
 * lowercased the 2023 and 2025 vintages and orphaned 347 Commerce7 club package
 * items from products that still existed. Members were refused at pickup.
 * Commerce7 caches the SKU string on a package item and never refreshes it, so
 * ANY rename of a live SKU breaks every package already built on it. Square is
 * unaffected -- squareCatalogPush matches case-insensitively -- but Commerce7
 * does not.
 */

/** Lowercase, unaccented, hyphenated. Apostrophes vanish (Papa's -> papas). */
export function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // rivière -> riviere
    .replace(/['’]/g, '')                        // Papa's -> Papas
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The product-level stem every variant SKU is built on.
 *
 * `products.sku` wins when it is set: it is the value a person chose, and it
 * carries distinctions the name alone does not (the oaked Viognier is
 * `25-a-souvenir-fo`, not `25-a-souvenir`). Only when it is empty do we derive
 * one from the vintage and name.
 */
export function skuBase({ sku, vintage, name } = {}) {
  // An existing SKU is returned VERBATIM — never slugified.
  //
  // Slugifying here is what broke the September 2026 pickups: it silently
  // lowercased live SKUs (`23-Peacemaker` -> `23-peacemaker`), and Commerce7
  // snapshots the SKU *string* onto club_package_item when a package is built
  // and never refreshes it. 347 package items were orphaned from products that
  // still existed, and members were turned away at pickup with
  // "Sku: 23-Peacemaker. Item not found."
  //
  // This is exactly what the header of this file warns against. Slugify only
  // when DERIVING a new SKU below; a value someone already chose is left alone,
  // whatever its case.
  if (sku && String(sku).trim()) return String(sku).trim();

  // Names already start with the vintage ("24 Into the Mystic", "23 11 Sails"),
  // so strip that token before slugifying or it comes out doubled. Anchored to
  // the front and followed by a space, so "23 11 Sails" keeps its 11.
  const bare = String(name || '').replace(/^\s*(?:19|20)?\d{2}\s+/, '');

  // The name's leading vintage wins over the `vintage` column, because the
  // shipped SKUs follow the name and the two disagree on a fair number of rows:
  // "23 Cerceau Rivière" has vintage 2022 but ships as `23-cerceau-riviere`,
  // and "25 Love Letter" has vintage 2024 but ships as `25-love-letter`. The
  // column is the fallback for a product whose name carries no year.
  const fromName = (String(name || '').match(/^\s*(?:19|20)?(\d{2})\s+/) || [])[1];
  const yr = fromName
    || (vintage != null && String(vintage).trim() !== '' ? String(vintage).trim().slice(-2) : '');

  const stem = slugify(bare) || slugify(name);
  return [yr, stem].filter(Boolean).join('-');
}

/**
 * The SKU for one variant of a product.
 *
 * `isGlass` is derived from the volume rather than stored separately, because
 * a 5oz pour is the only thing a glass variant can be.
 */
export function variantSku({ base, isGlass = false, wholesale = false } = {}) {
  if (!base) return null;
  return base + (isGlass ? '-gls' : '') + (wholesale ? '-w' : '');
}

/** A 5oz variant is a glass pour; everything else is a bottle. */
export function isGlassVolume(volumeFormat) {
  return /^\s*5\s*oz\s*$/i.test(String(volumeFormat || ''));
}

/** Convenience: the default SKU for a variant of a given product. */
export function defaultVariantSku(product, variant) {
  return variantSku({
    base: skuBase(product),
    isGlass: isGlassVolume(variant?.volume_format),
    wholesale: Boolean(variant?.wholesale),
  });
}
