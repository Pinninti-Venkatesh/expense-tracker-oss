class AuthRequiredError extends Error {
  /** reason: 'reconnect' when Google access stopped, 'signin' when the session ended. */
  constructor(authUrl, reason = 'signin') {
    super(reason === 'reconnect' ? 'Google access needs reconnecting' : 'Not signed in with Google');
    this.name = 'AuthRequiredError';
    this.authUrl = authUrl;
    this.reason = reason;
  }
}

/** Signed in, but the app is PIN-locked. Distinct from a dead session. */
class PinRequiredError extends Error {
  constructor() {
    super('PIN required');
    this.name = 'PinRequiredError';
  }
}

/** Signed in and unlocked, but the trial or paid days have run out. */
class PaymentRequiredError extends Error {
  constructor(message) {
    super(message || 'Subscribe to keep using the app.');
    this.name = 'PaymentRequiredError';
  }
}

// The lock can be hit by any request, not just the one the user triggered, so
// the app registers a listener instead of every call site handling 423.
let onLocked = () => {};
export function onPinRequired(handler) {
  onLocked = handler;
}

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    const loginUrl = body.loginUrl || '/api/login';
    // Google access stopped (password change, access removed): show the
    // "Paused" screen, which explains it, instead of bouncing to Google cold.
    if (/intent=reconnect/.test(loginUrl)) throw new AuthRequiredError(loginUrl, 'reconnect');
    // The session itself ended: sign in again.
    window.location.href = loginUrl;
    throw new AuthRequiredError(loginUrl, 'signin');
  }

  // 423 Locked: the session is fine, the PIN gate is shut. Show the keypad
  // rather than bouncing to Google, which would fix nothing.
  if (res.status === 423) {
    onLocked();
    throw new PinRequiredError();
  }

  // 402: the paywall. The app swaps to the subscribe screen.
  if (res.status === 402) {
    const body = await res.json().catch(() => ({}));
    throw new PaymentRequiredError(body.error);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }

  return res.status === 204 ? null : res.json();
}

export { AuthRequiredError, PinRequiredError, PaymentRequiredError };

const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  // account
  session: () => request('/session'),
  me: () => request('/me'),
  logout: () => post('/logout'),
  deleteAccount: ({ deleteDriveFile = false } = {}) =>
    request('/account', { method: 'DELETE', body: JSON.stringify({ deleteDriveFile }) }),
  settings: () => request('/settings'),
  updateSettings: (patch) => request('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  trialIntroSeen: () => post('/onboarding/trial-intro'),

  // plan & payments
  billing: () => request('/billing'),
  subscribe: (plan) => post('/billing/subscribe', { plan }),
  // The three fields Razorpay Checkout hands back after the customer authorises.
  verifyPayment: ({ razorpay_payment_id, razorpay_subscription_id, razorpay_signature }) =>
    post('/billing/verify', { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }),
  cancelPlan: () => post('/billing/cancel'),

  // privacy PIN
  pinStatus: () => request('/pin/status'),
  pinVerify: (pin) => post('/pin/verify', { pin }),
  pinLock: () => post('/pin/lock'),
  pinSet: (pin, currentPin) => post('/pin', { pin, currentPin }),
  pinRemove: (currentPin) => request('/pin', { method: 'DELETE', body: JSON.stringify({ currentPin }) }),
  // Only succeeds shortly after signing in with Google again (intent=pin-reset).
  pinReset: (pin) => post('/pin/reset', { pin }),

  // spends
  listExpenses: () => request('/expenses'),
  addExpense: (expense) => post('/expenses', expense),
  deleteExpense: (id) => request(`/expenses/${id}`, { method: 'DELETE' }),
  flagExpense: (id, reason, corrected, applyToAll = false) =>
    post(`/expenses/${id}/flag`, { reason, corrected, applyToAll }),
  markReviewed: (id) => post(`/expenses/${id}/reviewed`),
  sync: () => post('/sync'),
  firstSync: () => post('/sync/first'),
  enrichOne: (id) => post(`/expenses/${id}/enrich`),
  setDetails: (id, { description, items }) =>
    request(`/expenses/${id}/details`, { method: 'PATCH', body: JSON.stringify({ description, items }) }),

  // splits
  people: () => request('/people'),
  splitExpense: (id, payload) => post(`/expenses/${id}/split`, payload),
  unsplitExpense: (id) => request(`/expenses/${id}/split`, { method: 'DELETE' }),
  setSplitStatus: (id, participantId, status) =>
    post(`/expenses/${id}/split/${participantId}/status`, { status }),

  // categories (built-in + custom)
  categories: () => request('/categories'),
  addCategory: (name) => post('/categories', { name }),
  deleteCategory: (name, reassignTo = null) =>
    request(`/categories/${encodeURIComponent(name)}`, { method: 'DELETE', body: JSON.stringify({ reassignTo }) }),
  setExpenseCategory: (id, category, applyToAll = false) =>
    post(`/expenses/${id}/category`, { category, applyToAll }),

  // bank statements
  findStatements: (lookbackDays) => request(`/upi/statements?lookbackDays=${encodeURIComponent(lookbackDays)}`),
  // passwords: { [bank sender address]: password }. Used for this import only,
  // unless `remember`: then kept, encrypted, for automatic imports.
  importStatements: ({ passwords = {}, lookbackDays, force = false, remember = false }) =>
    post('/upi/import', { passwords, lookbackDays, force, remember }),
  savedStatementPasswords: () => request('/upi/saved-passwords'),
  forgetStatementPasswords: () => request('/upi/saved-passwords', { method: 'DELETE' }),

  // household (app-password installs)
  household: () => request('/household'),
  createInvite: () => post('/household/invites'),
  cancelInvite: (id) => request(`/household/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  removeMember: (id) => request(`/household/members/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setClaudeKey: (apiKey) => request('/household/claude-key', { method: 'PUT', body: JSON.stringify({ apiKey }) }),
  setTransfer: (id, transfer) => post('/upi/transfer', { id, transfer }),

  // settling card spends (move the money to a separate bank)
  settleExpense: (id, settled) => post(`/expenses/${id}/settle`, { settled }),
  settleAll: () => post('/settle/all'),

  // refunds
  addRefund: (id, payload) => post(`/expenses/${id}/refunds`, payload),
  removeRefund: (id, refundId) => request(`/expenses/${id}/refunds/${refundId}`, { method: 'DELETE' }),

  // loans
  loans: () => request('/loans'),
  addLoan: (payload) => post('/loans', payload),
  updateLoan: (id, payload) => request(`/loans/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteLoan: (id) => request(`/loans/${id}`, { method: 'DELETE' }),
  loanSchedule: (id) => request(`/loans/${id}/schedule`),

  // money lent to / borrowed from people (manual IOUs)
  ledger: () => request('/ledger'),
  addLedgerEntry: (payload) => post('/ledger', payload),
  updateLedgerEntry: (id, payload) => request(`/ledger/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteLedgerEntry: (id) => request(`/ledger/${id}`, { method: 'DELETE' }),
  addRepayment: (id, payload) => post(`/ledger/${id}/repayments`, payload),
  removeRepayment: (id, repaymentId) => request(`/ledger/${id}/repayments/${repaymentId}`, { method: 'DELETE' }),
};
