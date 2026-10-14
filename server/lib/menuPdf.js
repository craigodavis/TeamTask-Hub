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

/**
 * Sheet size per menu. The booklets print landscape letter and are folded and
 * stapled; the tasting flight is a single booklet panel — half that sheet — so
 * it slips into the finished book.
 */
const PAGE_SIZE = {
  tasting: { width: '5.5in', height: '8.5in' },
  burgers: { width: '5.5in', height: '8.5in' },
  _default: { width: '11in', height: '8.5in' },
};

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

/**
 * Split "23 Papa's" into its year and the rest.
 *
 * Every vintaged product's name already begins with its year — all 68 of them,
 * no exceptions — so prefixing the `vintage` column on top of the name printed
 * the year twice ("23 23 Papa's"). The year in the name is also the one to
 * trust: 14 products have a `vintage` column that disagrees with their own
 * name, and the name is what the wine is actually called.
 *
 * Two digits are expanded to four to match how the menu is typeset. The
 * column is only a fallback for a name with no year in it.
 */
function splitVintage(name, vintageCol) {
  const m = String(name || '').match(/^((?:19|20)?\d{2})\s+(.*)$/);
  if (!m) {
    return { vint: vintageCol ? String(vintageCol) : '', rest: name || '' };
  }
  const [, year, rest] = m;
  return { vint: year.length === 4 ? year : `20${year}`, rest };
}

function rows(wines) {
  return wines.map((w) => {
    // Matches the hand-written rows in menu.html exactly: .vint / .wname /
    // .wtype. The generated rows previously used .wv and .wn, which appear
    // nowhere in the stylesheet, so every wine the app added printed unstyled
    // next to the ones typed into the template.
    const { vint, rest } = splitVintage(w.name, w.vintage);
    return '<tr><td class="w">'
      + (vint ? '<span class="vint">' + esc(vint) + '</span> ' : '')
      + '<span class="wname">' + esc(rest) + '</span>'
      + '<span class="wtype">' + esc(w.varietal) + '</span></td>'
      + `<td class="p">${money(w.glass)}</td><td class="p">${money(club(w.glass))}</td><td></td>`
      + `<td class="p">${money(w.bottle)}</td><td class="p">${money(club(w.bottle))}</td></tr>`;
  }).join('\n');
}

/**
 * Render one food/drink item the way the booklet hand-writes them.
 *
 * `first` carries the tighter gap that sits an item under its section header.
 * That spacing belongs to the SLOT, not the item — when the featured burger
 * was swapped the margin had to move with the position, not travel with the
 * burger — so it is derived here rather than stored per row.
 */
function foodItem(it, first) {
  const style = first && it.firstMargin ? ` style="margin-top:${it.firstMargin}"` : '';
  const price = it.price_cents === null || it.price_cents === undefined
    ? '' : `<span class="price">${money(Number(it.price_cents) / 100)}</span>`;
  let html = `    <div class="item"${style}><div class="name">${esc(it.name)}${price}</div>`;
  // A newline inside the description is a line break within the same
  // paragraph — the booklet uses one for "Prosecco and juice of your choice:"
  // above its list, and again for the Whiskey Sour's float. Storing the break
  // as a newline keeps the text readable and searchable in the database.
  if (it.description) {
    html += `\n      <div class="desc">${esc(it.description).replace(/\n/g, '<br>')}</div>`;
  }
  // `serves` and `note` are their own lines with their own type, not trailing
  // text — folding them into the description silently restyles them.
  if (it.serves) html += `\n      <div class="serves">${esc(it.serves)}</div>`;
  if (it.note)   html += `\n      <div class="comes">${esc(it.note)}</div>`;
  html += '</div>';
  return html;
}

/**
 * Fill every <!-- FOOD:Section Name:START --> block with that section's items.
 *
 * One marker per section rather than one per menu, because Creek's sections
 * live on different panels of a booklet — the wine list, the kitchen page and
 * the desserts are pages apart, and the template decides where each sits.
 */
