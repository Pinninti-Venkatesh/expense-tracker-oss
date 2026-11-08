/**
 * Hands text to the phone's share sheet (WhatsApp, Messages…), or copies it
 * where there is no share sheet. The app itself never sends anything.
 *
 * Returns 'shared', 'copied' or 'cancelled'.
 */
export async function shareText(text) {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
      // Some desktop browsers expose share() but refuse it; fall back to copying.
    }
  }
  await copyText(text);
  return 'copied';
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}
