/**
 * Splits and lending.
 *
 * Lending is not a separate concept — it is a split where the other person owes
 * everything and your share is zero. One model covers both.
 *
 * Settlement status drives what the transaction actually costs you:
 *   pending — they owe you. Cash left your account but it isn't your expense.
 *   settled — you got it back. Not your expense.
 *   waived  — you decided you won't get it back, so you absorbed it. It becomes
 *             your expense.
 *
 * Money is computed in paise (integers) so repeated division never drifts.
 */

export const SPLIT_MODES = ['equal', 'shares', 'exact', 'lent'];

const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);
const toRupees = (paise) => Math.round(paise) / 100;

/**
 * Works out what each participant owes.
 *
 * `participants` are the OTHER people — you are never in the list. Your share is
 * whatever is left, which also absorbs any rounding remainder (at most a few
 * paise) so the parts always add back to the exact total.
 *
 * mode:
 *   equal — split evenly between you and them (or just them if includeYou false)
 *   shares — weight by each participant's `shares`, you count as 1 share when included
 *   exact — use each participant's `owed` verbatim
 *   lent — they owe all of it; your share is zero
 */
export function computeSplit({ total, mode, participants, includeYou = true }) {
  if (!SPLIT_MODES.includes(mode)) throw new Error(`Unknown split mode: ${mode}`);
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new Error('A split needs at least one other person');
  }

  const totalPaise = toPaise(total);
  if (totalPaise <= 0) throw new Error('Split total must be positive');

  let owedPaise;

  switch (mode) {
    case 'equal': {
      const heads = participants.length + (includeYou ? 1 : 0);
      const each = Math.floor(totalPaise / heads);
      owedPaise = participants.map(() => each);
      break;
    }

    case 'lent': {
      // They owe all of it, divided evenly if you fronted money for several people.
      const each = Math.floor(totalPaise / participants.length);
      owedPaise = participants.map(() => each);
      break;
    }

    case 'shares': {
      const weights = participants.map((p) => {
        const w = Number(p.shares);
        if (!Number.isFinite(w) || w <= 0) throw new Error(`${p.name || 'Someone'} needs a share count above zero`);
        return w;
      });
      const totalWeight = weights.reduce((a, b) => a + b, 0) + (includeYou ? 1 : 0);
      owedPaise = weights.map((w) => Math.floor((totalPaise * w) / totalWeight));
      break;
    }

    case 'exact': {
      owedPaise = participants.map((p) => {
        const v = toPaise(p.owed);
        if (!Number.isFinite(v) || v < 0) throw new Error(`${p.name || 'Someone'} has an invalid amount`);
        return v;
      });
      const sum = owedPaise.reduce((a, b) => a + b, 0);
      if (sum > totalPaise) {
        throw new Error(`Shares add up to ${toRupees(sum)} but the transaction is only ${toRupees(totalPaise)}`);
      }
      break;
    }
  }

  const owedSum = owedPaise.reduce((a, b) => a + b, 0);
  // Your share soaks up the rounding remainder so the split always reconciles.
  const yourSharePaise = totalPaise - owedSum;

  return {
    mode,
    includeYou,
    yourShare: toRupees(yourSharePaise),
    participants: participants.map((p, i) => ({
      id: p.id || `pp_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      name: p.name,
      shares: mode === 'shares' ? Number(p.shares) : undefined,
      owed: toRupees(owedPaise[i]),
      status: p.status || 'pending',
      settledAt: p.settledAt || null,
    })),
  };
}

/** What this transaction actually cost you, after splitting, settlement and refunds. */
export function effectiveAmount(expense) {
  const amount = Number(expense.amount) || 0;

  const base = !expense.split
    ? amount
    : Math.round(
      (Number(expense.split.yourShare || 0) + expense.split.participants
        .filter((p) => p.status === 'waived')
        .reduce((s, p) => s + (Number(p.owed) || 0), 0)) * 100,
    ) / 100;

  // Refunds come back to you, so they reduce what the charge cost. Applied to
  // your share rather than pro-rated across a split: the money lands in your
  // account, and re-settling with the others is a separate decision.
  // Floored at zero so an over-refund can never read as negative spending.
  const refunded = (expense.refunds || [])
    .reduce((s, r) => s + (Number(r.amount) || 0), 0);

  return Math.max(0, Math.round((base - refunded) * 100) / 100);
}

/** Still outstanding — money other people owe you on this transaction. */
export function owedToYou(expense) {
  if (!expense.split) return 0;
  const sum = expense.split.participants
    .filter((p) => p.status === 'pending')
    .reduce((s, p) => s + (Number(p.owed) || 0), 0);
  return Math.round(sum * 100) / 100;
}

/** Totals across a set of expenses, for the summary row. */
export function splitTotals(expenses) {
  let owed = 0;
  let settled = 0;
  let waived = 0;

  for (const e of expenses) {
    if (!e.split) continue;
    for (const p of e.split.participants) {
      const v = Number(p.owed) || 0;
      if (p.status === 'pending') owed += v;
      else if (p.status === 'settled') settled += v;
      else if (p.status === 'waived') waived += v;
    }
  }

  const round = (n) => Math.round(n * 100) / 100;
  return { owed: round(owed), settled: round(settled), waived: round(waived) };
}

/** Marks one participant settled / waived / back to pending. */
export function setParticipantStatus(expense, participantId, status) {
  if (!['pending', 'settled', 'waived'].includes(status)) {
    throw new Error(`Unknown status: ${status}`);
  }
  if (!expense.split) throw new Error('This transaction is not split');

  const participant = expense.split.participants.find((p) => p.id === participantId);
  if (!participant) throw new Error('No such participant on this split');

  participant.status = status;
  participant.settledAt = status === 'pending' ? null : new Date().toISOString();
  return participant;
}
