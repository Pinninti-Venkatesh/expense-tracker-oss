import logger from '../utils/logger.js';
import { buildFewShot } from '../learning/corrections.js';
import { callForJson } from './client.js';
import { reviewFields } from './review.js';

export const CATEGORIES = [
  'Food', 'Groceries', 'Shopping', 'Travel', 'Entertainment',
  'Bills', 'Health', 'Education', 'Electronics', 'Fuel',
  'Rent', 'Insurance', 'Subscriptions', 'General',
];

const SCHEMA = {
  type: 'object',
  properties: {
    isTransaction: {
      type: 'boolean',
      description: 'True only if this email reports a completed spend on a card or account.',
    },
    amount: { type: ['number', 'null'] },
    currency: {
      type: ['string', 'null'],
      description: 'ISO 4217 code of the currency the amount is in, e.g. INR, USD, EUR. INR when in rupees.',
    },
    merchant: { type: ['string', 'null'] },
    bank: { type: ['string', 'null'] },
    cardLast4: { type: ['string', 'null'] },
    paymentType: { type: ['string', 'null'], description: 'Credit Card | Debit Card | UPI | Net Banking' },
    category: { type: ['string', 'null'], description: `One of: ${CATEGORIES.join(', ')}` },
    categorySure: {
      type: 'boolean',
      description: 'False when the email leaves real doubt between two categories, e.g. an Amazon charge with no item names. True otherwise.',
    },
    otherCategory: {
      type: ['string', 'null'],
      description: 'When categorySure is false, the next most likely category from the same list. Otherwise null.',
    },
    reasoning: { type: 'string', description: 'One short sentence on why you classified it this way.' },
  },
  required: [
    'isTransaction', 'amount', 'currency', 'merchant', 'bank', 'cardLast4', 'paymentType',
    'category', 'categorySure', 'otherCategory', 'reasoning',
  ],
  additionalProperties: false,
};

function buildPrompt({ sender, subject, body, corrections, categories = CATEGORIES }) {
  return `You are analysing an email to decide whether it records a credit card or bank transaction, and if so to extract the details. Report your answer by calling record_transaction.

EMAIL
From: ${sender}
Subject: ${subject}
Body:
${body.slice(0, 4000)}

RULES
- Set isTransaction to true ONLY for a completed spend. Refunds, cashback, reversals, OTPs, bill reminders, statements, promotional offers, reward-point notices and failed or declined transactions are all false.
- amount: a number with no commas or currency symbol, in the currency the merchant billed.
- amount and currency MUST describe the SAME figure. Never report one number and label it with the other currency.
- currency: an international alert usually shows BOTH the amount the merchant billed (e.g. "USD 23.60") AND the rupees actually debited (e.g. "INR 2,352.57"). When both appear, report the RUPEE figure and set currency to "INR" — that is what the card was charged. Only use a foreign code when the email gives no rupee amount at all. A foreign-sounding merchant is never on its own a reason to say USD.
- merchant: clean and human-readable. Strip city and country codes ("ZEPTO BANGALORE IN" -> "Zepto"), payment-rail prefixes ("UPI_DAALCHINI" -> "Daalchini") and trailing reference numbers.
- bank: short form, e.g. "HDFC", "ICICI", "SBI", "Yes Bank".
- cardLast4: the last four digits if present ("XX1234", "ending 1234", "card **1234"), otherwise null.
- paymentType: the instrument the email says was charged, NOT the rail. If the email says the credit card was charged, it is "Credit Card" even when the merchant string starts with "UPI_".
- category: choose exactly one of: ${categories.join(', ')}. Use "Groceries" for daily essentials, "Food" for restaurants and prepared-food delivery, "Subscriptions" for recurring digital services, "Bills" for utilities and recharges. Use "General" only when nothing else fits.
- categorySure: false only when two categories are genuinely plausible and the email can't settle it, such as a marketplace charge with no items named. Then give the runner-up as otherCategory. A merchant that sells one kind of thing is sure.
- If isTransaction is false, set every other field to null except reasoning, and set categorySure to true.${buildFewShot(corrections)}`;
}

/** Models occasionally return "2,352.57" as a string despite the schema. */
function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Returns extracted transaction fields, or null when the model determined the
 * email is not a spend.
 *
 * IMPORTANT: null means "the model decided this is not a transaction". It must
 * never mean "we failed to ask". Infrastructure failures — credentials, rate
 * limits, network, a missing tool call — THROW (see client.js), because the
 * caller marks emails processed on a null and would otherwise silently discard
 * real transactions with no way to recover them.
 */
export async function extractTransaction({ sender, subject, body, corrections = [], categories = CATEGORIES }) {
  const parsed = await callForJson({
    prompt: buildPrompt({ sender, subject, body, corrections, categories }),
    schema: SCHEMA,
    toolName: 'record_transaction',
    description: 'Record whether this email is a completed spend and, if so, its details.',
  });

  if (!parsed.isTransaction) return null;

  const amount = toNumber(parsed.amount);
  if (amount === null || amount <= 0 || !parsed.merchant) {
    logger.warn('Model flagged a transaction but omitted a usable amount or merchant');
    return null;
  }

  const category = categories.find((c) => c.toLowerCase() === String(parsed.category || '').toLowerCase()) || 'General';

  return {
    amount,
    currency: String(parsed.currency || 'INR').toUpperCase(),
    merchant: String(parsed.merchant).trim(),
    bank: parsed.bank || 'Unknown',
    cardLast4: parsed.cardLast4 || null,
    paymentType: parsed.paymentType || 'Credit Card',
    category,
    categorySource: 'llm',
    ...reviewFields(parsed, categories, category),
    reasoning: parsed.reasoning || null,
  };
}
