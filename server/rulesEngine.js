/**
 * Categorization rules engine.
 * Applies company-defined rules after AI suggestions, in priority order.
 * First matching rule wins.
 */

/**
 * Apply rules to a single line item.
 *
 * @param {object} item      - { description, qbo_account_id, qbo_class_id, ... }
 * @param {string} vendor    - e.g. "Amazon"
 * @param {Array}  rules     - from DB, sorted by priority ASC
 * @param {Array}  accounts  - all qbo_accounts for this company
 * @returns {{ qbo_account_id, qbo_class_id, rule_applied: string|null }}
 */
export function applyRules(item, vendor, rules, accounts) {
  const desc = (item.description || '').toLowerCase();
  const vendorLower = (vendor || '').toLowerCase();

  // Look up the account type of the AI's suggestion
  const suggestedAccount = accounts.find((a) => a.qbo_id === item.qbo_account_id);
  const suggestedAccountType = (suggestedAccount?.account_type || '').toLowerCase();

  let result = {
    qbo_account_id: item.qbo_account_id,
    qbo_class_id: item.qbo_class_id,
    rule_applied: null,
  };

  for (const rule of rules) {
    if (!rule.active) continue;

    let matches = true;

    // IF description contains
    if (rule.if_description_contains) {
      if (!desc.includes(rule.if_description_contains.toLowerCase())) {
        matches = false;
      }
    }

    // IF vendor is
    if (matches && rule.if_vendor) {
      if (vendorLower !== rule.if_vendor.toLowerCase()) {
        matches = false;
      }
    }

    // IF AI-suggested account type contains
    if (matches && rule.if_account_type_contains) {
      if (!suggestedAccountType.includes(rule.if_account_type_contains.toLowerCase())) {
        matches = false;
      }
    }

    if (!matches) continue;

    // Apply action
    if (rule.then_clear) {
      result.qbo_account_id = null;
      result.qbo_class_id = null;
    }
    if (rule.then_account_id) result.qbo_account_id = rule.then_account_id;
    if (rule.then_class_id)   result.qbo_class_id   = rule.then_class_id;
    result.rule_applied = rule.name;
    break; // first match wins
  }

  return result;
}

/**
 * Build a plain-English summary of all active rules to inject into the AI prompt.
 */
export function buildRulesPrompt(rules) {
  const active = rules.filter((r) => r.active);
  if (!active.length) return '';

  const lines = active.map((r) => {
    const conditions = [];
    if (r.if_description_contains) conditions.push(`description contains "${r.if_description_contains}"`);
    if (r.if_vendor)               conditions.push(`vendor is "${r.if_vendor}"`);
    if (r.if_account_type_contains) conditions.push(`suggested account type contains "${r.if_account_type_contains}"`);

    const actions = [];
    if (r.then_clear)      actions.push('clear the account/class suggestion');
    if (r.then_account_id) actions.push(`use account ID ${r.then_account_id}`);
    if (r.then_class_id)   actions.push(`use class ID ${r.then_class_id}`);

    return `- Rule "${r.name}": IF ${conditions.join(' AND ')} → THEN ${actions.join(' AND ')}`;
  });

  return `\nBusiness rules (MUST follow — these override your judgment):\n${lines.join('\n')}`;
}
