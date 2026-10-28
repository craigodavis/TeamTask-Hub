/**
 * Read-only audit: can every upcoming event survive the duration editor?
 *
 * The property being checked is a lossless round-trip. Take each event's stored
 * start and end, derive the duration the form would show, feed it back through
 * the form's own addMinutes(), and require the result to equal the stored end
 * exactly. If it does not, opening that event and saving it without touching
 * anything would move it.
 *
 * That is not hypothetical here. This code has already shipped two silent time
 * bugs — every edit shifting events 6 hours earlier, and "70s & 80s Night"
 * vanishing from the website because its end was left a month behind. Both were
 * an editor writing a field nobody looked at. This is the check that would have
 * caught them.
 *
 * It imports lib/eventTime.js, the same module the form imports, deliberately:
 * a reimplementation here would only prove the copy agrees with itself.
 *
 * Past events are out of scope — they are not worth fixing and nobody edits them.
 *
 * Writes nothing. Safe against production.
 *   DB_HOST=localhost node scripts/audit-event-durations.js [--json] [--all]
 */
import { query } from '../db.js';
import {
  addMinutes, minutesBetween, hasExactOption, durLabel, DURATIONS,
} from '../../client/src/lib/eventTime.js';

const JSON_OUT = process.argv.includes('--json');
const ALL = process.argv.includes('--all'); // include past events too

// The form's inputs are naive 'YYYY-MM-DDTHH:mm' wall-clock strings, and the
// column is wall-clock labelled UTC. Format in UTC to get back what was typed;
// going through the local zone is precisely the 6-hour bug.
const toInput = (d) => (d ? new Date(d).toISOString().slice(0, 16) : '');

async function run() {
  const rows = (await query(
    `SELECT id, title, status, start_at, end_at
       FROM events
      WHERE ${ALL ? 'TRUE' : '(start_at >= NOW() OR end_at >= NOW())'}
      ORDER BY start_at`)).rows;

  const problems = [];
  const coverage = [];
  let clean = 0;

  for (const e of rows) {
    const start = toInput(e.start_at);
    const end = toInput(e.end_at);
    const label = `${start || '(no start)'}  ${e.title}`;

    if (!start) { problems.push({ kind: 'no_start', label, detail: 'start_at is NULL' }); continue; }
    if (!end) { problems.push({ kind: 'no_end', label, detail: 'end_at is NULL — the editor would have to invent a duration' }); continue; }

    const mins = minutesBetween(start, end);
    if (mins === null) {
      problems.push({ kind: 'bad_pair', label, detail: `end (${end}) is not after start (${start})` });
      continue;
    }

    // The round trip: duration back through the form's own arithmetic.
    const rebuilt = addMinutes(start, mins);
    if (rebuilt !== end) {
      problems.push({ kind: 'lossy', label, detail: `round-trip gives ${rebuilt}, stored is ${end}` });
      continue;
    }

    // Survives the arithmetic, but can the dropdown represent it? If not, the
    // select falls back and a later save silently rewrites the length.
    if (!hasExactOption(mins)) {
      coverage.push({ label, mins, detail: `${durLabel(mins)} has no option` });
      continue;
    }
    clean++;
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ scope: ALL ? 'all' : 'upcoming', total: rows.length, clean, problems, coverage }, null, 2));
    process.exit(problems.length || coverage.length ? 1 : 0);
  }

  console.log(`\nEvent duration audit — ${ALL ? 'ALL events' : 'upcoming only'}`);
  console.log(`${rows.length} event(s) examined\n`);

  console.log(`  ✓ ${clean} round-trip exactly and have a matching duration option`);

  if (coverage.length) {
    console.log(`\n  ⚠ ${coverage.length} with no matching dropdown option:`);
    for (const c of coverage) console.log(`      ${c.label}\n        ${c.detail}`);
    console.log(`\n    These are the silent-rewrite risk: the select cannot show the`);
    console.log(`    current value, so saving anything else on the page changes the length.`);
    const missing = [...new Set(coverage.map((c) => c.mins))].sort((a, b) => a - b);
    console.log(`    Add to DURATIONS: ${missing.join(', ')}  (${missing.map(durLabel).join(', ')})`);
  }

  if (problems.length) {
    console.log(`\n  ✗ ${problems.length} that the editor cannot represent at all:`);
    for (const p of problems) console.log(`      [${p.kind}] ${p.label}\n        ${p.detail}`);
  }

  if (!coverage.length && !problems.length) {
    console.log('\n  Everything upcoming survives the duration editor untouched.');
  }
  console.log(`\n  (duration options: ${DURATIONS.map((d) => d.value).join(', ')})\n`);
  process.exit(problems.length || coverage.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(2); });
