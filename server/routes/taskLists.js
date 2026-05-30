import express from 'express';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';
import { sendSmsToUsers } from '../lib/smsHelper.js';

const router = express.Router();
const companyId = (req) => req.companyId;

function isMissingTableErr(err, tableName) {
  return err.code === '42P01' || (err.message && String(err.message).includes(tableName) && String(err.message).toLowerCase().includes('does not exist'));
}

// ---------- Wage titles (sourced from Square shift data + existing templates) ----------
router.get('/wage-titles', async (req, res) => {
  const cId = companyId(req);
  // Collect titles from two sources and merge them
  const titles = new Set();

  // 1. Titles used in existing templates for this company (always available)
  try {
    const tr = await query(
      `SELECT DISTINCT wage_title FROM task_list_templates
       WHERE company_id = $1 AND wage_title IS NOT NULL AND wage_title <> ''
       ORDER BY wage_title`,
      [cId]
    );
    tr.rows.forEach((row) => titles.add(row.wage_title));
  } catch { /* ignore */ }

  // 2. Titles from Square shift history (may not exist if Square not synced)
  try {
    const sr = await query(
      `SELECT DISTINCT wage_title FROM team_square.shift
       WHERE wage_title IS NOT NULL AND wage_title <> ''
       ORDER BY wage_title`
    );
    sr.rows.forEach((row) => titles.add(row.wage_title));
  } catch { /* Square schema not accessible — skip */ }

  res.json({ wage_titles: [...titles].sort() });
});

