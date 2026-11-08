/**
 * Indian banks and card issuers, by the email domains they send from.
 *
 * Used to widen the Gmail search for alerts and statements and to label a
 * statement with its bank. It is not an allowlist: alerts from a bank missing
 * here are still found by their wording, and statements by their subject.
 *
 * The *.bank.in entries follow RBI's move of banks onto that domain. Check any
 * of them against a real alert before relying on it; a wrong entry only means a
 * search clause that matches nothing.
 */
export const BANKS = [
  { name: 'HDFC Bank', domains: ['hdfcbank.net', 'hdfcbank.com', 'hdfcbank.bank.in'] },
  { name: 'ICICI Bank', domains: ['icicibank.com', 'icici.bank.in'] },
  { name: 'SBI', domains: ['sbi.co.in', 'sbi.bank.in'] },
  { name: 'SBI Card', domains: ['sbicard.com'] },
  { name: 'Axis Bank', domains: ['axisbank.com', 'axis.bank.in'] },
  { name: 'Kotak', domains: ['kotak.com', 'kotak.bank.in'] },
  { name: 'Yes Bank', domains: ['yesbank.in', 'yes.bank.in'] },
  { name: 'IndusInd Bank', domains: ['indusind.com', 'indusind.bank.in'] },
  { name: 'IDFC FIRST Bank', domains: ['idfcfirstbank.com', 'idfcfirst.bank.in'] },
  { name: 'Federal Bank', domains: ['federalbank.co.in', 'federal.bank.in'] },
  { name: 'AU Small Finance Bank', domains: ['aubank.in', 'au.bank.in'] },
  { name: 'RBL Bank', domains: ['rblbank.com', 'rbl.bank.in'] },
  { name: 'Bank of Baroda', domains: ['bankofbaroda.com', 'bankofbaroda.co.in', 'bankofbaroda.bank.in'] },
  { name: 'Punjab National Bank', domains: ['pnb.co.in', 'pnb.bank.in'] },
  { name: 'Canara Bank', domains: ['canarabank.com', 'canarabank.in', 'canarabank.bank.in'] },
  { name: 'Union Bank of India', domains: ['unionbankofindia.co.in', 'unionbankofindia.bank.in'] },
  { name: 'Bank of India', domains: ['bankofindia.co.in', 'boi.bank.in'] },
  { name: 'Indian Bank', domains: ['indianbank.co.in', 'indianbank.bank.in'] },
  { name: 'IDBI Bank', domains: ['idbibank.com', 'idbi.bank.in'] },
  { name: 'Bandhan Bank', domains: ['bandhanbank.com', 'bandhan.bank.in'] },
  { name: 'DBS Bank', domains: ['dbs.com'] },
  { name: 'HSBC', domains: ['hsbc.co.in'] },
  { name: 'Standard Chartered', domains: ['sc.com'] },
  { name: 'American Express', domains: ['americanexpress.com', 'aexp.com'] },
  { name: 'Jupiter', domains: ['jupiter.money'] },
  { name: 'Fi', domains: ['fi.money'] },
];

export const BANK_DOMAINS = [...new Set(BANKS.flatMap((b) => b.domains))];

const domainOf = (sender) => String(sender || '').toLowerCase().trim().split('@')[1] || '';

/** "HDFC Bank" for alerts@hdfcbank.net, including subdomains like mail.axisbank.com. */
export function bankForSender(sender) {
  const domain = domainOf(sender);
  if (!domain) return null;
  return BANKS.find((b) => b.domains.some((d) => domain === d || domain.endsWith(`.${d}`)))?.name || null;
}

/** The bank's name when known, otherwise the sender's domain. */
export function bankLabelForSender(sender) {
  return bankForSender(sender) || domainOf(sender) || 'Bank';
}
