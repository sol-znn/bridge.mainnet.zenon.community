// Temporary plasma for a Zenon address that has none, from zenonhub's plasma
// bot (github.com/zenonhub-io/zenonhub, routes/api.php):
//
//   POST {url}  {"address": "z1…"}   Authorization: Bearer <token>
//
// The bot fuses QSR to the address for a while; a second request for an
// address it already fuses is a no-op. The endpoint sends CORS headers
// (`*`), so a page can call it, but it needs a Sanctum token with the
// `plasma-bot` ability, and a token built into a static page is public. With
// no token the page links to zenonhub's own form instead. docs/DEPLOY.md says
// how to put a small proxy in front that holds the token.

export interface PlasmaBotConfig {
  url: string
  token: string
  page: string
  mode?: 'direct' | 'proxy'
}

export type PlasmaBotResult =
  | { ok: true; message: string }
  | { ok: false; reason: 'no-token' | 'rejected' | 'network'; message: string; page: string }

export function canRequest(c: PlasmaBotConfig): boolean {
  return Boolean(c.url && (c.token || c.mode === 'proxy'))
}

export async function requestPlasma(
  address: string,
  c: PlasmaBotConfig,
  fetcher: typeof fetch = fetch,
): Promise<PlasmaBotResult> {
  if (!canRequest(c)) return { ok: false, reason: 'no-token', message: 'Get plasma on zenonhub', page: c.page }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetcher(c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(c.mode !== 'proxy' && c.token ? { Authorization: `Bearer ${c.token}` } : {}) },
      body: JSON.stringify({ address }),
      signal: controller.signal,
    })
    let body: { message?: string; error?: string; data?: unknown } = {}
    try {
      body = await res.json()
    } catch {
      /* empty body */
    }
    if (res.ok) return { ok: true, message: body.message || 'Plasma requested' }
    return { ok: false, reason: 'rejected', message: body.message || body.error || `HTTP ${res.status}`, page: c.page }
  } catch (err) {
    return { ok: false, reason: 'network', message: err instanceof Error ? err.message : String(err), page: c.page }
  } finally {
    clearTimeout(timer)
  }
}

/** No plasma at all: a send from this address needs proof of work, which Syrius does slowly or not at all. */
export function hasNoPlasma(currentPlasma: number | null | undefined): boolean {
  return currentPlasma === 0
}
