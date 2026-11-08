/**
 * Loan tracking, modelled on how Indian retail loans actually work
 * (ICICI / HDFC / Axis and peers).
 *
 * Mechanics encoded here:
 *  - EMIs are reducing-balance, not flat. Each instalment pays that month's
 *    interest on the OUTSTANDING principal first; the remainder retires
 *    principal. Early EMIs are mostly interest, later ones mostly principal —
 *    which is why "half the tenure done" never means "half the loan repaid".
 *  - EMI = P·r·(1+r)^n / ((1+r)^n − 1), r = annual rate / 12 / 100.
 *  - Foreclosure: RBI bars pre-payment/foreclosure charges on FLOATING-rate
 *    term loans to individual borrowers, so those default to zero. Fixed-rate
 *    loans (most personal/car loans) typically charge 2–5% of the outstanding
 *    principal, plus 18% GST on that charge. Both are per-loan overridable
 *    because lenders differ and rules change.
 *
 * Everything here is pure arithmetic — no LLM, no network.
 */

export const LOAN_TYPES = [
  // `rateType` is the market norm for that product, used only as a form default.
  { id: 'home', label: 'Home loan', rateType: 'floating', typicalRate: [8.5, 9.75], maxYears: 30 },
  { id: 'car', label: 'Car / auto loan', rateType: 'fixed', typicalRate: [9, 12], maxYears: 8 },
  { id: 'personal', label: 'Personal loan', rateType: 'fixed', typicalRate: [11, 18], maxYears: 6 },
  { id: 'education', label: 'Education loan', rateType: 'floating', typicalRate: [9, 13], maxYears: 15 },
  { id: 'gold', label: 'Gold loan', rateType: 'fixed', typicalRate: [9, 15], maxYears: 3 },
  { id: 'lap', label: 'Loan against property', rateType: 'floating', typicalRate: [9.5, 12], maxYears: 20 },
  { id: 'other', label: 'Other', rateType: 'fixed', typicalRate: [10, 15], maxYears: 30 },
];

export const RATE_TYPES = ['floating', 'fixed'];

/** Default foreclosure charge, as a % of outstanding principal. */
export function defaultForeclosurePct(rateType) {
  // RBI: no pre-payment charges on floating-rate term loans to individuals.
  return rateType === 'floating' ? 0 : 3;
}

const GST_ON_CHARGES = 18;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const monthlyRate = (annualRate) => Number(annualRate) / 12 / 100;

/** Instalment for a reducing-balance loan. Zero-interest degrades to P/n. */
export function computeEmi(principal, annualRate, tenureMonths) {
  const P = Number(principal);
  const n = Math.round(Number(tenureMonths));
  const r = monthlyRate(annualRate);
  if (!(P > 0) || !(n > 0)) return 0;
  if (r === 0) return round2(P / n);
  const f = (1 + r) ** n;
  return round2((P * r * f) / (f - 1));
}

/**
 * Principal still owed after `k` instalments, in closed form:
 *   B_k = P(1+r)^k − EMI·((1+r)^k − 1)/r
 * Never returns below zero, so an over-long elapsed period reads as "cleared".
 */
export function outstandingAfter(principal, annualRate, tenureMonths, k, emi) {
  const P = Number(principal);
  const r = monthlyRate(annualRate);
  const paid = Math.max(0, Math.min(Math.round(k), Math.round(tenureMonths)));
  const E = emi || computeEmi(P, annualRate, tenureMonths);
  if (paid === 0) return round2(P);
  if (r === 0) return round2(Math.max(0, P - E * paid));
  const f = (1 + r) ** paid;
  return round2(Math.max(0, P * f - E * ((f - 1) / r)));
}

/** Whole months elapsed between two YYYY-MM-DD dates (partial months excluded). */
export function monthsBetween(startISO, asOfISO) {
  const [sy, sm, sd] = String(startISO).split('-').map(Number);
  const [ay, am, ad] = String(asOfISO).split('-').map(Number);
  if (!sy || !ay) return 0;
  let months = (ay - sy) * 12 + (am - sm);
  if (ad < sd) months -= 1; // the month's EMI date hasn't come round yet
  return Math.max(0, months);
}

