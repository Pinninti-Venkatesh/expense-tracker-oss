import config from './config.js';

/**
 * Foreign-currency charges. Bank alerts state the amount in the currency the
 * merchant billed (e.g. USD for Anthropic, ProctorU); the extractor used to
 * store that number as-is, so a $23.60 charge landed as ₹23.60. This converts a
 * foreign amount to the INR an ICICI card actually debits: reference-rate
 * conversion, plus the card's markup fee and GST on that fee.
 */

// Frankfurter is a free, key-less FX API (ECB reference rates) with historical
// lookups. Weekends/holidays resolve to the previous working day, which is what
// a card network would use for a weekend transaction anyway.
async function fetchRate(from, date) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : 'latest';
  const url = `https://api.frankfurter.app/${day}?from=${encodeURIComponent(from)}&to=INR`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FX lookup failed for ${from} on ${day} (HTTP ${res.status})`);
  const data = await res.json();
  const rate = data?.rates?.INR;
  if (!rate) throw new Error(`FX response carried no INR rate for ${from} on ${day}`);
  return rate;
}

/**
 * Returns { inr, rate, note } for `amount` of `currency` charged on `date`
 * (YYYY-MM-DD). Throws if the rate can't be fetched — the caller decides how to
 * degrade rather than silently storing a foreign number as rupees.
 */
export async function convertToInr(amount, currency, date) {
  const rate = await fetchRate(currency, date);
  const base = amount * rate;
  const { markupPct, gstOnMarkupPct } = config.forex;
  const markup = base * (markupPct / 100);
  const gst = markup * (gstOnMarkupPct / 100);
  const inr = Math.round((base + markup + gst) * 100) / 100;

  const note =
    `Billed in ${currency} ${amount.toFixed(2)}. Converted to INR at ` +
    `1 ${currency} ≈ ₹${rate.toFixed(2)} (${date}) + ${markupPct}% markup + ` +
    `${gstOnMarkupPct}% GST on markup → ≈₹${inr.toLocaleString('en-IN')}.`;

  return { inr, rate, note };
}

/**
 * Whether the email itself states `amount` as rupees.
 *
 * Guards a specific, expensive failure: the extractor sometimes reports the
 * INR figure from an international-transaction alert while tagging the currency
 * as the merchant's (both statements are individually true, but combined they
 * mean the amount gets converted a second time — a $23.60 charge became
 * ₹2,33,679). If the body says "INR 2,352.57" / "Rs 2352.57" / "₹2,352.57",
 * the amount is already rupees and must not be converted again.
 */
export function statedInInr(body, amount) {
  const text = String(body || '');
  const n = Number(amount);
  if (!text || !Number.isFinite(n)) return false;

  const forms = new Set([
    n.toFixed(2),
    String(n),
    n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    n.toLocaleString('en-IN'),
  ]);

  for (const form of forms) {
    const esc = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // "INR 2,352.57", "Rs. 2352.57", "₹ 2,352.57" — symbol immediately before.
    if (new RegExp(`(?:INR|RS\\.?|₹)\\s*${esc}\\b`, 'i').test(text)) return true;
  }
  return false;
}
