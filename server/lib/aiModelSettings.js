import { query } from '../db.js';

/**
 * Loads model preference for a specific process, falls back to default.
 *
 * @param {string} companyId
 * @param {string} processKey
 * @param {string} defaultModel
 * @returns {Promise<string>}
 */
export async function getModelForProcess(companyId, processKey, defaultModel) {
  try {
    const r = await query(
      `SELECT model FROM ai_model_settings WHERE company_id = $1 AND process_key = $2`,
      [companyId, processKey]
    );
    return r.rows[0]?.model || defaultModel;
  } catch {
    return defaultModel;
  }
}