export function spliceFood(doc, items) {
  const bySection = new Map();
  for (const it of items) {
    if (!bySection.has(it.section)) bySection.set(it.section, []);
    bySection.get(it.section).push(it);
  }
  for (const [section, list] of bySection) {
    const start = `<!-- FOOD:${section}:START -->`;
    const end = `<!-- FOOD:${section}:END -->`;
    const i = doc.indexOf(start);
    const j = doc.indexOf(end);
    if (i === -1 || j === -1) continue;   // template does not print this section
    const body = list.map((it, n) => foodItem(it, n === 0)).join('\n\n');
    doc = doc.slice(0, i + start.length) + '\n' + body + '\n    ' + doc.slice(j);
  }
  return doc;
}

function splice(doc, tag, body) {
  const start = `<!-- ${tag}:START -->`;
  const end = `<!-- ${tag}:END -->`;
  const i = doc.indexOf(start);
  const j = doc.indexOf(end);
  // A menu with no wine tables is legitimate — the food menus are entirely
  // hand-authored — so absent markers mean "nothing to fill", not an error.
  if (i === -1 || j === -1) return doc;
  return doc.slice(0, i + start.length) + '\n' + body + '\n      ' + doc.slice(j);
}

/**
 * @param {string} menuKey  'creek' | 'winery'
 * @param {{white: object[], red: object[]}} wines  in print order
 * @returns {Promise<Buffer>} the PDF
 */

/**
 * Shrink a panel's content until it clears the furniture at the foot of the page.
 *
 * Panels are a fixed 5.5 x 8.5in with the sheet set to overflow:hidden, and the
 * ornament and the allergy footnote are absolutely positioned at the bottom. So a
 * panel that gains an item does not grow or push anything down — its content runs
 * straight through the logo and then off the page. Adding two cocktails did exactly
 * that.
 *
 * The flowing children are wrapped and zoomed down until their bottom edge clears
 * the highest piece of furniture. zoom rather than font-size because the template
 * sets its spacing in points — .item { margin-top: 13pt } — so scaling type alone
 * would leave the gaps at full size and barely help.
 *
 * Binary search over the scale, because each try costs a layout pass and stepping
 * down in small increments can take forty of them. Never scales up: a half-empty
 * panel is a design decision, not a gap to fill.
 */
async function fitPanels(page) {
  return page.evaluate(() => {
    const CLEAR = 10;          // px of air to leave above the furniture
    const FLOOR_SCALE = 0.55;  // below this it is unreadable; better to let it spill
    const out = [];

    for (const panel of document.querySelectorAll('.panel')) {
      const flow = [...panel.children]
        .filter((el) => getComputedStyle(el).position === 'static');
      if (!flow.length) continue;

      const wrap = document.createElement('div');
      panel.insertBefore(wrap, flow[0]);
      for (const el of flow) wrap.appendChild(el);

      const pr = panel.getBoundingClientRect();
      let floor = pr.bottom - parseFloat(getComputedStyle(panel).paddingBottom || '0');
      for (const f of panel.querySelectorAll('.orn, .footnote')) {
        const r = f.getBoundingClientRect();
        if (r.height > 0) floor = Math.min(floor, r.top - CLEAR);
      }

      const fits = (z) => {
        wrap.style.zoom = String(z);
        return wrap.getBoundingClientRect().bottom <= floor;
      };

      if (fits(1)) { wrap.style.zoom = ''; continue; }

      let lo = FLOOR_SCALE, hi = 1;
      for (let i = 0; i < 16; i += 1) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid; else hi = mid;
      }
      const ok = fits(lo);
      out.push({
        section: panel.querySelector('.sec-head')?.textContent.trim().slice(0, 40) || '(untitled)',
        scale: Math.round(lo * 1000) / 1000,
        cleared: ok,
      });
    }
    return out;
  });
}

export async function renderMenuPdf(menuKey, wines, foodItems = []) {
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
  doc = spliceFood(doc, foodItems);

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
    await fitPanels(page);
    // Landscape letter with zero margin, per the template's @page rule. The
    // sheets are booklet-imposed, so page order is not reading order.
    const size = PAGE_SIZE[menuKey] || PAGE_SIZE._default;
    return await page.pdf({
      width: size.width, height: size.height, printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await browser.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
  }
}
