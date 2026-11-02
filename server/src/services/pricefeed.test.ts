import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { computeFloor, effectiveFloor, fetchFloor } from './pricefeed.js'

const XRP = (n: number) => BigInt(Math.round(n * 1e6))
const NOW = 1_800_000_000

test('computeFloor: lowest ask, but only with enough listings', () => {
  assert.equal(computeFloor([XRP(50), XRP(40), XRP(90)], 3)?.floorDrops, XRP(40))
  assert.equal(computeFloor([XRP(50), XRP(40)], 3), null)
  assert.equal(computeFloor([0n, XRP(1), XRP(2)], 3), null) // zero-priced giveaways don't count
})

test('effectiveFloor: admin floor is a hard cap; live price can only lower it', () => {
  const base = { now: NOW, maxAgeMin: 60, required: false }
  assert.deepEqual(effectiveFloor({ ...base, adminFloorDrops: XRP(100), live: { floorDrops: XRP(60), updatedAt: NOW - 60 } }), { floorDrops: XRP(60), basis: 'live' })
  assert.deepEqual(effectiveFloor({ ...base, adminFloorDrops: XRP(100), live: { floorDrops: XRP(500), updatedAt: NOW - 60 } }), { floorDrops: XRP(100), basis: 'live_capped' })
  assert.deepEqual(effectiveFloor({ ...base, adminFloorDrops: 0n, live: { floorDrops: XRP(500), updatedAt: NOW - 60 } }), { floorDrops: XRP(500), basis: 'live' })
})

test('effectiveFloor: stale or missing live price falls back to admin floor, unless required', () => {
  const stale = { floorDrops: XRP(10), updatedAt: NOW - 2 * 3600 }
  assert.deepEqual(effectiveFloor({ adminFloorDrops: XRP(100), live: stale, now: NOW, maxAgeMin: 60, required: false }), { floorDrops: XRP(100), basis: 'admin' })
  assert.equal(effectiveFloor({ adminFloorDrops: XRP(100), live: stale, now: NOW, maxAgeMin: 60, required: true }), null)
  assert.equal(effectiveFloor({ adminFloorDrops: 0n, live: null, now: NOW, maxAgeMin: 60, required: false }), null)
})

// ---------------------------------------------------------------- providers against a mock server
const ISSUER = 'rISSUER', BROKER = 'rBROKER'
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.startsWith('/http/')) {
      if (req.headers.authorization !== 'Bearer k123') { res.statusCode = 401; return res.end('{}') }
      return res.end(JSON.stringify({ floorXrp: 42.5, listings: 7 }))
    }
    if (req.url?.startsWith('/bithomp/nfts')) {
      if (req.headers['x-bithomp-token'] !== 'bt') { res.statusCode = 401; return res.end('{}') }
      return res.end(JSON.stringify({ nfts: [
        { sellOffers: [{ amount: '30000000' }, { amount: '1000', destination: 'rPRIVATE' }] }, // private offer ignored
        { sellOffers: [{ amount: '25000000', destination: BROKER }] }, // known broker counts
        { sellOffers: [{ amount: { currency: 'USD', value: '1' } }] }, // tokens ignored
        { sellOffers: [{ amount: '50000000' }, { amount: '5000000', valid: false }] }, // invalid ignored
      ] }))
    }
    // Clio JSON-RPC
    const { method, params } = JSON.parse(body || '{}')
    if (method === 'nfts_by_issuer') return res.end(JSON.stringify({ result: { nfts: [{ nft_id: 'N1' }, { nft_id: 'N2' }, { nft_id: 'N3', is_burned: true }] } }))
    if (method === 'nft_sell_offers') {
      const offers = params[0].nft_id === 'N1'
        ? [{ amount: '20000000' }, { amount: '19000000' }]
        : [{ amount: '21000000' }, { amount: '1', destination: 'rFRIEND' }]
      return res.end(JSON.stringify({ result: { offers } }))
    }
    res.end(JSON.stringify({ result: { error: 'unknownCmd' } }))
  })
})
await new Promise<void>((r) => server.listen(0, r))
const base = `http://127.0.0.1:${(server.address() as any).port}`
after(() => server.close())

test('http provider', async () => {
  Object.assign(process.env, { PRICE_FEED: 'http', PRICE_FEED_URL: `${base}/http/{issuer}/{taxon}`, PRICE_FEED_API_KEY: 'k123', PRICE_FEED_MIN_LISTINGS: '3' })
  const q = await fetchFloor(ISSUER, 1)
  assert.equal(q?.floorDrops, XRP(42.5))
  process.env.PRICE_FEED_MIN_LISTINGS = '10'
  assert.equal(await fetchFloor(ISSUER, 1), null) // too few listings
})

test('clio provider reads public XRP asks from the ledger', async () => {
  Object.assign(process.env, { PRICE_FEED: 'clio', CLIO_URL: base, PRICE_FEED_MIN_LISTINGS: '3', PRICE_FEED_BROKERS: '' })
  const q = await fetchFloor(ISSUER, 1)
  assert.equal(q?.floorDrops, XRP(19))
  assert.equal(q?.listings, 3) // private offer to rFRIEND and burned NFT excluded
})

test('bithomp provider filters private, token and invalid offers', async () => {
  Object.assign(process.env, { PRICE_FEED: 'bithomp', BITHOMP_API_URL: `${base}/bithomp`, BITHOMP_API_KEY: 'bt', PRICE_FEED_MIN_LISTINGS: '3', PRICE_FEED_BROKERS: BROKER })
  const q = await fetchFloor(ISSUER, 1)
  assert.equal(q?.floorDrops, XRP(25))
  assert.equal(q?.listings, 3)
})
