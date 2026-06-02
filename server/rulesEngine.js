/**
 * Categorization rules engine.
 * Applies company-defined rules after AI suggestions, in priority order.
 * First matching rule wins.
 *
 * Two rule types:
 *   1. Text rules: if_description_contains, if_vendor, if_account_type_contains (fast, no AI cost)
 *   2. AI condition rules: is_ai_rule=true, ai_condition = natural language question Claude evaluates
 *
 * Description expressions support full boolean logic:
 *   food AND storage
 *   food OR container
 *   food AND (label OR container)
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
      if (tok.type === 'AND') this.consume();
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

// ── AI condition evaluation ───────────────────────────────────────────────────

/**
 * Ask Claude whether an item description matches an AI condition rule.
 * Batches multiple AI rules into a single API call for efficiency.
 *
 * @param {string}   description  - item description
 * @param {Array}    aiRules      - rules with is_ai_rule=true and ai_condition
 * @param {Function} getClient    - returns an Anthropic client
 * @returns {Array}  matched AI rules
 */
async function evaluateAiRules(description, aiRules, getClient) {
  if (!aiRules.length) return [];
  try {
    const client = getClient();
    const conditions = aiRules.map((r, i) => `${i + 1}. ${r.ai_condition}`).join('\n');
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `For this product description, answer YES or NO for each question. Return ONLY a JSON array of booleans in order.

Product: "${description}"

Questions:
${conditions}`,
      }],
    });
    const raw = msg.content[0].text.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const answers = JSON.parse(raw);
    return aiRules.filter((_, i) => answers[i] === true);
  } catch {
    return []; // graceful fallback — don't block categorization on AI rule failure
  }
}

// ── Rule application ──────────────────────────────────────────────────────────

/**
 * Apply text-only rules to a single line item (synchronous, no AI cost).
 */
export function applyRules(item, vendor, rules, accounts) {
  const vendorLower      = (vendor || '').toLowerCase();
  const suggestedAccount = accounts.find((a) => a.qbo_id === item.qbo_account_id);
  const suggestedType    = (suggestedAccount?.account_type || '').toLowerCase();

  const result = {
    qbo_account_id: item.qbo_account_id,
    qbo_class_id:   item.qbo_class_id,
    rule_applied:   null,
  };

  for (const rule of rules) {
    if (!rule.active || rule.is_ai_rule) continue; // skip AI rules here

    let matches = true;
    if (rule.if_description_contains && !matchesExpr(rule.if_description_contains, item.description || '')) matches = false;
    if (matches && rule.if_vendor && !vendorLower.includes(rule.if_vendor.toLowerCase())) matches = false;
    if (matches && rule.if_account_type_contains && !suggestedType.includes(rule.if_account_type_contains.toLowerCase())) matches = false;
    if (!matches) continue;

    if (rule.then_clear) { result.qbo_account_id = null; result.qbo_class_id = null; }
    if (rule.then_account_id) result.qbo_account_id = rule.then_account_id;
    if (rule.then_class_id)   result.qbo_class_id   = rule.then_class_id;
    result.rule_applied = rule.name;
    break;
  }

  return result;
}

/**
 * Apply ALL rules (text + AI) to a single item. Async because AI rules need API calls.
 * AI rules run first (highest priority), then text rules.
 */
export async function applyRulesAsync(item, vendor, rules, accounts, getClient) {
  const vendorLower      = (vendor || '').toLowerCase();
  const suggestedAccount = accounts.find((a) => a.qbo_id === item.qbo_account_id);
  const suggestedType    = (suggestedAccount?.account_type || '').toLowerCase();

  const result = {
    qbo_account_id: item.qbo_account_id,
    qbo_class_id:   item.qbo_class_id,
    rule_applied:   null,
  };

  const activeRules = rules.filter((r) => r.active).sort((a, b) => a.priority - b.priority);

  // Phase 1: AI condition rules (batched into one API call per item)
  const aiRules = activeRules.filter((r) => r.is_ai_rule && r.ai_condition);
  if (aiRules.length && getClient) {
    const matched = await evaluateAiRules(item.description || '', aiRules, getClient);
    if (matched.length) {
      const rule = matched[0]; // first matching AI rule wins
      if (rule.then_clear) { result.qbo_account_id = null; result.qbo_class_id = null; }
      if (rule.then_account_id) result.qbo_account_id = rule.then_account_id;
      if (rule.then_class_id)   result.qbo_class_id   = rule.then_class_id;
      result.rule_applied = rule.name;
      return result; // AI rule matched — done
    }
  }

  // Phase 2: Text rules
  const textRules = activeRules.filter((r) => !r.is_ai_rule);
  for (const rule of textRules) {
    let matches = true;
    if (rule.if_description_contains && !matchesExpr(rule.if_description_contains, item.description || '')) matches = false;
    if (matches && rule.if_vendor && !vendorLower.includes(rule.if_vendor.toLowerCase())) matches = false;
    if (matches && rule.if_account_type_contains && !suggestedType.includes(rule.if_account_type_contains.toLowerCase())) matches = false;
    if (!matches) continue;

    if (rule.then_clear) { result.qbo_account_id = null; result.qbo_class_id = null; }
    if (rule.then_account_id) result.qbo_account_id = rule.then_account_id;
    if (rule.then_class_id)   result.qbo_class_id   = rule.then_class_id;
    result.rule_applied = rule.name;
    break;
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
    if (r.is_ai_rule) {
      const acts = [];
      if (r.then_account_id) acts.push(`use account ID ${r.then_account_id}`);
      if (r.then_class_id)   acts.push(`use class ID ${r.then_class_id}`);
      return `- AI Rule "${r.name}": IF "${r.ai_condition}" → THEN ${acts.join(' AND ')}`;
    }
    const conds = [];
    if (r.if_description_contains) conds.push(`description matches "${r.if_description_contains}"`);
    if (r.if_vendor)                conds.push(`vendor is "${r.if_vendor}"`);
    if (r.if_account_type_contains) conds.push(`suggested account type contains "${r.if_account_type_contains}"`);
    const acts = [];
    if (r.then_clear)      acts.push('clear the account/class suggestion');
    if (r.then_account_id) acts.push(`use account ID ${r.then_account_id}`);
    if (r.then_class_id)   acts.push(`use class ID ${r.then_class_id}`);
    return `- Rule "${r.name}": IF ${conds.join(' AND ') || '(any)'} → THEN ${acts.join(' AND ')}`;
  });
  return `\nBusiness rules (MUST follow — these override your judgment):\n${lines.join('\n')}`;
}
