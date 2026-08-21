/**
 * The permissions matrix — /api/permissions
 *
 * Reading is open to anyone who already does user admin (users.assist), so a
 * manager can see who holds what. Writing needs users.manage, which only the
 * owner has. See docs/PERMISSIONS.md.
 */
import express from 'express';
import { query } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import {
  CAPABILITIES, CONTAINERS, PRESETS, ALL_CAPABILITIES,
  capabilitiesForRole, isCustomized,
} from '../lib/capabilities.js';

const router = express.Router();

/** The catalogue the screen renders. Served rather than duplicated client-side
 *  so the checkboxes can never drift from what the server actually enforces. */
router.get('/catalog', requireCapability('users.assist'), (_req, res) => {
  res.json({
    capabilities: CAPABILITIES,
    containers: CONTAINERS,
    presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, [...v]])),
    roles: Object.keys(PRESETS),
  });
});

/** Everyone, with their grants — one query rather than one per person. */
router.get('/users', requireCapability('users.assist'), async (req, res) => {
  const users = (await query(
    `SELECT id, display_name, email, role FROM users WHERE company_id = $1 ORDER BY display_name`,
    [req.companyId]
  )).rows;

  const grants = (await query(
    `SELECT c.user_id, c.capability FROM user_capabilities c
     JOIN users u ON u.id = c.user_id WHERE u.company_id = $1`,
    [req.companyId]
  )).rows;

  const byUser = new Map();
  for (const g of grants) {
    if (!byUser.has(g.user_id)) byUser.set(g.user_id, []);
    byUser.get(g.user_id).push(g.capability);
  }

  res.json({
    users: users.map((u) => {
      const held = byUser.get(u.id) || [];
      return {
        ...u,
        capabilities: held,
        // A role no longer in PRESETS (the old gc/inventory) always reads as
        // customized, which is exactly right — it is not one of the five.
        customized: !PRESETS[u.role] || isCustomized(u.role, held),
      };
    }),
  });
});

/**
 * Set a person's role and/or grants. Owner only.
 *
 * Sending `role` alone stamps that preset. Sending `capabilities` sets them
 * exactly. Sending both stamps the preset and then applies the capabilities on
 * top, which is what the screen does when you pick a role and then tick
 * something extra before saving.
 */
router.put('/users/:userId', requireCapability('users.manage'), async (req, res) => {
  const { userId } = req.params;
  const { role, capabilities } = req.body;

  const target = (await query(
    `SELECT id, role FROM users WHERE id = $1 AND company_id = $2`,
    [userId, req.companyId]
  )).rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (role !== undefined && !PRESETS[role]) {
    return res.status(400).json({ error: `Unknown role: ${role}` });
  }

  let next = capabilities !== undefined
    ? capabilities
    : capabilitiesForRole(role ?? target.role);

  if (!Array.isArray(next)) return res.status(400).json({ error: 'capabilities must be an array' });

  const unknown = next.filter((c) => !ALL_CAPABILITIES.includes(c));
  if (unknown.length) return res.status(400).json({ error: `Unknown capabilities: ${unknown.join(', ')}` });

  // Don't let the last way back in be taken away. Removing users.manage from
  // yourself, or from the only person who has it, leaves nobody able to grant
  // it back and the matrix can only be repaired in the database.
  if (!next.includes('users.manage')) {
    const holders = (await query(
      `SELECT c.user_id FROM user_capabilities c JOIN users u ON u.id = c.user_id
       WHERE u.company_id = $1 AND c.capability = 'users.manage'`,
      [req.companyId]
    )).rows.map((r) => r.user_id);
    if (holders.includes(userId) && holders.length <= 1) {
      return res.status(400).json({
        error: 'This is the only account that can manage permissions. Grant it to someone else first.',
      });
    }
  }

  next = [...new Set(next)];

  // Replace wholesale inside one statement pair, so a half-applied set can
  // never be what someone is left holding.
  await query('BEGIN');
  try {
    if (role !== undefined) {
      await query(`UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`, [role, userId]);
    }
    await query(`DELETE FROM user_capabilities WHERE user_id = $1`, [userId]);
    for (const cap of next) {
      await query(
        `INSERT INTO user_capabilities (user_id, company_id, capability, granted_by)
         VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, capability) DO NOTHING`,
        [userId, req.companyId, cap, req.userId]
      );
    }
    await query('COMMIT');
  } catch (err) {
    await query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  }

  const finalRole = role ?? target.role;
  res.json({
    ok: true,
    user: {
      id: userId,
      role: finalRole,
      capabilities: next,
      customized: !PRESETS[finalRole] || isCustomized(finalRole, next),
    },
  });
});

export { router as permissionsRouter };
