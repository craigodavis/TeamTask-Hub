/**
 * Categorization rules engine.
 * Applies company-defined rules after AI suggestions, in priority order.
 * First matching rule wins.
 *
 * Description expressions support full boolean logic:
 *   food AND storage
 *   food OR container
 *   food AND (label OR container)
 *   (cleaning OR sanitizer) AND supply
 *   Space-separated words are implicitly AND'd: "food storage" = "food AND storage"
 */

// ── Boolean expression parser ─────────────────────────────────────────────────

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) { i++; continue; }
    if (expr[i] === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
    if (expr[i] === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }
    let word = '';
    while (i < expr.length && !/[\s()]/.test(expr[i])) word += expr[i++];
    const up = word.toUpperCase();
    if (up === 'AND') tokens.push({ type: 'AND' });
    else if (up === 'OR') tokens.push({ type: 'OR' });
    else tokens.push({ type: 'WORD', value: word.toLowerCase() });
  }
  return tokens;
}

class Parser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; }
  peek()    { return this.tokens[this.pos]; }
  consume() { return this.tokens[this.pos++]; }
  parse()   { return this.parseOr(); }

  parseOr() {
    let left = this.parseAnd();
    while (this.peek()?.type === 'OR') {
      this.consume();
      left = { type: 'OR', left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd() {
    let left = this.parsePrimary();
    if (!left) return null;
    while (true) {
      const tok = this.peek();
      if (!tok || tok.type === 'OR' || tok.type === 'RPAREN') break;
      if (tok.type === 'AND') this.consume(); // explicit AND keyword
      // else implicit AND (consecutive words or groups)
      const right = this.parsePrimary();
      if (!right) break;
      left = { type: 'AND', left, right };
    }
    return left;
  }

  parsePrimary() {
    const tok = this.peek();
    if (!tok) return null;
    if (tok.type === 'WORD') { this.consume(); return { type: 'TERM', value: tok.value }; }
    if (tok.type === 'LPAREN') {
      this.consume();
      const node = this.parseOr();
      if (this.peek()?.type === 'RPAREN') this.consume();
      return node;
    }
    return null;
  }
}

function evaluate(node, text) {
  if (!node) return true;
  switch (node.type) {
    case 'TERM': return text.includes(node.value);
    case 'AND':  return evaluate(node.left, text) && evaluate(node.right, text);
    case 'OR':   return evaluate(node.left, text) || evaluate(node.right, text);
    default:     return false;
  }
}

/**
 * Test a description expression against a product description string.
 * Falls back to simple substring match if the expression can't be parsed.
 */
function matchesExpr(expr, description) {
  if (!expr?.trim()) return true;
  const text = description.toLowerCase();
  try {
    const tokens = tokenize(expr);
    if (!tokens.length) return true;
    const ast = new Parser(tokens).parse();
    return evaluate(ast, text);
  } catch {
    return text.includes(expr.toLowerCase());
  }
}

// ── Rule application ──────────────────────────────────────────────────────────

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
  const vendorLower = (vendor || '').toLowerCase();
  const suggestedAccount = accounts.find((a) => a.qbo_id === item.qbo_account_id);
  const suggestedAccountType = (suggestedAccount?.account_type || '').toLowerCase();

  let result = {
    qbo_account_id: item.qbo_account_id,
    qbo_class_id:   item.qbo_class_id,
    rule_applied:   null,
  };

  for (const rule of rules) {
    if (!rule.active) continue;

    let matches = true;

    // IF description expression
    if (rule.if_description_contains) {
      if (!matchesExpr(rule.if_description_contains, item.description || '')) matches = false;
    }

    // IF vendor is — substring match so "Amazon" matches "Amazon Business", "Amazon.com", etc.
    if (matches && rule.if_vendor) {
      if (!vendorLower.includes(rule.if_vendor.toLowerCase())) matches = false;
    }

    // IF AI-suggested account type contains
    if (matches && rule.if_account_type_contains) {
      if (!suggestedAccountType.includes(rule.if_account_type_contains.toLowerCase())) matches = false;
    }

    if (!matches) continue;

    // Apply actions
    if (rule.then_clear) { result.qbo_account_id = null; result.qbo_class_id = null; }
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
    const conds = [];
    if (r.if_description_contains) conds.push(`description matches "${r.if_description_contains}"`);
    if (r.if_vendor)                conds.push(`vendor is "${r.if_vendor}"`);
    if (r.if_account_type_contains) conds.push(`suggested account type contains "${r.if_account_type_contains}"`);
    const acts = [];
    if (r.then_clear)       acts.push('clear the account/class suggestion');
    if (r.then_account_id)  acts.push(`use account ID ${r.then_account_id}`);
    if (r.then_class_id)    acts.push(`use class ID ${r.then_class_id}`);
    return `- Rule "${r.name}": IF ${conds.join(' AND ') || '(any)'} → THEN ${acts.join(' AND ')}`;
  });
  return `\nBusiness rules (MUST follow — these override your judgment):\n${lines.join('\n')}`;
}
