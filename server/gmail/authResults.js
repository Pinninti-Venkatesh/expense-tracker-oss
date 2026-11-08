/**
 * True when Gmail itself verified with DKIM that the email came from the
 * sender's domain.
 *
 * Only Gmail's own Authentication-Results header counts. Gmail adds it on
 * receipt at the top of the headers, and it names mx.google.com. A sender can
 * paste a fake one further down, which is why only the first is read.
 *
 * Learned templates are taught and used only for verified senders, so a spoofed
 * "bank alert" can neither train a template nor be read by one.
 */
export function isAuthenticSender(message, sender) {
  const domain = String(sender || '').toLowerCase().split('@')[1];
  if (!domain) return false;

  const header = (message?.payload?.headers || []).find((h) => h.name.toLowerCase() === 'authentication-results');
  const value = String(header?.value || '');
  if (!/^\s*mx\.google\.com\s*;/i.test(value)) return false;

  return [...value.matchAll(/dkim=pass[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/gi)]
    .some((m) => {
      const signed = m[1].toLowerCase();
      return domain === signed || domain.endsWith(`.${signed}`);
    });
}