/** YYYY-MM-DD `months` after a start date, clamping the day to month length. */
export function addMonths(startISO, months) {
  const [y, m, d] = String(startISO).split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + Math.round(months), 1));
  const daysInMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, daysInMonth));
  return target.toISOString().slice(0, 10);
}

/**
 * When the first instalment falls due. Lenders commonly set EMIs to a fixed day
 * of the month that is not the disbursal day, so this is stated separately;
 * absent that, the convention is one month after disbursal.
 */
export function firstEmiDateOf(loan) {
  return loan.firstEmiDate || addMonths(loan.startDate, 1);
}

/** How many instalments have fallen due by `asOf`, counting the first one. */
export function paymentsDueBy(loan, asOf) {
  const first = firstEmiDateOf(loan);
  if (String(asOf) < String(first)) return 0;
  return monthsBetween(first, asOf) + 1;
}

/**
 * Instalments still needed to clear `balance` at this EMI and rate:
 *   n = −ln(1 − B·r/EMI) / ln(1+r)
 * Returns null when the EMI cannot even cover the monthly interest (the debt
 * would never clear), which is worth surfacing rather than showing infinity.
 */
export function monthsToClear(balance, annualRate, emi) {
  const B = Number(balance); const E = Number(emi); const r = monthlyRate(annualRate);
  if (!(B > 0)) return 0;
  if (r === 0) return Math.ceil(B / E);
  if (E <= B * r) return null;
  return Math.ceil(-Math.log(1 - (B * r) / E) / Math.log(1 + r));
}

/**
 * Everything the dashboard needs for one loan as of `asOf`:
 * progress so far, what is left, when it ends, and what closing it today costs.
 */
export function summariseLoan(loan, asOf) {
  const principal = Number(loan.principal) || 0;
  const rate = Number(loan.annualRate) || 0;
  const tenure = Math.round(Number(loan.tenureMonths) || 0);
  // A lender-stated EMI wins: rounding conventions differ slightly by bank.
  const emi = Number(loan.emi) > 0 ? Number(loan.emi) : computeEmi(principal, rate, tenure);

  const paymentsMade = Math.min(paymentsDueBy(loan, asOf), tenure);

  // A balance read off the lender's own statement beats a projection: floating
  // rates reprice, so a constant-rate model drifts from reality. When given, the
  // anchor is rolled forward by whatever EMIs have fallen due since it was taken.
  let outstanding;
  let anchored = false;
  const anchorValue = Number(loan.outstandingOverride);
  if (Number.isFinite(anchorValue) && anchorValue > 0 && loan.outstandingAsOf) {
    // Count EMIs, not calendar months. Elapsed months from the anchor date
    // silently treat the day the balance was read off a statement as the
    // recurrence day: a figure anchored on the 29th did not roll forward until
    // the 29th, so a loan billing on the 6th ignored the EMI it had just paid
    // and sat frozen for three weeks of every month. paymentsDueBy counts
    // instalments on the loan's own schedule, which is what actually moves the
    // balance.
    const since = Math.max(
      0,
      paymentsDueBy(loan, asOf) - paymentsDueBy(loan, loan.outstandingAsOf),
    );
    let b = anchorValue;
    const r = monthlyRate(rate);
    for (let i = 0; i < since && b > 0; i++) b = Math.max(0, b * (1 + r) - emi);
    outstanding = round2(b);
    anchored = true;
  } else {
    outstanding = outstandingAfter(principal, rate, tenure, paymentsMade, emi);
  }

  // Remaining instalments follow from the balance actually owed.
  const paymentsLeft = anchored
    ? (monthsToClear(outstanding, rate, emi) ?? Math.max(0, tenure - paymentsMade))
    : Math.max(0, tenure - paymentsMade);
  const principalPaid = round2(principal - outstanding);
  const paidSoFar = round2(emi * paymentsMade);
  const interestPaid = round2(Math.max(0, paidSoFar - principalPaid));

  const totalPayable = round2(emi * tenure);
  const totalInterest = round2(Math.max(0, totalPayable - principal));
  const interestLeft = round2(Math.max(0, (emi * paymentsLeft) - outstanding));

  // Closing early: outstanding principal + the lender's charge + GST on it.
  const chargePct = loan.foreclosurePct != null
    ? Number(loan.foreclosurePct)
    : defaultForeclosurePct(loan.rateType);
  const charge = round2(outstanding * (chargePct / 100));
  const gst = round2(charge * (GST_ON_CHARGES / 100));
  const preclosureTotal = round2(outstanding + charge + gst);
  // Paying now skips the remaining interest but incurs the charge.
  const preclosureSaving = round2(interestLeft - charge - gst);

  return {
    emi,
    tenureMonths: tenure,
    paymentsMade,
    paymentsLeft,
    outstanding,
    principalPaid,
    interestPaid,
    paidSoFar,
    totalPayable,
    totalInterest,
    interestLeft,
    percentPaid: principal > 0 ? Math.min(100, round2((principalPaid / principal) * 100)) : 0,
    anchored,
    // Anchored loans end when the real balance clears, not on the original date.
    payoffDate: anchored
      ? (paymentsLeft > 0 ? addMonths(asOf, paymentsLeft) : asOf)
      : (tenure > 0 ? addMonths(firstEmiDateOf(loan), tenure - 1) : null),
    closed: paymentsLeft === 0 || outstanding <= 0.5,
    preclosure: {
      outstanding,
      chargePct,
      charge,
      gst,
      total: preclosureTotal,
      saving: preclosureSaving,
      // Floating-rate individual loans carry no charge by RBI rule.
      chargeFree: chargePct === 0,
    },
  };
}

