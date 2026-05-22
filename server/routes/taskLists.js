import express from 'express';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';
import { sendSmsToUsers } from '../lib/smsHelper.js';

const router = express.Router();
const companyId = (req) => req.companyId;

function isMissingTableErr(err, tableName) {
  return err.code === '42P01' || (err.message && String(err.message).includes(tableName) && String(err.message).toLowerCase().includes('does not exist'));
}

// ---------- Wage titles (sourced from Square shift data) ----------
router.get('/wage-titles', async (req, res) => {
  try {
    const r = await query(
      `SELECT DISTINCT wage_title FROM square.shift
       WHERE wage_title IS NOT NULL AND wage_title <> ''
       ORDER BY wage_title`
    );
    res.json({ wage_titles: r.rows.map((row) => row.wage_title) });
  } catch (err) {
    // If the square schema isn't accessible, return empty list gracefully
    res.json({ wage_titles: [] });
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
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
    const cId = companyId(req);
    const userId = req.userId;
    await ensureDailyAssignmentsForDate(cId, date);
    await ensureWeeklyAssignmentsForDate(cId, date);
    await ensureMonthlyAssignmentsForDate(cId, date);
    await ensureYearlyAssignmentsForDate(cId, date);
    const assignmentsResult = await query(
      `SELECT ta.id, ta.template_id, ta.assigned_date, ta.assignee_id,
              tlt.name as template_name, tlt.type as template_type, tlt.period_type,
              u.display_name as assignee_name
       FROM task_assignments ta
       JOIN task_list_templates tlt ON tlt.id = ta.template_id
       LEFT JOIN users u ON u.id = ta.assignee_id
       WHERE ta.company_id = $1 AND ta.assigned_date = $2
       ORDER BY tlt.name`,
      [cId, date]
    );
    const assignments = assignmentsResult.rows;
    const out = [];
    for (const a of assignments) {
      const tasksResult = await query(
        `SELECT tt.id as task_template_id, tt.title, tt.sort_order, tt.priority,
                tc.completed_at as my_completed_at,
                tc.status as my_status,
                tc.reason as my_reason
         FROM task_templates tt
         LEFT JOIN task_completions tc ON tc.task_template_id = tt.id AND tc.assignment_id = $1 AND tc.user_id = $2
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
      await query(
        `DELETE FROM task_completions WHERE assignment_id = $1 AND task_template_id = $2 AND user_id = $3`,
        [assignmentId, taskTemplateId, userId]
      );
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

    // Fire-and-forget: check if all tasks in the assignment are now addressed and send SMS
    checkAndSendCompletionSms(assignmentId, companyId(req), userId).catch((e) =>
      console.error('[taskLists] completion SMS error:', e.message)
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * After a task status change, check if every task in the assignment has been
 * addressed (completed or not_completed).  If so — and we haven't sent SMS
 * for this assignment yet — send the celebratory/summary message.
 */
async function checkAndSendCompletionSms(assignmentId, cId, triggeredByUserId) {
  // Fetch assignment info + SMS-sent flag in one query
  const assignRes = await query(
    `SELECT ta.id, ta.completion_sms_sent_at, ta.template_id, ta.company_id,
            c.ops_manager_name
     FROM task_assignments ta
     JOIN companies c ON c.id = ta.company_id
     WHERE ta.id = $1 AND ta.company_id = $2`,
    [assignmentId, cId]
  );
  const assignment = assignRes.rows[0];
  if (!assignment || assignment.completion_sms_sent_at) return; // already sent

  // Count total tasks on the template vs how many have a status record
  const countRes = await query(
    `SELECT
       COUNT(tt.id)                                                       AS total,
       COUNT(tc.status) FILTER (WHERE tc.status = 'completed')           AS n_completed,
       COUNT(tc.status) FILTER (WHERE tc.status = 'not_completed')       AS n_not_done
     FROM task_templates tt
     LEFT JOIN task_completions tc
       ON tc.task_template_id = tt.id
      AND tc.assignment_id = $1
     WHERE tt.template_id = $2`,
    [assignmentId, assignment.template_id]
  );
  const { total, n_completed, n_not_done } = countRes.rows[0];
  const totalNum    = parseInt(total,       10);
  const completedNum = parseInt(n_completed, 10);
  const notDoneNum  = parseInt(n_not_done,  10);
  const addressedNum = completedNum + notDoneNum;

  if (addressedNum < totalNum) return; // still tasks left without a status

  // All tasks addressed — build message
  let message;
  const managerName = assignment.ops_manager_name || 'your manager';
  if (notDoneNum === 0) {
    // Everyone completed everything 🎉
    message = `🎉 Hurrah! All ${totalNum} task${totalNum === 1 ? '' : 's'} on your list have been completed. Great work, team!`;
  } else {
    const remaining = notDoneNum;
    message = `Hey, good job completing ${completedNum} of ${totalNum} task${totalNum === 1 ? '' : 's'}. You still have ${remaining} task${remaining === 1 ? '' : 's'} remaining. Please contact ${managerName}.`;
  }

  // Gather the distinct users who touched any task in this assignment
  const usersRes = await query(
    `SELECT DISTINCT user_id FROM task_completions WHERE assignment_id = $1`,
    [assignmentId]
  );
  const userIds = usersRes.rows.map((r) => r.user_id);

  if (userIds.length === 0) return;

  // Mark as sent before firing (prevent race double-sends)
  const updateRes = await query(
    `UPDATE task_assignments SET completion_sms_sent_at = NOW()
     WHERE id = $1 AND completion_sms_sent_at IS NULL
     RETURNING id`,
    [assignmentId]
  );
  if (updateRes.rowCount === 0) return; // another process beat us to it

  await sendSmsToUsers(cId, userIds, message, triggeredByUserId);
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

export { router as taskListsRouter };
