/**
 * AI helpers using the Anthropic Claude API.
 * Used for: PDF receipt extraction, line-item categorization.
 */
import Anthropic from '@anthropic-ai/sdk';

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}

/**
 * Extract structured receipt data from raw PDF text.
 * Returns: { order_number, order_date, vendor, subtotal, tax, total, items[] }
 */
export async function extractReceiptData(pdfText) {
  const client = getClient();

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `You are a receipt parser. Extract structured data from this Amazon order PDF text and return ONLY valid JSON — no markdown, no explanation.

The JSON must have this shape:
{
  "order_number": "string or null",
  "order_date": "YYYY-MM-DD or null",
  "vendor": "Amazon",
  "subtotal": number or null,
  "tax": number or null,
  "total": number or null,
  "card_last4": "last 4 digits of payment card as a string, or null",
  "payment_instrument": "Visa, Mastercard, Amex, etc. or null",
  "items": [
    {
      "description": "product name/description",
      "quantity": number,
      "unit_price": number or null,
      "total": number or null
    }
  ]
}

PDF text:
${pdfText}`,
      },
    ],
  });

  const raw = message.content[0].text.trim();
  // Strip markdown code fences if present
  const json = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(json);
}

/**
 * Suggest QBO account + class for each line item.
 * Uses product memory and available accounts/classes as context.
 *
 * @param {Array} items        - Array of { description, total }
 * @param {Array} accounts     - Array of { qbo_id, name, fully_qualified_name, account_type }
 * @param {Array} classes      - Array of { qbo_id, name, fully_qualified_name }
 * @param {Array} memory       - Array of { product_pattern, qbo_account_id, qbo_class_id }
 * @returns {Array}            - Array of { description, qbo_account_id, qbo_class_id, confidence, reasoning }
 */
/**
 * Analyze user-made corrections to item categorizations and suggest rules.
 * @param {Array} corrections  [{description, total, old_account_id, new_account_id, new_class_id}]
 * @param {Array} accounts     All qbo_accounts for the company
 * @returns {Array}            Suggested rule objects (name, if_description_contains, then_account_id, ...)
 */
export async function suggestRulesFromCorrections(corrections, accounts) {
  if (!corrections.length) return [];
  const client = getClient();

  const accountMap = new Map(
    accounts.map((a) => [a.qbo_id, `${a.fully_qualified_name || a.name} [${a.classification || a.account_type || ''}]`])
  );

  const correctionLines = corrections.map((c, i) => {
    const oldName = c.old_account_id ? (accountMap.get(c.old_account_id) || c.old_account_id) : 'no account';
    const newName = c.new_account_id ? (accountMap.get(c.new_account_id) || c.new_account_id) : 'none';
    return `${i + 1}. "${c.description}"${c.total ? ` ($${c.total})` : ''}: was "${oldName}" → changed to "${newName}"${c.new_class_id ? ` / class ${c.new_class_id}` : ''}`;
  }).join('\n');

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `A user manually corrected account categorizations for Amazon purchase line items. Suggest categorization rules that will catch similar items automatically in the future.

Corrections made:
${correctionLines}

CRITICAL RULE-WRITING GUIDELINES:
- Write rules based on the PRODUCT CATEGORY, not the specific brand or model.
  Good: "printer" catches any printer. Bad: "Epson ET-2803" only catches that one model.
- Strip out model numbers, SKUs, version numbers, and dimensions entirely.
- Brand names are OK only when the brand itself defines the category (e.g. "Epson" for printers is borderline — prefer the generic term).
- Use broad category keywords: "printer", "ink", "luggage", "headphones", "cable", "cleaning supply", etc.
- Use OR to cover synonyms: "printer OR copier OR scanner"
- if_description_contains should match a wide range of similar products, not just the exact item corrected.
- Group corrections targeting the same account into a single rule when they share a product category.
- Use the EXACT account id strings from the corrections above.

Return ONLY a valid JSON array (no markdown). Each element:
{
  "name": "short category-level rule name (e.g. 'Printers & Scanners', not 'Epson ET-2803')",
  "if_description_contains": "generic category keyword(s) — e.g. 'printer OR scanner OR copier'",
  "then_account_id": "exact account id string from corrections",
  "then_class_id": "class id string or null",
  "priority": 50,
  "notes": "one sentence explaining the category this rule covers"
}

Return [] if no clear category pattern can be inferred.`,
    }],
  });

  const raw = message.content[0].text.trim();
  const json = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  try { return JSON.parse(json); } catch { return []; }
}

export async function categorizeLineItems(items, accounts, classes, memory, rulesPrompt = '') {
  if (!items.length) return [];

  const client = getClient();

  // Build compact references to keep the prompt small.
  // Format: id: Name [Classification > AccountType > SubType]
  // e.g.  123: Equipment [Asset > Fixed Asset > Other Fixed Assets]
  //        456: Equipment Rental [Expense > Expense > Other Misc Expense]
  const accountList = accounts
    .filter((a) => a.active)
    .map((a) => {
      const parts = [a.classification, a.account_type, a.account_sub_type]
        .filter(Boolean)
        .map((s) => s.replace(/([A-Z])/g, ' $1').trim()); // CamelCase → words
      const typeTag = parts.length ? ` [${parts.join(' > ')}]` : '';
      return `${a.qbo_id}: ${a.fully_qualified_name || a.name}${typeTag}`;
    })
    .join('\n');

  const classList = classes
    .filter((c) => c.active)
    .map((c) => `${c.qbo_id}: ${c.fully_qualified_name || c.name}`)
    .join('\n');

  const memoryContext = memory.length
    ? 'Previously categorized products (use these as strong hints):\n' +
      memory.map((m) => `- "${m.product_pattern}" → account ${m.qbo_account_id}, class ${m.qbo_class_id || 'none'}`).join('\n')
    : 'No prior categorization history.';

  const itemList = items.map((it, i) => `${i + 1}. ${it.description} ($${it.total ?? '?'})`).join('\n');

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are an accounting assistant helping categorize Amazon purchase line items for a winery's QuickBooks Online.
${rulesPrompt}
${memoryContext}

Available QBO Accounts (id: name [Classification > AccountType > SubType]):
Classification tells you whether an account hits the P&L (Revenue, Expense, Cost of Goods Sold) or the balance sheet (Asset, Liability, Equity).
Prefer Expense/COGS accounts for consumables, supplies, and small purchases.
Use Asset accounts only for capitalized equipment with a multi-year useful life.
${accountList}

Available QBO Classes (id: name):
${classList}

Line items to categorize:
${itemList}

IMPORTANT: Always assign the best-matching account for every item — never return null for qbo_account_id unless the account list above is completely empty. When unsure, pick the most plausible Expense account and set confidence low (0.2-0.4). A low-confidence suggestion is always more useful than null because the user can correct it.

Return ONLY a JSON array (no markdown) with one object per line item in the same order:
[
  {
    "qbo_account_id": "account id string — always provide a best guess; null only if no accounts exist",
    "qbo_class_id": "class id string or null if no good match",
    "confidence": 0.0-1.0,
    "reasoning": "one short sentence"
  }
]`,
      },
    ],
  });

  const raw = message.content[0].text.trim();
  const json = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  const suggestions = JSON.parse(json);

  // Zip back with original items
  return items.map((item, i) => ({
    description: item.description,
    ...(suggestions[i] || { qbo_account_id: null, qbo_class_id: null, confidence: 0, reasoning: '' }),
  }));
}
