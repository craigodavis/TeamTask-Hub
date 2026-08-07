/**
 * Render a tasting-room menu booklet to PDF.
 *
 * Ports the kit's build.py: splice generated wine rows into the template
 * between its HTML comment markers, then print with headless Chromium. The
 * template is otherwise left exactly as designed — only the wine tables are
 * data-driven, and the food, cocktails, club and cover content stays hand-authored
 * in menu.html where it belongs.
 *
 * Playwright rather than the kit's chrome subprocess, because TeamHub already
 * runs Playwright for the Amazon, Sysco and ABC-portal work.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MENU_ROOT = path.join(HERE, '..', 'assets', 'menus');

/** Club 77 is exactly this much off list, glasses and bottles alike. */
const CLUB_DISCOUNT = 0.15;

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Whole dollars print bare, fractions to the cent — the kit's rule. An absent
 * glass price prints an en dash, which is how a bottle-only wine reads.
 */
function money(n) {
  if (n === null || n === undefined) return '&ndash;';
  const v = Number(n);
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

const club = (n) => (n === null || n === undefined ? null
  : Math.round(Number(n) * (1 - CLUB_DISCOUNT) * 100) / 100);

function rows(wines) {
  return wines.map((w) => {
    const vintage = w.vintage ? `${String(w.vintage).slice(-2)} ` : '';
    return '<tr><td class="w"><span class="wv">' + esc(vintage) + '</span>'
      + '<span class="wn">' + esc(w.name) + '</span><br>'
      + '<span class="wtype">' + esc(w.varietal) + '</span></td>'
      + `<td class="p">${money(w.glass)}</td><td class="p">${money(club(w.glass))}</td><td></td>`
      + `<td class="p">${money(w.bottle)}</td><td class="p">${money(club(w.bottle))}</td></tr>`;
  }).join('\n');
}

function splice(doc, tag, body) {
  const start = `<!-- ${tag}:START -->`;
  const end = `<!-- ${tag}:END -->`;
  const i = doc.indexOf(start);
  const j = doc.indexOf(end);
  if (i === -1 || j === -1) throw new Error(`Template is missing the ${tag} markers.`);
  return doc.slice(0, i + start.length) + '\n' + body + '\n      ' + doc.slice(j);
}

/**
 * @param {string} menuKey  'creek' | 'winery'
 * @param {{white: object[], red: object[]}} wines  in print order
 * @returns {Promise<Buffer>} the PDF
 */
export async function renderMenuPdf(menuKey, wines) {
  const dir = path.join(MENU_ROOT, menuKey);
  const templatePath = path.join(dir, 'menu.html');

  try {
    await fs.access(templatePath);
  } catch {
    // Each menu is its own booklet — the Winery is not the Creek menu with
    // different wines — so there is nothing sensible to fall back to.
    const err = new Error(
      `No print template installed for "${menuKey}". Its booklet artwork and `
      + `content need to be added at server/assets/menus/${menuKey}/menu.html.`);
    err.status = 422;
    throw err;
  }

  let doc = await fs.readFile(templatePath, 'utf8');
  doc = splice(doc, 'WINES_WHITE', rows(wines.white || []));
  doc = splice(doc, 'WINES_RED', rows(wines.red || []));

  // Render from a temp file inside the menu directory so the template's
  // relative font and image paths still resolve.
  const tmp = path.join(dir, `.render-${Date.now()}.html`);
  await fs.writeFile(tmp, doc, 'utf8');

  const browser = await chromium.launch({
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(pathToFileURL(tmp).toString(), { waitUntil: 'networkidle' });
    // Landscape letter with zero margin, per the template's @page rule. The
    // sheets are booklet-imposed, so page order is not reading order.
    return await page.pdf({
      width: '11in', height: '8.5in', printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await browser.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
  }
}
