/**
 * Live NFT collection floor prices.
 *
 * PRICE_FEED=none | clio | bithomp | http   (default: none -> admin-entered floors only)
 *
 *  clio     Reads public sell offers straight from the XRP Ledger via a Clio server (nfts_by_issuer +
 *           nft_sell_offers). Free. Set CLIO_URL (e.g. https://s1.ripple.com:51234 for mainnet, or your own Clio).
 *  bithomp  Bithomp API (paid plan for on-sale lists). Set BITHOMP_API_KEY.
 *           Built from Bithomp's public docs; verify field names with your key before relying on it.
 *  http     Your own/other provider. PRICE_FEED_URL with {issuer} and {taxon} placeholders, returning JSON
 *           { "floorDrops": "123000000", "listings": 12 } (or floorXrp). Optional PRICE_FEED_API_KEY sent as Bearer.
 *
 * Safety rules (see effectiveFloor):
 *  - The live floor is the LOWEST public XRP ask, so cheap listings make it more conservative, never less.
 *  - Collections with fewer than PRICE_FEED_MIN_LISTINGS listings get no live price (thin markets are easy to fake).
 *  - The admin floor stays a hard ceiling: live prices can lower the loan amount, never raise it above the admin cap.
 *    Set an admin floor of 0 to rely on the live floor only.
 */
import { HttpError } from '../xrpl.js'

export interface FloorQuote { floorDrops: bigint; listings: number; source: string }

const num = (name: string, d: number) => (process.env[name] ? Number(process.env[name]) : d)
export const feedConfig = () => ({
  provider: (process.env.PRICE_FEED ?? 'none') as 'none' | 'clio' | 'bithomp' | 'http',
  minListings: num('PRICE_FEED_MIN_LISTINGS', 3),
  maxAgeMin: num('PRICE_FEED_MAX_AGE_MIN', 60),
  intervalMin: num('PRICE_FEED_INTERVAL_MIN', 15),
  required: process.env.PRICE_FEED_REQUIRED === '1',
  /** Broker accounts whose destination-locked listings count as public (e.g. marketplace brokers). */
  brokers: (process.env.PRICE_FEED_BROKERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
})

/** Lowest ask, if there are enough listings to trust it. */
export function computeFloor(asks: bigint[], minListings: number): { floorDrops: bigint; listings: number } | null {
  const valid = asks.filter((a) => a > 0n)
  if (valid.length < minListings) return null
  return { floorDrops: valid.reduce((m, a) => (a < m ? a : m)), listings: valid.length }
}

export interface FloorInputs {
  adminFloorDrops: bigint // 0 = no admin cap (live only)
  live?: { floorDrops: bigint; updatedAt: number } | null
  now: number
  maxAgeMin: number
  required: boolean
}

/** Combine the admin floor and live floor into the floor used for lending. null = not lendable right now. */
export function effectiveFloor(i: FloorInputs): { floorDrops: bigint; basis: 'admin' | 'live' | 'live_capped' } | null {
  const fresh = i.live && i.now - i.live.updatedAt <= i.maxAgeMin * 60 ? i.live : null
  if (!fresh) {
    if (i.required || i.adminFloorDrops === 0n) return null
    return { floorDrops: i.adminFloorDrops, basis: 'admin' }
  }
  if (i.adminFloorDrops === 0n) return { floorDrops: fresh.floorDrops, basis: 'live' }
  return fresh.floorDrops < i.adminFloorDrops
    ? { floorDrops: fresh.floorDrops, basis: 'live' }
    : { floorDrops: i.adminFloorDrops, basis: 'live_capped' }
}

function isPublicXrpAsk(o: { amount: unknown; destination?: string | null }, brokers: string[]): bigint | null {
  if (typeof o.amount !== 'string' || !/^\d+$/.test(o.amount)) return null // tokens/IOUs not counted
  if (o.destination && !brokers.includes(o.destination)) return null // private offers don't reflect the market
  return BigInt(o.amount)
}

async function getJson(url: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
  if (!r.ok) throw new Error(`${new URL(url).host} responded ${r.status}`)
  return r.json() as Promise<any>
}

async function clioRpc(method: string, params: Record<string, unknown>) {
  const url = process.env.CLIO_URL
  if (!url) throw new Error('CLIO_URL not set')
  const j = await getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }) })
  if (j.result?.status === 'error' || j.result?.error) {
    if (j.result.error === 'objectNotFound') return null
    throw new Error(`${method}: ${j.result.error}`)
  }
  return j.result
}

