import express from 'express';
import { query } from '../db.js';
import { requireGControl } from '../middleware/auth.js';

const router = express.Router();

const RACHIO_API_KEY = 'e30caa4d-6ec3-492f-8803-56dd6f67bea5';
const RACHIO_BASE = 'https://api.rach.io/1/public';

function rachioHeaders() {
  return {
    Authorization: `Bearer ${RACHIO_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function rachioFetch(path, options = {}) {
  const res = await fetch(`${RACHIO_BASE}${path}`, {
    ...options,
    headers: { ...rachioHeaders(), ...(options.headers || {}) },
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch (_) { data = { _raw: text }; }
  if (!res.ok) {
    const msg = data?.message || data?.error || `Rachio API error ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return data;
}

// ── Zones ──────────────────────────────────────────────────────────────────────

// GET /zones — fetch all devices+zones and return flat list
router.get('/zones', requireGControl, async (req, res) => {
  try {
    const personInfo = await rachioFetch('/person/info');
    const personId = personInfo.id;
    const personDetail = await rachioFetch(`/person/${personId}`);
    const devices = personDetail.devices || [];

    const zones = [];
    for (const device of devices) {
      for (const zone of (device.zones || [])) {
        zones.push({
          id: zone.id,
          number: zone.zoneNumber,
          name: zone.name,
          enabled: zone.enabled,
          device_id: device.id,
          device_name: device.name,
          is_vineyard: /vineyard/i.test(zone.name),
        });
      }
    }

    res.json({ zones });
  } catch (err) {
    console.error('GET /ground-control/zones error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /zones/:zoneId/start — start a zone for duration_minutes
router.post('/zones/:zoneId/start', requireGControl, async (req, res) => {
  try {
    const { zoneId } = req.params;
    const { duration_minutes } = req.body;
    if (!duration_minutes || isNaN(Number(duration_minutes))) {
      return res.status(400).json({ error: 'duration_minutes is required' });
    }
    const durationSeconds = Math.round(Number(duration_minutes) * 60);
    await rachioFetch('/zone/start', {
      method: 'PUT',
      body: JSON.stringify({ id: zoneId, duration: durationSeconds }),
    });
    res.json({ ok: true, zone_id: zoneId, duration_minutes: Number(duration_minutes) });
  } catch (err) {
    console.error('POST /ground-control/zones/:id/start error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /zones/stop-all — stop all watering on all devices
router.put('/zones/stop-all', requireGControl, async (req, res) => {
  try {
    // Need to know device IDs to stop each device
    const personInfo = await rachioFetch('/person/info');
    const personDetail = await rachioFetch(`/person/${personInfo.id}`);
    const devices = personDetail.devices || [];

    const results = [];
    for (const device of devices) {
      try {
        await rachioFetch('/device/stopWater', {
          method: 'PUT',
          body: JSON.stringify({ id: device.id }),
        });
        results.push({ device_id: device.id, device_name: device.name, ok: true });
      } catch (err) {
        results.push({ device_id: device.id, device_name: device.name, ok: false, error: err.message });
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    console.error('PUT /ground-control/zones/stop-all error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Schedules ─────────────────────────────────────────────────────────────────

// GET /schedules — list biweekly schedules for this company
router.get('/schedules', requireGControl, async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM rachio_schedules WHERE company_id = $1 ORDER BY day_of_week, start_time`,
      [req.companyId]
    );
    res.json({ schedules: r.rows });
  } catch (err) {
    console.error('GET /ground-control/schedules error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /schedules — create a biweekly schedule
router.post('/schedules', requireGControl, async (req, res) => {
  try {
    const { zone_id, zone_name, device_id, name, duration_minutes, day_of_week, start_time, start_date } = req.body;
    if (!zone_id || !device_id || !name || !duration_minutes || day_of_week === undefined || !start_time) {
      return res.status(400).json({ error: 'zone_id, device_id, name, duration_minutes, day_of_week, start_time are required' });
    }

    // Compute next_run_at from start_date (or today) + day_of_week + start_time
    const nextRun = computeNextRun(day_of_week, start_time, start_date || null);

    const r = await query(
      `INSERT INTO rachio_schedules
         (company_id, zone_id, zone_name, device_id, name, duration_minutes, day_of_week, start_time, next_run_at, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
       RETURNING *`,
      [req.companyId, zone_id, zone_name || null, device_id, name, Number(duration_minutes), Number(day_of_week), start_time, nextRun]
    );
    res.status(201).json({ schedule: r.rows[0] });
  } catch (err) {
    console.error('POST /ground-control/schedules error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /schedules/:id — update (enable/disable, change day/time/duration)
router.patch('/schedules/:id', requireGControl, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query(
      `SELECT * FROM rachio_schedules WHERE id = $1 AND company_id = $2`,
      [id, req.companyId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Schedule not found' });

    const row = existing.rows[0];
    const { enabled, duration_minutes, day_of_week, start_time, name } = req.body;

    const updates = [];
    const params = [];
    let p = 1;

    if (name !== undefined) { updates.push(`name = $${p++}`); params.push(name); }
    if (enabled !== undefined) { updates.push(`enabled = $${p++}`); params.push(Boolean(enabled)); }
    if (duration_minutes !== undefined) { updates.push(`duration_minutes = $${p++}`); params.push(Number(duration_minutes)); }

    // If day_of_week or start_time changes, recompute next_run_at
    const newDow = day_of_week !== undefined ? Number(day_of_week) : row.day_of_week;
    const newTime = start_time !== undefined ? start_time : row.start_time;
    if (day_of_week !== undefined) { updates.push(`day_of_week = $${p++}`); params.push(newDow); }
    if (start_time !== undefined) { updates.push(`start_time = $${p++}`); params.push(newTime); }
    if (day_of_week !== undefined || start_time !== undefined) {
      const nextRun = computeNextRun(newDow, newTime, null);
      updates.push(`next_run_at = $${p++}`);
      params.push(nextRun);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(id, req.companyId);
    const r = await query(
      `UPDATE rachio_schedules SET ${updates.join(', ')} WHERE id = $${p++} AND company_id = $${p++} RETURNING *`,
      params
    );
    res.json({ schedule: r.rows[0] });
  } catch (err) {
    console.error('PATCH /ground-control/schedules/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /schedules/:id
router.delete('/schedules/:id', requireGControl, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query(
      `DELETE FROM rachio_schedules WHERE id = $1 AND company_id = $2 RETURNING id`,
      [id, req.companyId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /ground-control/schedules/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Given a day_of_week (0=Sun..6=Sat), start_time ('HH:MM'), and optional start_date (ISO date string),
 * compute the next Date when this should fire.
 * If start_date is provided and >= today, we search from that date.
 */
function computeNextRun(dayOfWeek, startTime, startDate) {
  const [hour, minute] = startTime.split(':').map(Number);
  const now = new Date();

  // Start searching from startDate or today, whichever is later
  let base = new Date();
  if (startDate) {
    const sd = new Date(startDate + 'T00:00:00');
    if (sd > now) base = sd;
  }

  // Find the next occurrence of dayOfWeek on or after base
  const candidate = new Date(base);
  candidate.setHours(hour, minute, 0, 0);

  // Advance day-by-day until we land on the right day of week
  // and the time is in the future
  let iterations = 0;
  while (iterations < 14) {
    if (candidate.getDay() === dayOfWeek && candidate > now) {
      return candidate;
    }
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hour, minute, 0, 0);
    iterations++;
  }

  return candidate;
}

// ── Home Assistant ─────────────────────────────────────────────────────────────

async function getHAConfig(companyId) {
  const r = await query(
    `SELECT ha_url, ha_token FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  const row = r.rows[0] || {};
  const url = (row.ha_url?.trim() || process.env.HA_URL || 'http://localhost:8123').replace(/\/+$/, '');
  const token = row.ha_token?.trim() || process.env.HA_TOKEN || null;
  return { url, token };
}

async function haFetch(url, token, path, options = {}) {
  if (!token) throw Object.assign(new Error('Home Assistant token not configured — add it in Settings → Integrations'), { status: 503 });
  const res = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`HA API error ${res.status}: ${text}`), { status: res.status });
  }
  return res.json();
}

// GET /ha/states — return lights, switches, and climate entities
router.get('/ha/states', requireGControl, async (req, res) => {
  try {
    const { url, token } = await getHAConfig(req.companyId);
    const states = await haFetch(url, token, '/api/states');
    const entities = states.filter((s) =>
      s.entity_id.startsWith('light.') ||
      s.entity_id.startsWith('switch.') ||
      s.entity_id.startsWith('climate.')
    );
    res.json({ entities });
  } catch (err) {
    console.error('GET /ground-control/ha/states error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /ha/service — call a HA service { domain, service, data }
router.post('/ha/service', requireGControl, async (req, res) => {
  try {
    const { domain, service, data = {} } = req.body;
    if (!domain || !service) {
      return res.status(400).json({ error: 'domain and service are required' });
    }
    const { url, token } = await getHAConfig(req.companyId);
    const result = await haFetch(url, token, `/api/services/${domain}/${service}`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    res.json({ ok: true, result });
  } catch (err) {
    console.error('POST /ground-control/ha/service error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export const groundControlRouter = router;
export { rachioFetch, rachioHeaders };
