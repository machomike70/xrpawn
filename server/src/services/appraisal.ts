/**
 * Appraisal: what the platform will lend against an NFT.
 * MVP uses an admin-maintained table of approved collections (issuer + taxon) with a floor value.
 * Plug a live price feed in here later (set PRICE_FEED_URL / PRICE_FEED_API_KEY in .env).
 */
import { config } from '../config.js'
import { all, now, one, run } from '../db.js'
import { HttpError, describeNft } from '../xrpl.js'

export interface CollectionRow {
  issuer: string
  taxon: number
  name: string
  floor_drops: string
  ltv_bps: number
  updated_at: number
}

export const listCollections = () => all<CollectionRow>('SELECT * FROM collections ORDER BY name')

export function upsertCollection(c: { issuer: string; taxon: number; name: string; floorDrops: string; ltvBps?: number }) {
  if (!/^\d+$/.test(c.floorDrops)) throw new HttpError(400, 'floorDrops must be an integer string')
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

export function appraise(nftId: string) {
  const info = describeNft(nftId)
  const col =
    one<CollectionRow>('SELECT * FROM collections WHERE issuer = ? AND taxon = ?', info.issuer, info.taxon) ??
    one<CollectionRow>('SELECT * FROM collections WHERE issuer = ? AND taxon = -1', info.issuer)
  if (!col) {
    return { ...info, eligible: false, reason: 'Collection is not approved for platform loans yet. You can still request a P2P loan.' }
  }
  const floor = BigInt(col.floor_drops)
  const maxLoanDrops = (floor * BigInt(col.ltv_bps)) / 10000n
  return {
    ...info,
    eligible: info.transferable,
    reason: info.transferable ? undefined : 'NFT is not transferable',
    collection: col.name,
    floorDrops: floor.toString(),
    ltvBps: col.ltv_bps,
    maxLoanDrops: maxLoanDrops.toString(),
    aprBps: config.platformAprBps,
    maxDays: config.platformMaxDays,
  }
}
