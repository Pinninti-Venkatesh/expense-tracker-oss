import logger from '../utils/logger.js';
import { callForJson } from './client.js';

const SCHEMA = {
  type: 'object',
  properties: {
    isOrder: {
      type: 'boolean',
      description: 'True if this email describes a specific purchase, order or booking.',
    },
    summary: {
      type: ['string', 'null'],
      description: 'One line, under 100 chars, naming what was bought.',
    },
    items: {
      type: 'array',
      items: { type: 'string' },
      description: 'Individual items or dishes, each with quantity if stated. Empty if unknown.',
    },
  },
  required: ['isOrder', 'summary', 'items'],
  additionalProperties: false,
};

/**
 * Reads a merchant's order-confirmation email and describes what was actually
 * bought. Throws on infrastructure failure so the caller can retry; returns
 * null only when the email genuinely isn't an order.
 */
export async function summarizeOrderEmail({ subject, body, merchant }) {
  const prompt = `This is an email from ${merchant}. If it confirms a specific purchase, order, or booking, describe exactly what was bought, then call record_order.

EMAIL
Subject: ${subject}
Body:
${body.slice(0, 6000)}

RULES
- isOrder is false for marketing, offers, newsletters, delivery-status-only updates, password resets, or anything without concrete purchased items.
- items: list what was actually bought. Include quantity when the email states it, e.g. "Butter Naan x2". For clothing include the product name, e.g. "Men's Blue Slim Fit Jeans". Do not invent items that are not in the email.
- summary: one natural line describing the purchase, e.g. "Butter chicken, 2 naan and dal makhani" or "3 items: jeans, t-shirt, socks". Under 100 characters. No amounts, no order numbers.
- For a cab or travel booking, state the route or destination.
- If it is an order but you cannot tell what was in it, set isOrder true, summary null and items empty.`;

  const parsed = await callForJson({
    prompt,
    schema: SCHEMA,
    toolName: 'record_order',
    description: 'Record what this email says was bought.',
  });

  if (!parsed.isOrder) {
    logger.debug(`Not an order email from ${merchant}`);
    return null;
  }

  const items = Array.isArray(parsed.items) ? parsed.items.filter(Boolean).map(String).slice(0, 25) : [];
  const summary = (typeof parsed.summary === 'string' && parsed.summary.trim()) || (items.length ? items.slice(0, 3).join(', ') : null);
  if (!summary && !items.length) return null;

  return { summary, items };
}
