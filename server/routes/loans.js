import express from 'express';
import logger from '../utils/logger.js';
import * as store from '../drive/store.js';
import { today } from '../utils/datetime.js';
import {
  LOAN_TYPES, RATE_TYPES, summariseAll, summariseLoan, computeEmi, defaultForeclosurePct,
  amortisationSchedule,
} from '../loans.js';

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const newLoanId = () => `loan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

/** Validates and normalises a loan payload. Throws with .status on bad input. */
function buildLoan(body, existing = null) {
  const bad = (msg) => { const e = new Error(msg); e.status = 400; throw e; };

  const name = String(body?.name ?? existing?.name ?? '').trim();
  if (!name) bad('Loan name is required');

  const type = LOAN_TYPES.some((t) => t.id === body?.type) ? body.type : (existing?.type || 'other');
  const rateType = RATE_TYPES.includes(body?.rateType) ? body.rateType : (existing?.rateType || 'fixed');

  const principal = Number(body?.principal ?? existing?.principal);
  if (!Number.isFinite(principal) || principal <= 0) bad('Loan amount must be a positive number');

  const annualRate = Number(body?.annualRate ?? existing?.annualRate);
  if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 60) bad('Interest rate must be between 0 and 60');

  const tenureMonths = Math.round(Number(body?.tenureMonths ?? existing?.tenureMonths));
  if (!Number.isFinite(tenureMonths) || tenureMonths <= 0 || tenureMonths > 480) {
    bad('Tenure must be between 1 and 480 months');
  }

  const startDate = String(body?.startDate ?? existing?.startDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) bad('Start date must be YYYY-MM-DD');

  // Lenders often bill on a fixed day that is not the disbursal day.
  const feRaw = body?.firstEmiDate ?? existing?.firstEmiDate;
  const firstEmiDate = feRaw ? String(feRaw) : null;
  if (firstEmiDate && !/^\d{4}-\d{2}-\d{2}$/.test(firstEmiDate)) {
    bad('First EMI date must be YYYY-MM-DD');
  }
  if (firstEmiDate && firstEmiDate < startDate) bad('The first EMI cannot fall before disbursal');

  // A lender-stated EMI is kept verbatim (bank rounding differs); otherwise derived.
  const emiRaw = body?.emi ?? existing?.emi;
  const emi = Number(emiRaw) > 0 ? Number(emiRaw) : null;

  const pctRaw = body?.foreclosurePct ?? existing?.foreclosurePct;
  const foreclosurePct = pctRaw == null || pctRaw === ''
    ? defaultForeclosurePct(rateType)
    : Number(pctRaw);
  if (!Number.isFinite(foreclosurePct) || foreclosurePct < 0 || foreclosurePct > 20) {
    bad('Foreclosure charge must be between 0 and 20 percent');
  }

  // Optional anchor: the balance the lender itself reports, which overrides the
  // projection from that date onward.
  const ovRaw = body?.outstandingOverride ?? existing?.outstandingOverride;
  const outstandingOverride = ovRaw == null || ovRaw === '' ? null : Number(ovRaw);
  if (outstandingOverride != null && (!Number.isFinite(outstandingOverride) || outstandingOverride < 0)) {
    bad('Current outstanding must be a positive number');
  }
  const asOfRaw = body?.outstandingAsOf ?? existing?.outstandingAsOf;
  const outstandingAsOf = asOfRaw ? String(asOfRaw) : null;
  if (outstandingAsOf && !/^\d{4}-\d{2}-\d{2}$/.test(outstandingAsOf)) {
    bad('Outstanding "as of" date must be YYYY-MM-DD');
  }
  if (outstandingOverride != null && !outstandingAsOf) {
    bad('Tell me the date that outstanding balance was read on');
  }

  return {
    id: existing?.id || newLoanId(),
    firstEmiDate,
    outstandingOverride,
    outstandingAsOf,
    name,
    lender: String(body?.lender ?? existing?.lender ?? '').trim() || null,
    type,
    rateType,
    principal: Math.round(principal * 100) / 100,
    annualRate,
    tenureMonths,
    startDate,
    emi,
    foreclosurePct,
    note: body?.note != null ? String(body.note).slice(0, 200) : (existing?.note || null),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: existing ? new Date().toISOString() : null,
  };
}

/** The whole tab: every loan with its computed position, plus portfolio totals. */
router.get('/loans', asyncRoute(async (req, res) => {
  const db = await store.init();
  res.json({
    ...summariseAll(db.loans || [], today()),
    types: LOAN_TYPES,
  });
}));

/** What-if preview: compute a loan's numbers without saving it. */
router.post('/loans/preview', asyncRoute(async (req, res) => {
  let loan;
  try {
    loan = buildLoan(req.body);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  res.json({ loan, computed: summariseLoan(loan, today()) });
}));

router.post('/loans', asyncRoute(async (req, res) => {
  let loan;
  try {
    loan = buildLoan(req.body);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  await store.mutate((d) => { d.loans ||= []; d.loans.push(loan); });
  logger.info(`Loan added: ${loan.name} ${loan.principal} @ ${loan.annualRate}% x ${loan.tenureMonths}m`);
  res.status(201).json({ ok: true, loan, computed: summariseLoan(loan, today()) });
}));

router.patch('/loans/:id', asyncRoute(async (req, res) => {
  const db = await store.init();
  const existing = (db.loans || []).find((l) => l.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such loan' });

  let updated;
  try {
    updated = buildLoan(req.body, existing);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  await store.mutate((d) => {
    const i = d.loans.findIndex((l) => l.id === req.params.id);
    if (i !== -1) d.loans[i] = updated;
  });

  res.json({ ok: true, loan: updated, computed: summariseLoan(updated, today()) });
}));

router.delete('/loans/:id', asyncRoute(async (req, res) => {
  let removed = false;
  await store.mutate((d) => {
    const i = (d.loans || []).findIndex((l) => l.id === req.params.id);
    if (i !== -1) { d.loans.splice(i, 1); removed = true; }
  });
  if (!removed) return res.status(404).json({ error: 'No such loan' });
  res.json({ ok: true });
}));

/** EMI helper for the form, so the figure appears as the user types. */
router.get('/loans/emi', asyncRoute(async (req, res) => {
  const { principal, annualRate, tenureMonths } = req.query;
  res.json({ emi: computeEmi(Number(principal), Number(annualRate), Number(tenureMonths)) });
}));

/** Month-by-month table for one loan, for checking against a bank statement. */
router.get('/loans/:id/schedule', asyncRoute(async (req, res) => {
  const db = await store.init();
  const loan = (db.loans || []).find((l) => l.id === req.params.id);
  if (!loan) return res.status(404).json({ error: 'No such loan' });
  res.json({ loan, ...amortisationSchedule(loan, today()) });
}));

export default router;
