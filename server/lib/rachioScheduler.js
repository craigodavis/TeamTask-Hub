/**
 * Rachio Biweekly Schedule Checker
 * Runs every hour to fire any rachio_schedules whose next_run_at has passed.
 * After firing, advances next_run_at by 14 days.
 */
import { query } from '../db.js';
import { rachioFetch } from '../routes/groundControl.js';

async function runDueSchedules() {
  try {
    // Find all enabled schedules whose next_run_at is in the past
    const r = await query(
      `SELECT * FROM rachio_schedules
       WHERE enabled = true
         AND next_run_at IS NOT NULL
         AND next_run_at <= NOW()
       ORDER BY next_run_at`,
    );

    if (!r.rows.length) return;

    console.log(`[RachioScheduler] ${r.rows.length} due schedule(s) found.`);

    for (const schedule of r.rows) {
      const durationSeconds = schedule.duration_minutes * 60;
      try {
        await rachioFetch('/zone/start', {
          method: 'PUT',
          body: JSON.stringify({ id: schedule.zone_id, duration: durationSeconds }),
        });

        // Advance next_run_at by 14 days
        await query(
          `UPDATE rachio_schedules
           SET last_run_at = NOW(),
               next_run_at = next_run_at + INTERVAL '14 days'
           WHERE id = $1`,
          [schedule.id]
        );

        console.log(`[RachioScheduler] Fired schedule "${schedule.name}" (zone ${schedule.zone_id}, ${schedule.duration_minutes} min). Next run in 14 days.`);
      } catch (err) {
        console.error(`[RachioScheduler] Failed to fire schedule "${schedule.name}":`, err.message);
        // Advance anyway so we don't hammer the API on repeated failures
        await query(
          `UPDATE rachio_schedules
           SET next_run_at = next_run_at + INTERVAL '14 days'
           WHERE id = $1`,
          [schedule.id]
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[RachioScheduler] Error checking schedules:', err.message);
  }
}

export function startRachioScheduler() {
  // Run once at startup, then every hour
  runDueSchedules();
  setInterval(runDueSchedules, 60 * 60 * 1000);
  console.log('[RachioScheduler] Started — checking every hour.');
}
