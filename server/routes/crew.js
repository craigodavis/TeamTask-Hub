/**
 * The Crew — staff profiles, for the public "meet the team" page.
 *
 * Open to everyone who can sign in, which is the point: this is the one screen
 * in Team where a member of staff maintains something about themselves rather
 * than being administered. So the split is by SUBJECT, not by role — anyone may
 * edit their own profile, only a manager may edit somebody else's or approve
 * anything for publication.
 *
 * Two gates before a profile is public, and they belong to different people:
 * the employee's consent (it's their face and their name) and a manager's
 * approval (it's the winery's front page). Neither alone is enough. The third
 * condition — still ACTIVE in Square — isn't stored anywhere; it's read live, so
 * leaving takes you off the site without anyone remembering to do it.
 *
 * Job titles come from Square, but 35 of 70 people there hold more than one, and
 * the values are rota roles ("Expo", "Prep", "Dishwasher") rather than anything
 * you'd introduce someone by. So each person chooses which of THEIR OWN Square
 * assignments to show. It's a pick list, never free text — the title stays
 * Square's to define.
 */
import express from 'express';
import multer from 'multer';
import path from 'path';
import { query } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { MEDIA_DIR, generateVariants, safeBase } from '../lib/mediaVariants.js';

export const crewRouter = express.Router();

const isManager = (req) => req.role === 'manager' || req.role === 'owner';

