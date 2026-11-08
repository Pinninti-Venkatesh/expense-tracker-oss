/**
 * Putting the app on a phone's home screen.
 *
 * Chrome and Edge on Android fire beforeinstallprompt, which is caught the moment
 * this module loads, because it can fire before any screen that wants it has
 * mounted. iPhones have no prompt: the way in is Share, then Add to Home Screen.
 */
let deferred = null;
const listeners = new Set();
const KEY = 'et.installTipSeen';

const notify = () => listeners.forEach((fn) => fn());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    markInstallTipSeen();
    notify();
  });
}

export const canPrompt = () => Boolean(deferred);

export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Shows the browser's own install dialog. Resolves 'accepted', 'dismissed' or 'unavailable'. */
export async function promptInstall() {
  if (!deferred) return 'unavailable';
  const event = deferred;
  deferred = null;
  notify();
  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome;
}

export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

export function platform() {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

/** Once per device, on phones only, and never inside the installed app. */
export function shouldShowInstallTip() {
  if (typeof window === 'undefined' || isStandalone() || platform() === 'desktop') return false;
  try {
    return localStorage.getItem(KEY) !== '1';
  } catch {
    return false;
  }
}

export function markInstallTipSeen() {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // Storage blocked: the tip may show again, which is harmless.
  }
}
