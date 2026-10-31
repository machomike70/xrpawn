export const DROPS = 1_000_000

export function xrp(drops: string | number | bigint | null | undefined, digits = 2): string {
  if (drops === null || drops === undefined) return '–'
  const n = Number(drops) / DROPS
  return `${n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 })} XRP`
}

export function toDrops(xrpAmount: string | number): string {
  const n = Number(xrpAmount)
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter a positive XRP amount')
  return String(Math.round(n * DROPS))
}

export const short = (s?: string | null, n = 6) => (s ? `${s.slice(0, n)}…${s.slice(-4)}` : '')
export const pct = (bps: number) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`

export function date(unix?: number | null) {
  if (!unix) return '–'
  return new Date(unix * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function resolveUri(uri?: string | null): string | null {
  if (!uri) return null
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice(7).replace(/^ipfs\//, '')}`
  if (uri.startsWith('http')) return uri
  if (/^(Qm|baf)[a-zA-Z0-9]+/.test(uri)) return `https://ipfs.io/ipfs/${uri}`
  return null
}
