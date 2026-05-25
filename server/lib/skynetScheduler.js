/**
 * Skynet Scheduler — fires Paperclip issues for agent schedules stored in skynet_schedules.
 * Runs a check every 60 seconds. For each enabled schedule whose next_run_at has passed,
 * it creates a Paperclip issue assigned to the target agent and updates next_run_at.
 */

import { query } from '../db.js';

function addInterval(date, scheduleType, cronExpression) {
  const d = new Date(date);
  switch (scheduleType) {
    case 'hourly':   d.setHours(d.getHours() + 1);   break;
    case 'daily':    d.setDate(d.getDate() + 1);       break;
    case 'weekly':   d.setDate(d.getDate() + 7);       break;
    case 'monthly':  d.setMonth(d.getMonth() + 1);     break;
    case 'annually': d.setFullYear(d.getFullYear() + 1); break;
    default:         return null; // 'once' — no next run
  }
  return d;
}

async function getPaperclipConfig(companyId) {
  const r = await query(
    `SELECT paperclip_base_url, paperclip_api_key, paperclip_company_id, paperclip_default_goal_id
     FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  const row = r.rows[0];
  return {
    baseUrl:   row?.paperclip_base_url?.trim()          || process.env.PAPERCLIP_BASE_URL,
    apiKey:    row?.paperclip_api_key?.trim()           || process.env.PAPERCLIP_API_KEY,
    companyId: row?.paperclip_company_id?.trim()        || process.env.PAPERCLIP_COMPANY_ID,
    goalId:    row?.paperclip_default_goal_id?.trim()   || process.env.PAPERCLIP_DEFAULT_GOAL_ID,
  };
}

async function fireSchedule(schedule) {
  const cfg = await getPaperclipConfig(schedule.company_id);
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.companyId) {
    console.warn(`[skynet] schedule ${schedule.id} — Paperclip not configured for company ${schedule.company_id}`);
    return null;
  }

  const body = {
    title:           `${schedule.name} — ${new Date().toISOString().slice(0, 10)}`,
    description:     schedule.prompt,
    assigneeAgentId: schedule.agent_id,
    priority:        'medium',
    status:          'todo',
  };
  if (cfg.goalId) body.goalId = cfg.goalId;

  const res = await fetch(`${cfg.baseUrl}/api/companies/${cfg.companyId}/issues`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Paperclip ${res.status}: ${err}`);
  }
  return await res.json();
}

async function tick() {
  try {
    const due = await query(
      `SELECT * FROM skynet_schedules
       WHERE enabled = true AND next_run_at IS NOT NULL AND next_run_at <= NOW()
       ORDER BY next_run_at ASC
       LIMIT 50`
    );

    for (const schedule of due.rows) {
      try {
        const issue = await fireSchedule(schedule);
        const issueId = issue?.id || issue?.issue?.id || null;
        const nextRun = addInterval(new Date(), schedule.schedule_type, schedule.cron_expression);

        await query(
          `UPDATE skynet_schedules
           SET last_run_at   = NOW(),
               last_issue_id = $1,
               run_count     = run_count + 1,
               next_run_at   = $2,
               enabled       = CASE WHEN $3 = 'once' THEN false ELSE enabled END
           WHERE id = $4`,
          [issueId, nextRun, schedule.schedule_type, schedule.id]
        );
        console.log(`[skynet] fired schedule "${schedule.name}" → issue ${issueId}`);
      } catch (err) {
        console.error(`[skynet] schedule ${schedule.id} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('[skynet] tick error:', err.message);
  }
}

export function startSkynetScheduler() {
  console.log('[skynet] scheduler started');
  setInterval(tick, 60_000);
  tick(); // run immediately on startup to catch any missed runs
}
