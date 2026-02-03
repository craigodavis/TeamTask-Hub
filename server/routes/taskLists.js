import express from 'express';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';

const router = express.Router();
const companyId = (req) => req.companyId;

// ---------- Templates (manager) ----------
router.get('/templates', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, company_id, name, type, period_type, day_of_week, day_of_month, recur_month, recur_day, created_at
       FROM task_list_templates WHERE company_id = $1 ORDER BY name`,
      [companyId(req)]
    );
    res.json({ templates: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/templates', requireManager, async (req, res) => {
  try {
    const { name, type, period_type, day_of_week, day_of_month, recur_month, recur_day } = req.body;
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
    const r = await query(
      `INSERT INTO task_list_templates (company_id, name, type, period_type, day_of_week, day_of_month, recur_month, recur_day)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, company_id, name, type, period_type, day_of_week, day_of_month, recur_month, recur_day, created_at`,
      [companyId(req), name, type, period_type, dayOfWeekVal, dayOfMonthVal, recurMonthVal, recurDayVal]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/templates/:id', requireManager, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, period_type, day_of_week, day_of_month, recur_month, recur_day } = req.body;
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
         updated_at = NOW()
       WHERE id = $1 AND company_id = $9
       RETURNING id, company_id, name, type, period_type, day_of_week, day_of_month, recur_month, recur_day, updated_at`,
      [
        id, name, type, period_type,
        period_type === 'weekly' && day_of_week != null ? parseInt(day_of_week, 10) : null,
        period_type === 'monthly' && day_of_month != null ? parseInt(day_of_month, 10) : null,
        period_type === 'yearly' && recur_month != null ? parseInt(recur_month, 10) : null,
        period_type === 'yearly' && recur_day != null ? parseInt(recur_day, 10) : null,
        companyId(req),
      ]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    res.json(r.rows[0]);
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
      `SELECT tt.id, tt.template_id, tt.title, tt.sort_order
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
    const { title, sort_order } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const r = await query(
      `INSERT INTO task_templates (template_id, title, sort_order)
       SELECT $2, $3, COALESCE($4, (SELECT COALESCE(MAX(sort_order),0)+1 FROM task_templates WHERE template_id = $2))
       FROM task_list_templates WHERE id = $2 AND company_id = $1
       RETURNING id, template_id, title, sort_order`,
      [companyId(req), templateId, title, sort_order]
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
    const { title, sort_order } = req.body;
    const r = await query(
      `UPDATE task_templates SET title = COALESCE($2, title), sort_order = COALESCE($3, sort_order), updated_at = NOW()
       WHERE id = $1 AND template_id IN (SELECT id FROM task_list_templates WHERE company_id = $4)
       RETURNING id, template_id, title, sort_order`,
      [taskId, title, sort_order, companyId(req)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.json(r.rows[0]);
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
        `SELECT tt.id as task_template_id, tt.title, tt.sort_order,
                tc.completed_at as my_completed_at
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

// Set or clear completion for current user
router.put('/assignments/:assignmentId/tasks/:taskTemplateId/complete', async (req, res) => {
  try {
    const { assignmentId, taskTemplateId } = req.params;
    const { completed } = req.body; // true = yes, false = no
    const userId = req.userId;
    const exists = await query(
      `SELECT 1 FROM task_assignments WHERE id = $1 AND company_id = $2`,
      [assignmentId, companyId(req)]
    );
    if (exists.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
    const completedAt = completed ? new Date().toISOString() : null;
    await query(
      `INSERT INTO task_completions (assignment_id, task_template_id, user_id, completed_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (assignment_id, task_template_id, user_id) DO UPDATE SET
         completed_at = EXCLUDED.completed_at, updated_at = NOW()`,
      [assignmentId, taskTemplateId, userId, completedAt]
    );
    const r = await query(
      `SELECT id, assignment_id, task_template_id, user_id, completed_at FROM task_completions
       WHERE assignment_id = $1 AND task_template_id = $2 AND user_id = $3`,
      [assignmentId, taskTemplateId, userId]
    );
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as taskListsRouter };
