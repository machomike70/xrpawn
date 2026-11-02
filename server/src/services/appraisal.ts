/**
 * Appraisal: what the platform will lend against an NFT.
 * Only admin-approved collections (issuer + taxon) can get platform loans. Each has an admin floor (a hard cap)
 * and, when PRICE_FEED is configured, a live market floor; see services/pricefeed.ts for how they combine.
 */
import { config } from '../config.js'
import { all, now, one, run } from '../db.js'
import { HttpError, describeNft } from '../xrpl.js'
import { effectiveFloor, feedConfig, fetchFloor } from './pricefeed.js'

export interface CollectionRow {
  issuer: string
  taxon: number
  name: string
  floor_drops: string
  ltv_bps: number
  updated_at: number
  live_floor_drops: string | null
  live_listings: number | null
  live_source: string | null
  live_updated_at: number | null
  live_error: string | null
}

export const listCollections = () => all<CollectionRow>('SELECT * FROM collections ORDER BY name')

export function upsertCollection(c: { issuer: string; taxon: number; name: string; floorDrops: string; ltvBps?: number }) {
  if (!/^\d+$/.test(c.floorDrops)) throw new HttpError(400, 'floorDrops must be an integer string (0 = use live price only)')
  const ltv = c.ltvBps ?? config.defaultLtvBps
  if (ltv <= 0 || ltv > 9000) throw new HttpError(400, 'ltvBps must be between 1 and 9000')
  run(
    `INSERT INTO collections (issuer, taxon, name, floor_drops, ltv_bps, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(issuer, taxon) DO UPDATE SET name = excluded.name, floor_drops = excluded.floor_drops,
       ltv_bps = excluded.ltv_bps, updated_at = excluded.updated_at`,
    c.issuer, c.taxon, c.name, c.floorDrops, ltv, now(),
  )
}

export function deleteCollection(issuer: string, taxon: number) {
  run('DELETE FROM collections WHERE issuer = ? AND taxon = ?', issuer, taxon)
}

/** Refresh live floors for all approved collections (called by the background job and the admin page). */
export async function refreshFloors() {
  if (feedConfig().provider === 'none') return
  for (const c of listCollections()) {
    try {
      const q = await fetchFloor(c.issuer, c.taxon)
      run(
        'UPDATE collections SET live_floor_drops=?, live_listings=?, live_source=?, live_updated_at=?, live_error=? WHERE issuer=? AND taxon=?',
        q ? q.floorDrops.toString() : null, q?.listings ?? 0, q?.source ?? feedConfig().provider, now(),
        q ? null : 'Not enough public listings for a reliable floor', c.issuer, c.taxon,
      )
    } catch (e: any) {
      run('UPDATE collections SET live_error=?, live_updated_at=? WHERE issuer=? AND taxon=?', String(e?.message ?? e).slice(0, 200), now(), c.issuer, c.taxon)
    }
  }
}

let lastRefresh = 0
export async function maybeRefreshFloors() {
  const f = feedConfig()
  if (f.provider === 'none' || Date.now() - lastRefresh < f.intervalMin * 60_000) return
  lastRefresh = Date.now()
  await refreshFloors()
}

export function appraise(nftId: string) {
  const info = describeNft(nftId)
  const col =
    one<CollectionRow>('SELECT * FROM collections WHERE issuer = ? AND taxon = ?', info.issuer, info.taxon) ??
    one<CollectionRow>('SELECT * FROM collections WHERE issuer = ? AND taxon = -1', info.issuer)
  if (!col) {
    return { ...info, eligible: false, reason: 'Collection is not approved for platform loans yet. You can still request a P2P loan.' }
  }
  const f = feedConfig()
  const eff = effectiveFloor({
    adminFloorDrops: BigInt(col.floor_drops),
    live: col.live_floor_drops && col.live_updated_at ? { floorDrops: BigInt(col.live_floor_drops), updatedAt: col.live_updated_at } : null,
    now: now(),
    maxAgeMin: f.maxAgeMin,
    required: f.required,
  })
  if (!eff) {
    return { ...info, eligible: false, collection: col.name, reason: 'No reliable live price for this collection right now. Try a P2P loan instead.' }
  }
  const floor = eff.floorDrops
  const maxLoanDrops = (floor * BigInt(col.ltv_bps)) / 10000n
  return {
    ...info,
    eligible: info.transferable,
    reason: info.transferable ? undefined : 'NFT is not transferable',
    collection: col.name,
    floorDrops: floor.toString(),
    floorBasis: eff.basis,
    adminFloorDrops: col.floor_drops,
    liveFloorDrops: col.live_floor_drops,
    liveListings: col.live_listings,
    liveSource: col.live_source,
    liveUpdatedAt: col.live_updated_at,
    ltvBps: col.ltv_bps,
    maxLoanDrops: maxLoanDrops.toString(),
    aprBps: config.platformAprBps,
    maxDays: config.platformMaxDays,
  }
}