/** Portfolio view across every loan. */
export function summariseAll(loans = [], asOf) {
  const rows = loans.map((l) => ({ ...l, computed: summariseLoan(l, asOf) }));
  const live = rows.filter((r) => !r.computed.closed);

  const sum = (fn) => round2(live.reduce((t, r) => t + fn(r), 0));
  const payoffDates = live.map((r) => r.computed.payoffDate).filter(Boolean).sort();

  return {
    loans: rows.sort((a, b) => b.computed.outstanding - a.computed.outstanding),
    totalOutstanding: sum((r) => r.computed.outstanding),
    totalMonthlyEmi: sum((r) => r.computed.emi),
    totalInterestLeft: sum((r) => r.computed.interestLeft),
    totalPrincipalPaid: sum((r) => r.computed.principalPaid),
    totalPreclosure: sum((r) => r.computed.preclosure.total),
    activeCount: live.length,
    closedCount: rows.length - live.length,
    // The month the last loan clears — when you are debt free.
    debtFreeBy: payoffDates.length ? payoffDates[payoffDates.length - 1] : null,
  };
}

/**
 * Month-by-month amortisation table, so a figure can be checked against the
 * lender's own statement rather than taken on trust. `paidUpTo` marks how many
 * instalments have actually fallen due as of the reporting date.
 */
export function amortisationSchedule(loan, asOf, { limit = 0 } = {}) {
  const principal = Number(loan.principal) || 0;
  const rate = Number(loan.annualRate) || 0;
  const tenure = Math.round(Number(loan.tenureMonths) || 0);
  const emi = Number(loan.emi) > 0 ? Number(loan.emi) : computeEmi(principal, rate, tenure);
  const r = monthlyRate(rate);
  const paidUpTo = Math.min(paymentsDueBy(loan, asOf), tenure);

  const rows = [];
  let balance = principal;
  const count = limit > 0 ? Math.min(limit, tenure) : tenure;
  for (let k = 1; k <= count; k++) {
    const interest = round2(balance * r);
    // The final instalment clears whatever is left rather than overshooting.
    const principalPart = k === tenure ? round2(balance) : round2(emi - interest);
    balance = round2(Math.max(0, balance - principalPart));
    rows.push({
      n: k,
      date: addMonths(firstEmiDateOf(loan), k - 1),
      emi: round2(principalPart + interest),
      interest,
      principal: principalPart,
      balance,
      paid: k <= paidUpTo,
    });
  }
  return { emi, paidUpTo, rows };
}
