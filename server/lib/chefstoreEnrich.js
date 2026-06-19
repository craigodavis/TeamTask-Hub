/**
 * chefstoreEnrich — Chef Store (US Foods CHEF'STORE) catalog enrichment.
 *
 * Chef Store's site runs on Algolia search with a public, search-only API key
 * embedded in its web client. We query that index directly by item number to
 * pull clean product data (name, size/UOM, pack, category) — no login required.
 *
 * Credentials were lifted from the public shop client; Algolia search-only keys
 * are designed to be exposed. Store 503 is Kindred's location (pricing is
 * store-keyed, but name/size/pack are consistent across stores).
 */

const ALGOLIA_APP_ID  = '70KQ5FEQ31';
const ALGOLIA_API_KEY = '48035a5322b28e6485ae9f3b235b150a';
const ALGOLIA_INDEX   = 'prod_centralia_products';
const STORE_NUM       = '503';

const ENDPOINT = `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}/query`;

/** Pull a store-keyed value (Algolia stores these as { "503": "...", ... }). */
function storeVal(field) {
  if (field == null) return null;
  if (typeof field === 'object') return field[STORE_NUM] ?? null;
  return field;
}

/**
 * Normalize one Algolia hit into our enrichment shape.
 */
function parseHit(hit) {
  if (!hit) return null;
  const itemSize = storeVal(hit.itemSize);   // e.g. "3 LBA"
  const pack     = storeVal(hit.pack);        // e.g. "2"
  const name = [hit.itemDesc1, hit.itemDesc2].filter(Boolean).join(' ').trim() || null;
  return {
    productId: hit.usfitem || hit.objectID || null,
    name,
    description: name,
    brand: null,
    category: hit.category || hit.department || null,
    pack: pack != null ? String(pack) : null,
    size: itemSize || null,
    uom: itemSize || null,                     // Chef Store's itemSize is the container UOM
    upc: Array.isArray(hit.upc) ? hit.upc[0] : (hit.upc || null),
  };
}

/**
 * Look up one Chef Store item number via Algolia.
 * @returns {parsed|null}
 */
export async function lookupChefstoreItem(itemNumber) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'X-Algolia-API-Key': ALGOLIA_API_KEY,
      'X-Algolia-Application-Id': ALGOLIA_APP_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: String(itemNumber), hitsPerPage: 5 }),
  });
  if (!res.ok) throw new Error(`Algolia HTTP ${res.status}`);
  const data = await res.json();
  const hits = data.hits || [];
  // Prefer an exact item-number match; fall back to the first hit
  const hit = hits.find((h) => String(h.usfitem) === String(itemNumber)) || hits[0];
  return parseHit(hit);
}

/**
 * Batch-enrich Chef Store item numbers. Algolia is fast and stateless, so we
 * just run them with light concurrency.
 *
 * @param {string[]} itemNumbers
 * @returns {{ results: [{ itemNumber, parsed|null, error? }] }}
 */
export async function enrichChefstoreItems(itemNumbers) {
  const results = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < itemNumbers.length; i += CONCURRENCY) {
    const batch = itemNumbers.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map(async (itemNumber) => {
      try {
        const parsed = await lookupChefstoreItem(itemNumber);
        return { itemNumber, parsed };
      } catch (err) {
        return { itemNumber, error: err.message };
      }
    }));
    results.push(...settled);
  }
  return { results };
}
