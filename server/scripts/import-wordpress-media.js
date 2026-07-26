/**
 * CLI wrapper around lib/importWordpressMedia.js. Normally you'd use the
 * "Import from WordPress" button in Team → Marketing → Website Media instead;
 * this is here for one-off/manual runs.
 *
 * Run (from server/):  node scripts/import-wordpress-media.js
 * Env: WP_IMPORT_BASE (default https://kindredvineyards.com), KINDRED_COMPANY_ID, DRY_RUN=1
 */
import { importWordpressMedia } from '../lib/importWordpressMedia.js';

const dryRun = process.env.DRY_RUN === '1';

console.log(`Importing images${dryRun ? ' (DRY RUN)' : ''}…\n`);

importWordpressMedia({
  dryRun,
  companyId: process.env.KINDRED_COMPANY_ID || null,
  onProgress: (r) => process.stdout.write(`\r  imported ${r.imported} · skip-AI ${r.skippedAI} · review ${r.needsReview} · have ${r.alreadyHave} · failed ${r.failed}   `),
})
  .then((report) => {
    console.log('\n\n=== Import summary ===');
    console.table(report);
    console.log('\nReview the "needs-review" folder in Team → Marketing → Website Media.');
    process.exit(0);
  })
  .catch((e) => { console.error('\nImport failed:', e); process.exit(1); });
