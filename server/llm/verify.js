/**
 * Asks Anthropic whether an API key works, before it is saved. Free: it only
 * lists models. `ok` is null when Anthropic couldn't be reached, which says
 * nothing about the key.
 */
export async function verifyClaudeKey(key, fetchImpl = fetch) {
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, reason: 'Anthropic says this key is not valid. Copy it again from the Claude console.' };
    if (res.status === 403) return { ok: false, reason: "This key isn't allowed to use the API." };
    return { ok: null, reason: `Anthropic answered ${res.status}.` };
  } catch {
    return { ok: null, reason: "Couldn't reach Anthropic to check the key." };
  }
}

export const looksLikeClaudeKey = (key) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(String(key || '').trim());