async function fromClio(issuer: string, taxon: number, brokers: string[]): Promise<bigint[]> {
  const asks: bigint[] = []
  const params: Record<string, unknown> = { issuer, limit: 100 }
  if (taxon >= 0) params.nft_taxon = taxon
  const r = await clioRpc('nfts_by_issuer', params)
  for (const nft of (r?.nfts ?? []).slice(0, 100)) {
    if (nft.is_burned) continue
    const offers = await clioRpc('nft_sell_offers', { nft_id: nft.nft_id, limit: 50 }).catch(() => null)
    for (const o of offers?.offers ?? []) {
      const a = isPublicXrpAsk({ amount: o.amount, destination: o.destination }, brokers)
      if (a !== null) asks.push(a)
    }
  }
  return asks
}

async function fromBithomp(issuer: string, taxon: number, brokers: string[]): Promise<bigint[]> {
  const key = process.env.BITHOMP_API_KEY
  if (!key) throw new Error('BITHOMP_API_KEY not set')
  const collection = taxon >= 0 ? `${issuer}:${taxon}` : issuer
  const q = new URLSearchParams({ collection, list: 'onSale', order: 'priceLow', currency: 'xrp', sellOffers: 'true', limit: '100' })
  const base = process.env.BITHOMP_API_URL ?? 'https://bithomp.com/api/v2'
  const j = await getJson(`${base}/nfts?${q}`, { headers: { 'x-bithomp-token': key } })
  const asks: bigint[] = []
  for (const nft of j.nfts ?? []) {
    for (const o of nft.sellOffers ?? []) {
      if (o.valid === false) continue
      const a = isPublicXrpAsk({ amount: o.amount, destination: o.destination }, brokers)
      if (a !== null) asks.push(a)
    }
  }
  return asks
}

async function fromHttp(issuer: string, taxon: number): Promise<FloorQuote | null> {
  const tpl = process.env.PRICE_FEED_URL
  if (!tpl) throw new Error('PRICE_FEED_URL not set')
  const url = tpl.replace('{issuer}', encodeURIComponent(issuer)).replace('{taxon}', String(taxon))
  const key = process.env.PRICE_FEED_API_KEY
  const j = await getJson(url, key ? { headers: { authorization: `Bearer ${key}` } } : {})
  const drops = j.floorDrops ?? j.floor_drops ?? (j.floorXrp !== undefined ? Math.round(Number(j.floorXrp) * 1e6) : undefined)
  if (drops === undefined || drops === null || !/^\d+$/.test(String(drops))) return null
  return { floorDrops: BigInt(drops), listings: Number(j.listings ?? 0), source: new URL(url).host }
}

/** Fetch the current live floor for a collection, or null if the market is too thin / unavailable. */
export async function fetchFloor(issuer: string, taxon: number): Promise<FloorQuote | null> {
  const c = feedConfig()
  if (c.provider === 'none') return null
  if (c.provider === 'http') {
    const q = await fromHttp(issuer, taxon)
    return q && q.listings >= c.minListings ? q : null
  }
  const asks = c.provider === 'clio' ? await fromClio(issuer, taxon, c.brokers)
    : c.provider === 'bithomp' ? await fromBithomp(issuer, taxon, c.brokers)
    : (() => { throw new HttpError(500, `Unknown PRICE_FEED ${c.provider}`) })()
  const f = computeFloor(asks, c.minListings)
  return f ? { ...f, source: c.provider } : null
}
