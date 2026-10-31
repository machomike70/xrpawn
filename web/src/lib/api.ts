const TOKEN_KEY = 'xrpawn.token'

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}
export function setToken(t: string | null) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken()
  const r = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, j.error ?? `Request failed (${r.status})`)
  return j as T
}

/** Report a just-submitted tx to the API, retrying while the ledger validates it. */
export async function report<T = any>(path: string, body: unknown): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await api<T>(path, { body })
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 409) && /not (found|validated) yet/.test(e.message) && i < 15) {
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }
      throw e
    }
  }
}

export interface AppConfig {
  network: string
  vault: string
  treasury: string
  explorer: string
  platformAprBps: number
  platformMaxDays: number
  p2pFeeBps: number
  marketFeeBps: number
  graceHours: number
  fundingWindowHours: number
  xaman: boolean
  devWallet: boolean
  me: string | null
  isAdmin: boolean
}
