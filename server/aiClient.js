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