// ---------- Live Square schedule for a date ----------
// GET /square-schedule?date=YYYY-MM-DD
// Queries Square Labor API directly (not Fivetran) for today/future shifts.
// Returns [{ user_id, display_name, square_team_member_id, wage_title, shift_start, shift_end, status }]
router.get('/square-schedule', requireManager, async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
  }
  const cId = companyId(req);
  try {
    // Get Square credentials
    const intRes = await query(
      `SELECT square_access_token, square_env FROM company_integrations WHERE company_id = $1`,
      [cId]
    );
    const integrations = intRes.rows[0];
    const token = integrations?.square_access_token?.trim() || process.env.SQUARE_ACCESS_TOKEN;
    if (!token) return res.status(400).json({ error: 'Square not configured' });
    const squareBase = (integrations?.square_env || process.env.SQUARE_ENV || 'production') === 'sandbox'
      ? 'https://connect.squareupsandbox.com'
      : 'https://connect.squareup.com';

    // Get company timezone for correct workday matching
    const tzRes = await query(`SELECT timezone FROM companies WHERE id = $1`, [cId]);
    const timezone = tzRes.rows[0]?.timezone || 'America/Boise';

    // Search Square Labor API for shifts on this date
    // Using workday filter so timezone is respected; fetches all statuses (OPEN + CLOSED)
    const squareRes = await fetch(`${squareBase}/v2/labor/shifts/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-01-18',
      },
      body: JSON.stringify({
        query: {
          filter: {
            workday: {
              date_range: { start_date: date, end_date: date },
              default_timezone: timezone,
              match_shifts_by: 'START_AT',
            },
          },
        },
        limit: 200,
      }),
    });

    if (!squareRes.ok) {
      const errBody = await squareRes.text();
      console.error('[square-schedule] Square API error:', squareRes.status, errBody);
      return res.status(502).json({ error: `Square API returned ${squareRes.status}` });
    }

    const squareData = await squareRes.json();
    const shifts = squareData.shifts || [];

    // Collect unique team_member_ids from shifts
    const teamMemberIds = [...new Set(shifts.map((s) => s.team_member_id).filter(Boolean))];
    if (teamMemberIds.length === 0) {
      return res.json({ date, schedule: [] });
    }

    // Map team_member_id → TeamHub user
    const userRes = await query(
      `SELECT id AS user_id, display_name, square_team_member_id
       FROM users
       WHERE company_id = $1 AND square_team_member_id = ANY($2::text[])`,
      [cId, teamMemberIds]
    );
    const userBySquareId = Object.fromEntries(
      userRes.rows.map((u) => [u.square_team_member_id, u])
    );

    // Build schedule entries (one per shift — a person may have multiple shifts)
    const schedule = shifts
      .filter((s) => s.team_member_id && userBySquareId[s.team_member_id])
      .map((s) => {
        const user = userBySquareId[s.team_member_id];
        return {
          user_id: user.user_id,
          display_name: user.display_name,
          square_team_member_id: s.team_member_id,
          wage_title: s.wage?.title || null,
          shift_start: s.start_at || null,
          shift_end: s.end_at || null,
          status: s.status || null,
        };
      })
      // Sort by shift start time
      .sort((a, b) => (a.shift_start || '').localeCompare(b.shift_start || ''));

    res.json({ date, schedule });
  } catch (err) {
    console.error('[square-schedule] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Staff schedule for a date (scheduled shifts from Square sync) ----------
// Returns all TeamHub users scheduled that day with their role + location.
// Also returns the calling user's location(s) for that day so the client can default to it.
router.get('/staff-schedule', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    const cId = companyId(req);
    const userId = req.userId;

    const tzRes = await query(`SELECT timezone FROM companies WHERE id = $1`, [cId]);
    const tz = tzRes.rows[0]?.timezone || 'UTC';

    const r = await query(
      `SELECT
         u.id AS user_id,
         u.display_name,
         COALESCE(ja.job_title, ss.pub_job_id) AS role,
         l.name AS location_name,
         l.id AS location_id,
         ss.pub_start_at AS start_at,
         ss.pub_end_at AS end_at
       FROM team_square.scheduled_shift ss
       JOIN users u ON u.square_team_member_id = ss.pub_team_member_id AND u.company_id = $1
       LEFT JOIN LATERAL (
         SELECT job_title FROM team_square.team_member_job_assignment
         WHERE job_id = ss.pub_job_id LIMIT 1
       ) ja ON true
       LEFT JOIN locations l
         ON l.square_location_id = ss.pub_location_id AND l.company_id = $1
       WHERE ss.pub_is_deleted = false
         AND DATE(ss.pub_start_at AT TIME ZONE $2) = $3::date
       ORDER BY l.name NULLS LAST, COALESCE(ja.job_title, ss.pub_job_id), u.display_name`,
      [cId, tz, date]
    );

    // Determine the calling user's location for this day (to set default filter on client)
    const myRows = r.rows.filter((row) => row.user_id === userId);
    const myLocationName = myRows.find((row) => row.location_name)?.location_name || null;

    res.json({ date, staff: r.rows, my_location: myLocationName });
  } catch (err) {
    // Gracefully handle missing team_square schema
    if (err.message && (err.message.includes('scheduled_shift') || err.message.includes('team_square'))) {
      return res.json({ date: req.query.date, staff: [], my_location: null });
    }
    res.status(500).json({ error: err.message });
  }
});

// ---------- Templates (manager) ----------
router.get('/templates', async (req, res) => {
  try {
    let r;
    try {
      r = await query(
        `SELECT tlt.id, tlt.company_id, tlt.name, tlt.type, tlt.period_type, tlt.day_of_week, tlt.day_of_month, tlt.recur_month, tlt.recur_day, tlt.wage_title, tlt.created_at,
                COALESCE(
                  (SELECT array_agg(tll.location_id ORDER BY tll.location_id) FROM task_list_template_locations tll WHERE tll.template_id = tlt.id),
                  ARRAY[]::uuid[]
                ) AS location_ids
         FROM task_list_templates tlt
         WHERE tlt.company_id = $1 ORDER BY tlt.name`,
        [companyId(req)]
      );
    } catch (tableErr) {
      if (isMissingTableErr(tableErr, 'task_list_template_locations')) {
        r = await query(
          `SELECT id, company_id, name, type, period_type, day_of_week, day_of_month, recur_month, recur_day, wage_title, created_at
           FROM task_list_templates WHERE company_id = $1 ORDER BY name`,
          [companyId(req)]
        );
        r.rows = r.rows.map((row) => ({ ...row, location_ids: [] }));
      } else {
        throw tableErr;
      }
    }
    const templates = r.rows.map((row) => ({ ...row, location_ids: row.location_ids || [] }));
    res.json({ templates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/templates', requireManager, async (req, res) => {
  try {
    const { name, type, period_type, day_of_week, day_of_month, recur_month, recur_day, location_ids, wage_title } = req.body;
    if (!name || !type || !period_type) {
      return res.status(400).json({ error: 'name, type, period_type required' });
    }
    let dayOfWeekVal = null, dayOfMonthVal = null, recurMonthVal = null, recurDayVal = null;
    if (period_type === 'weekly') {
      const dow = day_of_week != null ? parseInt(day_of_week, 10) : null;
      if (dow == null || dow < 0 || dow > 6) {
        return res.status(400).json({ error: 'day_of_week required for weekly (0=Sun, 1=Mon, ... 6=Sat)' });
      }
      dayOfWeekVal = dow;
    } else if (period_type === 'monthly') {
      const dom = day_of_month != null ? parseInt(day_of_month, 10) : null;
      if (dom == null || dom < 1 || dom > 31) {
        return res.status(400).json({ error: 'day_of_month required for monthly (1-31)' });
      }
      dayOfMonthVal = dom;
    } else if (period_type === 'yearly') {
      const rm = recur_month != null ? parseInt(recur_month, 10) : null;
      const rd = recur_day != null ? parseInt(recur_day, 10) : null;
      if (rm == null || rm < 1 || rm > 12 || rd == null || rd < 1 || rd > 31) {
        return res.status(400).json({ error: 'recur_month (1-12) and recur_day (1-31) required for yearly' });
      }
      recurMonthVal = rm;
      recurDayVal = rd;
    }
    const cId = companyId(req);
    const r = await query(
      `INSERT INTO task_list_templates (company_id, name, type, period_type, day_of_week, day_of_month, recur_month, recur_day, wage_title)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, company_id, name, type, period_type, day_of_week, day_of_month, recur_month, recur_day, wage_title, created_at`,
      [cId, name, type, period_type, dayOfWeekVal, dayOfMonthVal, recurMonthVal, recurDayVal, wage_title || null]
    );
    const template = r.rows[0];
    let locationIds = [];
    try {
      const ids = Array.isArray(location_ids) ? location_ids.filter(Boolean) : [];
      if (ids.length > 0) {
        const valid = await query(
          `SELECT id FROM locations WHERE id = ANY($1::uuid[]) AND company_id = $2`,
          [ids, cId]
        );
        for (const row of valid.rows) {
          await query(
            `INSERT INTO task_list_template_locations (template_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [template.id, row.id]
          );
        }
      }
      const locAgg = await query(
        `SELECT array_agg(location_id ORDER BY location_id) AS location_ids FROM task_list_template_locations WHERE template_id = $1`,
        [template.id]
      );
      locationIds = locAgg.rows[0]?.location_ids || [];
    } catch (locErr) {
      if (!isMissingTableErr(locErr, 'task_list_template_locations')) throw locErr;
    }
    res.status(201).json({ ...template, location_ids: locationIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/templates/:id', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, period_type, day_of_week, day_of_month, recur_month, recur_day, location_ids, wage_title } = req.body;
    if (period_type === 'weekly' && day_of_week != null) {
      const dow = parseInt(day_of_week, 10);
      if (dow < 0 || dow > 6) {
        return res.status(400).json({ error: 'day_of_week must be 0-6 (0=Sun, 1=Mon, ... 6=Sat)' });
      }
    }
    if (period_type === 'monthly' && day_of_month != null) {
      const dom = parseInt(day_of_month, 10);
      if (dom < 1 || dom > 31) {
        return res.status(400).json({ error: 'day_of_month must be 1-31' });
      }
    }
    if (period_type === 'yearly' && (recur_month != null || recur_day != null)) {
      const rm = recur_month != null ? parseInt(recur_month, 10) : null;
      const rd = recur_day != null ? parseInt(recur_day, 10) : null;
      if (rm != null && (rm < 1 || rm > 12)) return res.status(400).json({ error: 'recur_month must be 1-12' });
      if (rd != null && (rd < 1 || rd > 31)) return res.status(400).json({ error: 'recur_day must be 1-31' });
    }
    const cId = companyId(req);
    const r = await query(
      `UPDATE task_list_templates SET
         name = COALESCE(NULLIF($2, ''), name),
         type = COALESCE(NULLIF($3, ''), type),
         period_type = COALESCE(NULLIF($4, ''), period_type),
         day_of_week = CASE
           WHEN $4 = 'weekly' THEN COALESCE($5::integer, task_list_templates.day_of_week)
           WHEN $4 IS NOT NULL AND $4 != '' AND $4 != 'weekly' THEN NULL::integer
           ELSE task_list_templates.day_of_week
         END,
         day_of_month = CASE
           WHEN $4 = 'monthly' THEN COALESCE($6::integer, task_list_templates.day_of_month)
           WHEN $4 IS NOT NULL AND $4 != '' AND $4 != 'monthly' THEN NULL::integer
           ELSE task_list_templates.day_of_month
         END,
         recur_month = CASE
           WHEN $4 = 'yearly' THEN COALESCE($7::integer, task_list_templates.recur_month)
           WHEN $4 IS NOT NULL AND $4 != '' AND $4 != 'yearly' THEN NULL::integer
           ELSE task_list_templates.recur_month
         END,
         recur_day = CASE
           WHEN $4 = 'yearly' THEN COALESCE($8::integer, task_list_templates.recur_day)
           WHEN $4 IS NOT NULL AND $4 != '' AND $4 != 'yearly' THEN NULL::integer
           ELSE task_list_templates.recur_day
         END,
         wage_title = CASE WHEN $10::text IS NOT NULL THEN $10::text ELSE wage_title END,
         updated_at = NOW()
       WHERE id = $1 AND company_id = $9
       RETURNING id, company_id, name, type, period_type, day_of_week, day_of_month, recur_month, recur_day, wage_title, updated_at`,
      [
        id, name, type, period_type,
        period_type === 'weekly' && day_of_week != null ? parseInt(day_of_week, 10) : null,
        period_type === 'monthly' && day_of_month != null ? parseInt(day_of_month, 10) : null,
        period_type === 'yearly' && recur_month != null ? parseInt(recur_month, 10) : null,
        period_type === 'yearly' && recur_day != null ? parseInt(recur_day, 10) : null,
        cId,
        wage_title !== undefined ? (wage_title || null) : null,
      ]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    const template = r.rows[0];
    try {
      if (location_ids !== undefined) {
        await query(`DELETE FROM task_list_template_locations WHERE template_id = $1`, [id]);
        const ids = Array.isArray(location_ids) ? location_ids.filter(Boolean) : [];
        if (ids.length > 0) {
          const valid = await query(
            `SELECT id FROM locations WHERE id = ANY($1::uuid[]) AND company_id = $2`,
            [ids, cId]
          );
          for (const row of valid.rows) {
            await query(
              `INSERT INTO task_list_template_locations (template_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [id, row.id]
            );
          }
        }
      }
      const locAgg = await query(
        `SELECT array_agg(location_id ORDER BY location_id) AS location_ids FROM task_list_template_locations WHERE template_id = $1`,
        [id]
      );
      template.location_ids = locAgg.rows[0]?.location_ids || [];
    } catch (locErr) {
      if (!isMissingTableErr(locErr, 'task_list_template_locations')) throw locErr;
      template.location_ids = [];
    }
    res.json(template);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/templates/:id', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query(
      `DELETE FROM task_list_templates WHERE id = $1 AND company_id = $2 RETURNING id`,
      [id, companyId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Task items in a template ----------
router.get('/templates/:templateId/tasks', async (req, res) => {
  try {
    const { templateId } = req.params;
    const r = await query(
      `SELECT tt.id, tt.template_id, tt.title, tt.sort_order, tt.priority
       FROM task_templates tt
       JOIN task_list_templates tlt ON tlt.id = tt.template_id AND tlt.company_id = $1
       WHERE tt.template_id = $2 ORDER BY tt.sort_order, tt.id`,
      [companyId(req), templateId]
    );
    res.json({ tasks: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/templates/:templateId/tasks', requireManager, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { title, sort_order, priority } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const validPriority = ['must', 'try'].includes(priority) ? priority : 'must';
    const r = await query(
      `INSERT INTO task_templates (template_id, title, sort_order, priority)
       SELECT $2, $3, COALESCE($4, (SELECT COALESCE(MAX(sort_order),0)+1 FROM task_templates WHERE template_id = $2)), $5
       FROM task_list_templates WHERE id = $2 AND company_id = $1
       RETURNING id, template_id, title, sort_order, priority`,
      [companyId(req), templateId, title, sort_order, validPriority]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/tasks/:taskId', requireManager, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { title, sort_order, priority } = req.body;
    const validPriority = priority && ['must', 'try'].includes(priority) ? priority : null;
    const r = await query(
      `UPDATE task_templates
       SET title      = COALESCE($2, title),
           sort_order = COALESCE($3, sort_order),
           priority   = COALESCE($5, priority),
           updated_at = NOW()
       WHERE id = $1 AND template_id IN (SELECT id FROM task_list_templates WHERE company_id = $4)
       RETURNING id, template_id, title, sort_order, priority`,
      [taskId, title, sort_order, companyId(req), validPriority]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reorder tasks within a template by providing ordered task IDs.
// Assigns sort_order 1, 2, 3... to match the given sequence.
router.put('/templates/:templateId/tasks/reorder', requireManager, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { task_ids } = req.body;
    if (!Array.isArray(task_ids) || task_ids.length === 0) {
      return res.status(400).json({ error: 'task_ids array required' });
    }
    // Verify template belongs to this company
    const owns = await query(
      `SELECT 1 FROM task_list_templates WHERE id = $1 AND company_id = $2`,
      [templateId, companyId(req)]
    );
    if (owns.rows.length === 0) return res.status(404).json({ error: 'Template not found' });

    // Update each task's sort_order in one pass
    for (let i = 0; i < task_ids.length; i++) {
      await query(
        `UPDATE task_templates SET sort_order = $1, updated_at = NOW()
         WHERE id = $2 AND template_id = $3`,
        [i + 1, task_ids[i], templateId]
      );
    }
    const r = await query(
      `SELECT id, template_id, title, sort_order, priority FROM task_templates
       WHERE template_id = $1 ORDER BY sort_order, id`,
      [templateId]
    );
    res.json({ tasks: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/tasks/:taskId', requireManager, async (req, res) => {
  try {
    const { taskId } = req.params;
    const r = await query(
      `DELETE FROM task_templates WHERE id = $1 AND template_id IN (SELECT id FROM task_list_templates WHERE company_id = $2) RETURNING id`,
      [taskId, companyId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ensure daily templates have an assignment for the given date (create if missing).
// Daily tasks show each day until the user checks them off for that day.
async function ensureDailyAssignmentsForDate(cId, date) {
  await query(
    `INSERT INTO task_assignments (company_id, template_id, assigned_date, assignee_id)
     SELECT $1, tlt.id, $2::date, NULL
     FROM task_list_templates tlt
     WHERE tlt.company_id = $1
       AND tlt.period_type = 'daily'
       AND NOT EXISTS (
         SELECT 1 FROM task_assignments ta
         WHERE ta.template_id = tlt.id AND ta.assigned_date = $2::date
       )`,
    [cId, date]
  );
}

// Ensure weekly templates have an assignment for the given date (create if missing).
async function ensureWeeklyAssignmentsForDate(cId, date) {
  await query(
    `INSERT INTO task_assignments (company_id, template_id, assigned_date, assignee_id)
     SELECT $1, tlt.id, $2::date, NULL
     FROM task_list_templates tlt
     WHERE tlt.company_id = $1
       AND tlt.period_type = 'weekly'
       AND tlt.day_of_week IS NOT NULL
       AND tlt.day_of_week = EXTRACT(DOW FROM $2::date)::integer
       AND NOT EXISTS (
         SELECT 1 FROM task_assignments ta
         WHERE ta.template_id = tlt.id AND ta.assigned_date = $2::date
       )`,
    [cId, date]
  );
}

// Ensure monthly templates have an assignment for the given date (create if missing).
// Recur on that day of the month (e.g. 15th of every month).
async function ensureMonthlyAssignmentsForDate(cId, date) {
  await query(
    `INSERT INTO task_assignments (company_id, template_id, assigned_date, assignee_id)
     SELECT $1, tlt.id, $2::date, NULL
     FROM task_list_templates tlt
     WHERE tlt.company_id = $1
       AND tlt.period_type = 'monthly'
       AND tlt.day_of_month IS NOT NULL
       AND tlt.day_of_month = EXTRACT(DAY FROM $2::date)::integer
       AND NOT EXISTS (
         SELECT 1 FROM task_assignments ta
         WHERE ta.template_id = tlt.id AND ta.assigned_date = $2::date
       )`,
    [cId, date]
  );
}

// Ensure yearly templates have an assignment for the given date (create if missing).
// Recur on that date each year (e.g. March 15).
async function ensureYearlyAssignmentsForDate(cId, date) {
  await query(
    `INSERT INTO task_assignments (company_id, template_id, assigned_date, assignee_id)
     SELECT $1, tlt.id, $2::date, NULL
     FROM task_list_templates tlt
     WHERE tlt.company_id = $1
       AND tlt.period_type = 'yearly'
       AND tlt.recur_month IS NOT NULL
       AND tlt.recur_day IS NOT NULL
       AND tlt.recur_month = EXTRACT(MONTH FROM $2::date)::integer
       AND tlt.recur_day = EXTRACT(DAY FROM $2::date)::integer
       AND NOT EXISTS (
         SELECT 1 FROM task_assignments ta
         WHERE ta.template_id = tlt.id AND ta.assigned_date = $2::date
       )`,
    [cId, date]
  );
}

// ---------- Day summary (main screen: assignments + tasks + my completions for a date) ----------
router.get('/day-summary', async (req, res) => {
  try {
    const { date, as_user_id } = req.query;
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    const cId = companyId(req);
    const requesterId = req.userId;
    await ensureDailyAssignmentsForDate(cId, date);
    await ensureWeeklyAssignmentsForDate(cId, date);
    await ensureMonthlyAssignmentsForDate(cId, date);
    await ensureYearlyAssignmentsForDate(cId, date);

    // Managers can pass ?as_user_id= to emulate another user's view for troubleshooting
    let userId = requesterId;
    if (as_user_id && as_user_id !== requesterId) {
      const requesterRes = await query(`SELECT role FROM users WHERE id = $1`, [requesterId]);
      const requesterRole = requesterRes.rows[0]?.role;
      if (requesterRole === 'manager' || requesterRole === 'owner') {
        userId = as_user_id;
      }
    }

    // For regular members (non-managers), filter by their scheduled shift today
    let shiftFilter = null; // null = no filter (managers/owners see all)
    const userRes = await query(
      `SELECT role, square_team_member_id FROM users WHERE id = $1`,
      [userId]
    );
    const userRole = userRes.rows[0]?.role;
    const squareTmId = userRes.rows[0]?.square_team_member_id;

    if ((userRole === 'member' || userRole === 'gc') && squareTmId) {
      const tzRes = await query(`SELECT timezone FROM companies WHERE id = $1`, [cId]);
      const tz = tzRes.rows[0]?.timezone || 'UTC';

      // PRIMARY: scheduled shifts (future/published shifts from Square scheduling)
      const shiftRes = await query(
        `SELECT
           l.id AS location_id,
           COALESCE(ja.job_title, ss.pub_job_id) AS wage_title
         FROM team_square.scheduled_shift ss
         LEFT JOIN LATERAL (
           SELECT job_title FROM team_square.team_member_job_assignment
           WHERE job_id = ss.pub_job_id LIMIT 1
         ) ja ON true
         LEFT JOIN locations l
           ON l.square_location_id = ss.pub_location_id AND l.company_id = $1
         WHERE ss.pub_team_member_id = $2
           AND ss.pub_is_deleted = false
           AND DATE(ss.pub_start_at AT TIME ZONE $3) = $4::date`,
        [cId, squareTmId, tz, date]
      );

      // FALLBACK: actual clocked shifts for today — wage_title is stored directly here
      // (more reliable than scheduled_shift → job_assignment join, and catches cases
      //  where the scheduled shift sync is stale or the job title doesn't resolve)
      const clockedRes = await query(
        `SELECT
           l.id AS location_id,
           s.wage_title
         FROM team_square.shift s
         LEFT JOIN locations l
           ON l.square_location_id = s.location_id AND l.company_id = $1
         WHERE s.team_member_id = $2
           AND DATE(s.start_at AT TIME ZONE $3) = $4::date
           AND s.status IN ('OPEN', 'CLOSED')`,
        [cId, squareTmId, tz, date]
      ).catch(() => ({ rows: [] }));

      const allShiftRows = [...shiftRes.rows, ...clockedRes.rows];

      if (allShiftRows.length === 0) {
        // Not scheduled and not clocked in today — show nothing
        return res.json({ date, assignments: [], no_shift: true });
      }

      // Build wage title list from today's shifts first
      let resolvedWageTitles = [...new Set(allShiftRows.map((r) => r.wage_title).filter(Boolean))];

      // If today's shift data didn't resolve a human-readable wage title
      // (i.e. only raw job IDs came back), fall back to the member's most
      // recent actual shift wage_titles — these are the authoritative titles
      // used when creating templates via the dropdown.
      const hasRawJobId = (t) => t && (t.startsWith('TMJ:') || t.startsWith('sq:') || /^[0-9A-F]{8,}$/i.test(t));
      const allRaw = resolvedWageTitles.every(hasRawJobId);
      if (resolvedWageTitles.length === 0 || allRaw) {
        const recentRes = await query(
          `SELECT DISTINCT wage_title
           FROM team_square.shift
           WHERE team_member_id = $1
             AND wage_title IS NOT NULL AND wage_title <> ''
           ORDER BY wage_title`,
          [squareTmId]
        ).catch(() => ({ rows: [] }));
        if (recentRes.rows.length > 0) {
          resolvedWageTitles = recentRes.rows.map((r) => r.wage_title);
        }
      }

      shiftFilter = {
        wageTitles: resolvedWageTitles.length > 0 ? resolvedWageTitles : null,
        locationIds: [...new Set(allShiftRows.map((r) => r.location_id).filter(Boolean))],
      };
    }

    const assignmentsResult = await query(
      `SELECT ta.id, ta.template_id, ta.assigned_date, ta.assignee_id,
              tlt.name as template_name, tlt.type as template_type, tlt.period_type,
              tlt.wage_title,
              u.display_name as assignee_name,
              (SELECT string_agg(l.name, ', ' ORDER BY l.name)
               FROM task_list_template_locations tll
               JOIN locations l ON l.id = tll.location_id AND l.company_id = $1
               WHERE tll.template_id = tlt.id) AS location_names
       FROM task_assignments ta
       JOIN task_list_templates tlt ON tlt.id = ta.template_id
       LEFT JOIN users u ON u.id = ta.assignee_id
       WHERE ta.company_id = $1 AND ta.assigned_date = $2
         AND ($3::text[]  IS NULL OR tlt.wage_title = ANY($3::text[]))
         AND (
           $4::uuid[] IS NULL
           OR NOT EXISTS (SELECT 1 FROM task_list_template_locations tll WHERE tll.template_id = tlt.id)
           OR EXISTS (
             SELECT 1 FROM task_list_template_locations tll
             WHERE tll.template_id = tlt.id AND tll.location_id = ANY($4::uuid[])
           )
         )
       ORDER BY tlt.name`,
      [cId, date,
       shiftFilter ? shiftFilter.wageTitles : null,
       shiftFilter ? shiftFilter.locationIds : null]
    );
    const assignments = assignmentsResult.rows;
    const out = [];
    for (const a of assignments) {
      const tasksResult = await query(
        `SELECT tt.id as task_template_id, tt.title, tt.sort_order, tt.priority,
                tc.completed_at  AS my_completed_at,
                tc.status        AS my_status,
                tc.reason        AS my_reason,
                tc.user_id       AS completed_by_id,
                u2.display_name  AS completed_by_name,
                (tc.user_id = $2) AS completed_by_me
         FROM task_templates tt
         LEFT JOIN LATERAL (
           SELECT * FROM task_completions
           WHERE task_template_id = tt.id AND assignment_id = $1
           ORDER BY completed_at DESC NULLS LAST
           LIMIT 1
         ) tc ON true
         LEFT JOIN users u2 ON u2.id = tc.user_id
         WHERE tt.template_id = $3
         ORDER BY tt.sort_order, tt.id`,
        [a.id, userId, a.template_id]
      );
      out.push({ ...a, tasks: tasksResult.rows });
    }
    res.json({ date, assignments: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Assignments (assign list to a day) ----------
router.get('/assignments', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    const cId = companyId(req);
    await ensureDailyAssignmentsForDate(cId, date);
    await ensureWeeklyAssignmentsForDate(cId, date);
    await ensureMonthlyAssignmentsForDate(cId, date);
    await ensureYearlyAssignmentsForDate(cId, date);
    const r = await query(
      `SELECT ta.id, ta.company_id, ta.template_id, ta.assigned_date, ta.assignee_id,
              tlt.name as template_name, tlt.type as template_type, tlt.period_type,
              tlt.day_of_week, tlt.day_of_month, tlt.recur_month, tlt.recur_day,
              u.display_name as assignee_name
       FROM task_assignments ta
       JOIN task_list_templates tlt ON tlt.id = ta.template_id
       LEFT JOIN users u ON u.id = ta.assignee_id
       WHERE ta.company_id = $1 AND ta.assigned_date = $2
       ORDER BY tlt.name`,
      [cId, date]
    );
    res.json({ assignments: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/assignments', requireManager, async (req, res) => {
  try {
    const { template_id, assigned_date, assignee_id } = req.body;
    if (!template_id || !assigned_date) {
      return res.status(400).json({ error: 'template_id and assigned_date required' });
    }
    const r = await query(
      `INSERT INTO task_assignments (company_id, template_id, assigned_date, assignee_id)
       SELECT $1, $2, $3::date, $4
       FROM task_list_templates WHERE id = $2 AND company_id = $1
       RETURNING id, company_id, template_id, assigned_date, assignee_id, created_at`,
      [companyId(req), template_id, assigned_date, assignee_id || null]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/assignments/:id', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query(
      `DELETE FROM task_assignments WHERE id = $1 AND company_id = $2 RETURNING id`,
      [id, companyId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Close assignment early ----------
// POST /assignments/:id/close  { note?: string }
// - If all tasks are already done, archives with no note required.
// - If incomplete tasks remain, `note` is required.
// - Marks remaining incomplete tasks as not_completed with the note as reason.
// - Sets archived_at and sends SMS to managers + assignee (same as nightly job).
router.post('/assignments/:id/close', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const cId = companyId(req);

    // Verify assignment belongs to this company and isn't already archived
    const assignmentRes = await query(
      `SELECT ta.id, ta.template_id, ta.company_id, ta.assignee_id, ta.assigned_date,
              tlt.name AS template_name,
              u.display_name AS assignee_name
       FROM task_assignments ta
       JOIN task_list_templates tlt ON tlt.id = ta.template_id
       LEFT JOIN users u ON u.id = ta.assignee_id
       WHERE ta.id = $1 AND ta.company_id = $2 AND ta.archived_at IS NULL`,
      [id, cId]
    );
    if (assignmentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found or already closed' });
    }
    const a = assignmentRes.rows[0];

    // Find incomplete tasks
    const incompleteTasks = await query(
      `SELECT tt.id AS task_template_id, tt.title
       FROM task_templates tt
       WHERE tt.template_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM task_completions tc
           WHERE tc.assignment_id = $2 AND tc.task_template_id = tt.id
         )
       ORDER BY tt.sort_order, tt.id`,
      [a.template_id, a.id]
    );

    if (incompleteTasks.rows.length > 0 && !note?.trim()) {
      return res.status(400).json({
        error: 'note is required when closing a list with incomplete tasks',
        incomplete_count: incompleteTasks.rows.length,
      });
    }

    // Mark remaining tasks not_completed with the note
    if (incompleteTasks.rows.length > 0) {
      const reason = note.trim();
      for (const t of incompleteTasks.rows) {
        await query(
          `INSERT INTO task_completions (assignment_id, task_template_id, user_id, completed_at, status, reason, updated_at)
           VALUES ($1, $2, $3, NULL, 'not_completed', $4, NOW())
           ON CONFLICT (assignment_id, task_template_id, user_id) DO UPDATE SET
             completed_at = NULL, status = 'not_completed', reason = $4, updated_at = NOW()`,
          [a.id, t.task_template_id, req.userId, reason]
        );
      }

    }

    // Archive the assignment, then fire closure SMS (once-only guard inside)
    await query(`UPDATE task_assignments SET archived_at = NOW() WHERE id = $1`, [a.id]);
    sendClosureSms(id, cId, { reason: note?.trim() || null, triggeredBy: req.userId })
      .catch((e) => console.error('[close] SMS error:', e.message));

    res.json({ ok: true, assignment_id: a.id, incomplete_closed: incompleteTasks.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Completions (main screen: get tasks for a date + user; toggle yes/no) ----------
router.get('/assignments/:assignmentId/completions', async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const r = await query(
      `SELECT tc.id, tc.assignment_id, tc.task_template_id, tc.user_id, tc.completed_at,
              tt.title as task_title, tt.sort_order
       FROM task_completions tc
       JOIN task_templates tt ON tt.id = tc.task_template_id
       JOIN task_assignments ta ON ta.id = tc.assignment_id AND ta.company_id = $1
       WHERE tc.assignment_id = $2
       ORDER BY tt.sort_order, tt.id`,
      [companyId(req), assignmentId]
    );
    res.json({ completions: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set or clear completion for current user.
// Body: { status: 'completed' | 'not_completed' | null, reason?: string }
// Legacy body: { completed: true|false } still supported.
router.put('/assignments/:assignmentId/tasks/:taskTemplateId/complete', async (req, res) => {
  try {
    const { assignmentId, taskTemplateId } = req.params;
    let { status, reason, completed } = req.body;

    // Legacy support: { completed: true } → 'completed'; { completed: false } → null
    if (status === undefined) {
      status = completed ? 'completed' : null;
    }

    if (status === 'not_completed' && !reason?.trim()) {
      return res.status(400).json({ error: 'reason is required when status is not_completed' });
    }
    if (status && !['completed', 'not_completed'].includes(status)) {
      return res.status(400).json({ error: 'status must be completed, not_completed, or null' });
    }

    const userId = req.userId;
    const exists = await query(
      `SELECT 1 FROM task_assignments WHERE id = $1 AND company_id = $2`,
      [assignmentId, companyId(req)]
    );
    if (exists.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });

    if (!status) {
      // Clear the record entirely → task returns to "null" (unchecked) state
      // Managers/owners can undo any user's completion; regular users only their own.
      const isManager = req.role === 'manager' || req.role === 'owner';
      if (isManager) {
        await query(
          `DELETE FROM task_completions WHERE assignment_id = $1 AND task_template_id = $2`,
          [assignmentId, taskTemplateId]
        );
      } else {
        await query(
          `DELETE FROM task_completions WHERE assignment_id = $1 AND task_template_id = $2 AND user_id = $3`,
          [assignmentId, taskTemplateId, userId]
        );
      }
      // If assignment previously had SMS sent, reset it so it can fire again when all tasks are addressed
      await query(
        `UPDATE task_assignments SET completion_sms_sent_at = NULL
         WHERE id = $1 AND completion_sms_sent_at IS NOT NULL`,
        [assignmentId]
      );
      return res.json({ assignment_id: assignmentId, task_template_id: taskTemplateId, user_id: userId, status: null, reason: null });
    }

    const completedAt = status === 'completed' ? new Date().toISOString() : null;
    await query(
      `INSERT INTO task_completions (assignment_id, task_template_id, user_id, completed_at, status, reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (assignment_id, task_template_id, user_id) DO UPDATE SET
         completed_at = EXCLUDED.completed_at,
         status       = EXCLUDED.status,
         reason       = EXCLUDED.reason,
         updated_at   = NOW()`,
      [assignmentId, taskTemplateId, userId, completedAt, status, status === 'not_completed' ? reason.trim() : null]
    );
    const r = await query(
      `SELECT id, assignment_id, task_template_id, user_id, completed_at, status, reason FROM task_completions
       WHERE assignment_id = $1 AND task_template_id = $2 AND user_id = $3`,
      [assignmentId, taskTemplateId, userId]
    );
    res.json(r.rows[0]);

    // Fire-and-forget: send closure SMS only when every task has been addressed
    sendClosureSms(assignmentId, companyId(req), { triggeredBy: userId, checkAllAddressed: true })
      .catch((e) => console.error('[taskLists] completion SMS error:', e.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Send a single closure SMS for a task list assignment.
 *
 * Rules:
 *   - Fully completed  → assignee only:            "✅ [Name] — all N tasks completed!"
 *   - Any not-completed → assignee + managers:      "⚠️ [Name] closed with N incomplete tasks.\nReason: [reason]"
 *   - Fires at most once per assignment (completion_sms_sent_at guard).
 *   - When checkAllAddressed=true (natural completion path), only fires once every
 *     task has a status — prevents premature sends after each individual toggle.
 *
 * @param {string}  assignmentId
 * @param {string}  cId            company id
 * @param {object}  opts
 * @param {string}  [opts.reason]             Manager note (close-early or archive reason)
 * @param {string}  [opts.triggeredBy]        userId who triggered the action
 * @param {boolean} [opts.checkAllAddressed]  If true, abort unless every task has a status
 */
async function sendClosureSms(assignmentId, cId, { reason = null, triggeredBy = null, checkAllAddressed = false } = {}) {
  // When called from the natural completion path, first verify all tasks are addressed
  // without yet touching completion_sms_sent_at (avoids premature lock).
  if (checkAllAddressed) {
    const check = await query(
      `SELECT ta.template_id, ta.completion_sms_sent_at,
              (SELECT COUNT(*) FROM task_templates tt WHERE tt.template_id = ta.template_id) AS total,
              (SELECT COUNT(*) FROM task_completions tc WHERE tc.assignment_id = ta.id)      AS addressed
       FROM task_assignments ta
       WHERE ta.id = $1 AND ta.company_id = $2`,
      [assignmentId, cId]
    );
    const row = check.rows[0];
    if (!row || row.completion_sms_sent_at) return;
    if (parseInt(row.addressed, 10) < parseInt(row.total, 10)) return; // still tasks without a status
  }

  // Atomically claim the send slot — only one caller wins
  const claim = await query(
    `UPDATE task_assignments SET completion_sms_sent_at = NOW()
     WHERE id = $1 AND company_id = $2 AND completion_sms_sent_at IS NULL
     RETURNING assignee_id, template_id, assigned_date`,
    [assignmentId, cId]
  );
  if (claim.rowCount === 0) return; // already sent or not found

  const { assignee_id, template_id, assigned_date } = claim.rows[0];

  // Template name
  const tplRes = await query(`SELECT name FROM task_list_templates WHERE id = $1`, [template_id]);
  const templateName = tplRes.rows[0]?.name || 'Task list';

  // Task stats
  const countRes = await query(
    `SELECT
       COUNT(tt.id)                                             AS total,
       COUNT(tc.id) FILTER (WHERE tc.status = 'completed')     AS n_completed,
       COUNT(tc.id) FILTER (WHERE tc.status = 'not_completed') AS n_not_done
     FROM task_templates tt
     LEFT JOIN task_completions tc ON tc.task_template_id = tt.id AND tc.assignment_id = $1
     WHERE tt.template_id = $2`,
    [assignmentId, template_id]
  );
  const total      = parseInt(countRes.rows[0]?.total      || 0, 10);
  const nCompleted = parseInt(countRes.rows[0]?.n_completed || 0, 10);
  const nNotDone   = parseInt(countRes.rows[0]?.n_not_done  || 0, 10);
  const allDone    = nNotDone === 0 && nCompleted === total && total > 0;

  // Build message
  let message;
  if (allDone) {
    message = `🎉 "${templateName}" — all ${total} task${total === 1 ? '' : 's'} completed!`;
  } else {
    message = `⚠️ "${templateName}" (${assigned_date}) closed with ${nNotDone} incomplete task${nNotDone === 1 ? '' : 's'}.`;
    if (reason) message += `\nReason: ${reason}`;
  }

  // Recipients: assignee always; managers only when not fully completed
  const recipientIds = [];

  if (assignee_id) {
    const hasPhone = await query(
      `SELECT id FROM users WHERE id = $1 AND phone IS NOT NULL AND phone != ''`,
      [assignee_id]
    );
    if (hasPhone.rows.length) recipientIds.push(assignee_id);
  }

  if (!allDone) {
    const managers = await query(
      `SELECT id FROM users WHERE company_id = $1 AND role IN ('manager','owner')
       AND phone IS NOT NULL AND phone != ''`,
      [cId]
    );
    for (const mgr of managers.rows) {
      if (!recipientIds.includes(mgr.id)) recipientIds.push(mgr.id);
    }
  }

  if (recipientIds.length === 0) {
    console.log(`[sms] No recipients with phones for assignment ${assignmentId}`);
    return;
  }

  await sendSmsToUsers(cId, recipientIds, message, triggeredBy);
  console.log(`[sms] Closure SMS sent — "${templateName}" (${assigned_date}), allDone=${allDone}, recipients=${recipientIds.length}`);
}

// ---------- Task report (manager): completions in date range ----------
router.get('/report', requireManager, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to date required (YYYY-MM-DD)' });
    const cId = companyId(req);
    const r = await query(
      `SELECT ta.assigned_date, tlt.name AS template_name, tt.title AS task_title,
              u_assignee.display_name AS assignee_name,
              u_completed.display_name AS completed_by_name,
              tc.completed_at
       FROM task_completions tc
       JOIN task_assignments ta ON ta.id = tc.assignment_id AND ta.company_id = $1
         AND ta.assigned_date >= $2::date AND ta.assigned_date <= $3::date
       JOIN task_templates tt ON tt.id = tc.task_template_id
       JOIN task_list_templates tlt ON tlt.id = ta.template_id
       LEFT JOIN users u_assignee ON u_assignee.id = ta.assignee_id
       LEFT JOIN users u_completed ON u_completed.id = tc.user_id
       ORDER BY ta.assigned_date DESC, tlt.name, tt.sort_order, tt.id`,
      [cId, from, to]
    );
    res.json({
      from,
      to,
      rows: r.rows.map((row) => ({
        assigned_date: row.assigned_date,
        template_name: row.template_name,
        task_title: row.task_title,
        assignee_name: row.assignee_name || null,
        completed_by_name: row.completed_by_name || null,
        completed_at: row.completed_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Daily archive job (runs at 9am) ----------
// Closes out all assignments from before today:
//   - If any tasks are incomplete, SMS the assignee + all managers
//   - Auto-marks remaining incomplete tasks as not_completed
//   - Sets archived_at on the assignment

async function archivePreviousDayAssignments() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    // Find all open (not yet archived) assignments from before today, with full details
    const openAssignments = await query(
      `SELECT ta.id, ta.template_id, ta.company_id, ta.assignee_id, ta.assigned_date,
              tlt.name AS template_name,
              u.display_name AS assignee_name
       FROM task_assignments ta
       JOIN task_list_templates tlt ON tlt.id = ta.template_id
       LEFT JOIN users u ON u.id = ta.assignee_id
       WHERE ta.assigned_date < $1 AND ta.archived_at IS NULL`,
      [today]
    );

    if (!openAssignments.rows.length) {
      console.log('[archive] No open assignments to archive.');
      return;
    }

    for (const a of openAssignments.rows) {
      // Find incomplete tasks for this assignment
      const incompleteTasks = await query(
        `SELECT tt.id AS task_template_id, tt.title
         FROM task_templates tt
         WHERE tt.template_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM task_completions tc
             WHERE tc.assignment_id = $2 AND tc.task_template_id = tt.id
           )
         ORDER BY tt.sort_order, tt.id`,
        [a.template_id, a.id]
      );

      // Auto-mark each incomplete task as not_completed
      for (const t of incompleteTasks.rows) {
        await query(
          `INSERT INTO task_completions
             (assignment_id, task_template_id, user_id, status, reason, completed_at, updated_at)
           SELECT $1, $2, COALESCE(assignee_id, (SELECT id FROM users WHERE company_id = $3 AND role = 'owner' LIMIT 1)),
                  'not_completed', 'Archived — not completed by 9am', NOW(), NOW()
           FROM task_assignments WHERE id = $1
           ON CONFLICT (assignment_id, task_template_id, user_id) DO NOTHING`,
          [a.id, t.task_template_id, a.company_id]
        );
      }

      // Mark the assignment as archived, then send closure SMS (tasks are already marked above)
      await query(`UPDATE task_assignments SET archived_at = NOW() WHERE id = $1`, [a.id]);
      await sendClosureSms(a.id, a.company_id, { reason: 'Not completed by end of day' });
    }

    console.log(`[archive] Archived ${openAssignments.rows.length} assignment(s) from before ${today}.`);
  } catch (err) {
    console.error('[archive] Error:', err.message);
  }
}

export function startDailyArchiveScheduler() {
  // Run once at startup to catch any missed days (e.g. server was down at 9am)
  archivePreviousDayAssignments();

  // Then schedule for 9am every day
  const msUntil9am = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  };

  setTimeout(() => {
    archivePreviousDayAssignments();
    setInterval(archivePreviousDayAssignments, 24 * 60 * 60 * 1000);
  }, msUntil9am());

  console.log(`[archive] Scheduler started — next run at 9am (in ${Math.round(msUntil9am() / 60000)} min)`);
}

export { router as taskListsRouter };
