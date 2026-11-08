import { callForJson } from './client.js';

const SCHEMA = {
  type: 'object',
  properties: {
    documentType: {
      type: 'string',
      enum: ['bank_account', 'credit_card', 'other'],
      description: 'What kind of statement these lines come from.',
    },
    debits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer', description: 'The L number of the line where this transaction row begins.' },
          date: { type: 'string', description: 'Transaction date as YYYY-MM-DD.' },
          amount: { type: 'number', description: 'The amount that left the account, copied exactly as printed, without commas.' },
          description: { type: 'string', description: 'The narration or particulars, as printed.' },
          reference: { type: ['string', 'null'], description: 'The reference, UTR or cheque number if printed on the row, else null.' },
          balance: { type: ['number', 'null'], description: 'The balance printed after this transaction, else null.' },
        },
        required: ['line', 'date', 'amount', 'description', 'reference', 'balance'],
        additionalProperties: false,
      },
    },
  },
  required: ['documentType', 'debits'],
  additionalProperties: false,
};

/**
 * Asks the model for the debits in one slice of a statement's transaction table.
 * `rows` are { index, text } from generic.js; the answer is checked there, row
 * by row, before anything is saved. Throws on infrastructure failure.
 */
export async function readStatementChunk(rows, { year }) {
  const listing = rows.map((r) => `L${r.index}: ${r.text}`).join('\n');

  const prompt = `These numbered lines were extracted as text from a PDF bank statement. Columns may have run together.

LINES
${listing}

RULES
- List every transaction where money LEFT the account: withdrawals, debits, UPI and card payments, transfers out, ATM cash, EMIs, charges and fees.
- Skip deposits and credits, opening and closing balances, totals, interest earned, and anything that is not a transaction row.
- When a row has separate withdrawal and deposit columns, a debit has a value in the withdrawal column. When a row has one amount marked Dr or Cr, only Dr rows are debits.
- amount must be copied from the statement exactly. Never calculate it.
- line is the L number where the row begins. Narration continued on the following lines belongs to that row.
- date: convert to YYYY-MM-DD. If a date has no year, use ${year}.
- If these lines are from a credit card statement, or are not a bank account statement at all, set documentType to match and return no debits.
Call record_debits.`;

  return callForJson({
    prompt,
    schema: SCHEMA,
    toolName: 'record_debits',
    description: 'Record the money that left the account in these statement lines.',
    maxTokens: 8000,
  });
}