/** The Square team member id of whoever is making this request, if any. */
async function myTeamMemberId(req) {
  const r = await query(`SELECT square_team_member_id FROM users WHERE id = $1`, [req.userId]);
  return r.rows[0]?.square_team_member_id || null;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (_req, file, cb) =>
      cb(null, `crew-${safeBase(file.originalname)}-${Date.now()}${path.extname(file.originalname).toLowerCase() || '.jpg'}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Only image files are allowed')),
});

// Everything the screen needs about a person, in one shape. Left joins throughout
// because a profile is optional — the list is driven by Square, not by who has
// bothered to write a bio yet.
const CREW_SELECT = `
  SELECT t.id                AS square_team_member_id,
         t.given_name, t.family_name, t.status,
         p.id                AS profile_id,
         p.slug, p.nickname, p.bio, p.education, p.square_job_id,
         p.consent_at, p.approved_at, p.sort_order,
         m.id                AS media_id,
         m.url               AS photo_url,
         m.variants          AS photo_variants,
         j.job_title         AS job_title
    FROM team_square.team_member t
    LEFT JOIN kindred_web.crew_profile p ON p.square_team_member_id = t.id
    LEFT JOIN kindred_web.media m        ON m.id = p.media_id
    LEFT JOIN team_square.team_member_job_assignment j
           ON j.team_member_id = t.id AND j.job_id = p.square_job_id`;

/**
 * GET /api/crew — the directory. Everyone signed in can see it.
 * Active staff only by default; ?all=1 includes people who have left, which a
 * manager needs when tidying up but nobody else has a reason to see.
 */
crewRouter.get('/', async (req, res) => {
  try {
    const wantAll = req.query.all === '1' && isManager(req);
    const r = await query(
      `${CREW_SELECT}
        WHERE ${wantAll ? 'TRUE' : `t.status = 'ACTIVE'`}
        ORDER BY p.sort_order NULLS LAST, t.given_name, t.family_name`
    );
    const me = await myTeamMemberId(req);
    res.json({ me, canManage: isManager(req), crew: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/crew/me — my own profile, plus the Square job titles I'm allowed to
 * choose between. Returns 409 rather than 404 when the signed-in user has no
 * Square link at all: that's a fixable data problem, not a missing page.
 */
crewRouter.get('/me', async (req, res) => {
  try {
    const id = await myTeamMemberId(req);
    if (!id) {
      return res.status(409).json({
        error: 'Your Team login is not linked to a Square team member yet, so there is nothing to build a profile on. A manager can link it under Integrations.',
      });
    }
    const [prof, jobs] = await Promise.all([
      query(`${CREW_SELECT} WHERE t.id = $1`, [id]),
      query(
        `SELECT DISTINCT job_id, job_title
           FROM team_square.team_member_job_assignment
          WHERE team_member_id = $1
          ORDER BY job_title`, [id]),
    ]);
    res.json({ squareTeamMemberId: id, profile: prof.rows[0] || null, jobOptions: jobs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fields a person may set about themselves. Job title is not among them as free
// text — only square_job_id, and only one of their own assignments.
const EDITABLE = ['nickname', 'bio', 'education', 'square_job_id'];

async function saveProfile(squareId, body, userId) {
  const cols = EDITABLE.filter((k) => k in body);
  // Nothing to set would build "INSERT INTO … (square_team_member_id, ) VALUES ($1, )".
  if (!cols.length) return;
  if (body.square_job_id) {
    // Guard the pick list server-side: the UI offers only your own titles, but
    // the endpoint must not take somebody else's on trust.
    const ok = await query(
      `SELECT 1 FROM team_square.team_member_job_assignment WHERE team_member_id = $1 AND job_id = $2 LIMIT 1`,
      [squareId, body.square_job_id]
    );
    if (!ok.rowCount) throw Object.assign(new Error('That job title is not one of yours in Square.'), { status: 400 });
  }
  const setList = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const values = cols.map((c) => (body[c] === '' ? null : body[c]));
  await query(
    `INSERT INTO kindred_web.crew_profile (square_team_member_id, ${cols.join(', ')}, updated_by)
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, $${cols.length + 2})
     ON CONFLICT (square_team_member_id) DO UPDATE
       SET ${setList}, updated_at = NOW(), updated_by = $${cols.length + 2}`,
    [squareId, ...values, userId]
  );
}

/** PUT /api/crew/me — edit my own profile. */
crewRouter.put('/me', async (req, res) => {
  try {
    const id = await myTeamMemberId(req);
    if (!id) return res.status(409).json({ error: 'No Square team member linked to your login.' });
    await saveProfile(id, req.body || {}, req.userId);
    const r = await query(`${CREW_SELECT} WHERE t.id = $1`, [id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

/**
 * POST /api/crew/me/consent { consent: true|false } — appearing on the public
 * site is the employee's call, so this endpoint is theirs alone. Withdrawing
 * consent takes effect on the next site build; it does not need a manager.
 */
crewRouter.post('/me/consent', async (req, res) => {
  try {
    const id = await myTeamMemberId(req);
    if (!id) return res.status(409).json({ error: 'No Square team member linked to your login.' });
    const on = !!req.body?.consent;
    await query(
      `INSERT INTO kindred_web.crew_profile (square_team_member_id, consent_at, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (square_team_member_id) DO UPDATE
         SET consent_at = $2, updated_at = NOW(), updated_by = $3`,
      [id, on ? new Date() : null, req.userId]
    );
    res.json({ ok: true, consent: on });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/crew/me/photo (field: "file") — self-serve headshot.
 * The media library's own upload is manager-only, so this is a narrow door into
 * the same pipeline: same size and type limits, same responsive variants, but it
 * can only ever attach the result to the uploader's own profile.
 */
crewRouter.post('/me/photo', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const id = await myTeamMemberId(req);
    if (!id) return res.status(409).json({ error: 'No Square team member linked to your login.' });

    const { filename, originalname, mimetype, size } = req.file;
    const { original, variants, width, height } = await generateVariants(path.join(MEDIA_DIR, filename), filename);
    const who = await query(`SELECT given_name, family_name FROM team_square.team_member WHERE id = $1`, [id]);
    const name = [who.rows[0]?.given_name, who.rows[0]?.family_name].filter(Boolean).join(' ');

    const m = await query(
      `INSERT INTO kindred_web.media
         (filename, original_name, url, mime, width, height, size_bytes, alt_text, folder, variants, source, company_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'crew',$9,'upload',$10,$11)
       RETURNING id`,
      [filename, originalname, original.url, mimetype, width, height, size,
       name ? `${name}, Kindred Vineyards` : null, variants ? JSON.stringify(variants) : null,
       req.companyId, req.userId]
    );
    await query(
      `INSERT INTO kindred_web.crew_profile (square_team_member_id, media_id, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (square_team_member_id) DO UPDATE
         SET media_id = $2, updated_at = NOW(), updated_by = $3`,
      [id, m.rows[0].id, req.userId]
    );
    const r = await query(`${CREW_SELECT} WHERE t.id = $1`, [id]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** DELETE /api/crew/me/photo — drop my headshot (the media row itself is kept). */
crewRouter.delete('/me/photo', async (req, res) => {
  try {
    const id = await myTeamMemberId(req);
    if (!id) return res.status(409).json({ error: 'No Square team member linked to your login.' });
    await query(`UPDATE kindred_web.crew_profile SET media_id = NULL, updated_at = NOW(), updated_by = $2
                  WHERE square_team_member_id = $1`, [id, req.userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Manager only ────────────────────────────────────────────────────────────

/** PUT /api/crew/:squareId — edit anyone's copy. */
crewRouter.put('/:squareId', requireCapability('tasks.manage'), async (req, res) => {
  try {
    await saveProfile(req.params.squareId, req.body || {}, req.userId);
    const r = await query(`${CREW_SELECT} WHERE t.id = $1`, [req.params.squareId]);
    res.json(r.rows[0]);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

/**
 * Stable, unique, and assigned exactly once.
 *
 * First name, or the nickname if they use one. A clash takes the first initial
 * of the surname — and if that clashes too, a number, because two Sarah Bs is not
 * impossible. Frozen after the first approval: when a second Sarah arrives, the
 * first Sarah's URL must not silently change under everyone who linked to it.
 * The DISPLAYED name disambiguates on the fly; the address never moves.
 */
async function assignSlug(squareId) {
  const r = await query(
    `SELECT t.given_name, t.family_name, p.slug, p.nickname
       FROM team_square.team_member t
       LEFT JOIN kindred_web.crew_profile p ON p.square_team_member_id = t.id
      WHERE t.id = $1`, [squareId]);
  const row = r.rows[0];
  if (!row) throw Object.assign(new Error('No such team member.'), { status: 404 });
  if (row.slug) return row.slug; // already has one — never reassign

  // NFD then strip combining marks, so "José" slugs to "jose" rather than "jos".
  const clean = (s) => (s || '')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = clean(row.nickname) || clean(row.given_name) || 'crew';
  const initial = clean(row.family_name).slice(0, 1);
  for (const candidate of [base, initial ? `${base}-${initial}` : null, ...Array.from({ length: 20 }, (_, i) => `${base}-${i + 2}`)]) {
    if (!candidate) continue;
    const taken = await query(`SELECT 1 FROM kindred_web.crew_profile WHERE slug = $1`, [candidate]);
    if (!taken.rowCount) {
      await query(`UPDATE kindred_web.crew_profile SET slug = $2 WHERE square_team_member_id = $1`, [squareId, candidate]);
      return candidate;
    }
  }
  throw Object.assign(new Error('Could not find a free web address for this profile.'), { status: 409 });
}

/**
 * POST /api/crew/:squareId/approve { approved: true|false }
 * A manager clearing the copy for publication. Approval alone doesn't publish —
 * the person still has to have consented, and still has to be active in Square.
 */
crewRouter.post('/:squareId/approve', requireCapability('tasks.manage'), async (req, res) => {
  try {
    const on = req.body?.approved !== false;
    const exists = await query(`SELECT 1 FROM kindred_web.crew_profile WHERE square_team_member_id = $1`, [req.params.squareId]);
    if (!exists.rowCount) return res.status(404).json({ error: 'That person has no profile to approve yet.' });
    await query(
      `UPDATE kindred_web.crew_profile
          SET approved_at = $2, approved_by = $3, updated_at = NOW(), updated_by = $3
        WHERE square_team_member_id = $1`,
      [req.params.squareId, on ? new Date() : null, req.userId]
    );
    const slug = on ? await assignSlug(req.params.squareId) : null;
    const r = await query(`${CREW_SELECT} WHERE t.id = $1`, [req.params.squareId]);
    res.json({ ...r.rows[0], slug: slug ?? r.rows[0]?.slug });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

/** PUT /api/crew/:squareId/order { order: [squareId, …] } — display order. */
crewRouter.put('/order/all', requireCapability('tasks.manage'), async (req, res) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order : [];
    for (let i = 0; i < order.length; i++) {
      await query(
        `UPDATE kindred_web.crew_profile SET sort_order = $2 WHERE square_team_member_id = $1`,
        [order[i], i]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
