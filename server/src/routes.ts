import { Router, type Request } from 'express'
import { config } from './config.js'
import { createChallenge, logout, requireAdmin, requireAuth, sessionAddress, verifyChallenge } from './auth.js'
import { all } from './db.js'
import {
  HttpError, decodeUri, describeNft, getAccountNfts, getClient, getSpendableDrops, treasuryWallet, vaultAddress,
} from './xrpl.js'
import * as custody from './services/custody.js'
import * as appraisal from './services/appraisal.js'
import * as loans from './services/loans.js'
import * as market from './services/market.js'
import * as xaman from './services/xaman.js'
import { feedConfig } from './services/pricefeed.js'
import * as notifications from './services/notify.js'

export const api = Router()

const id = (req: Request, name = 'id') => {
  const n = Number(req.params[name])
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`)
  return n
}
const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v) throw new HttpError(400, `${name} is required`)
  return v
}
const isAdmin = (addr?: string | null) => !!addr && config.adminAddresses.includes(addr)

// ---------------------------------------------------------------- public info
api.get('/config', (req, res) => {
  const me = sessionAddress(req)
  res.json({
    network: config.network,
    vault: vaultAddress(),
    treasury: treasuryWallet().classicAddress,
    explorer: config.network === 'mainnet' ? 'https://livenet.xrpl.org' : `https://${config.network}.xrpl.org`,
    platformAprBps: config.platformAprBps,
    platformMaxDays: config.platformMaxDays,
    p2pFeeBps: config.p2pFeeBps,
    marketFeeBps: config.marketFeeBps,
    priceFeed: feedConfig().provider,
    vaultMultisig: config.vaultMultisig,
    graceHours: config.graceHours,
    fundingWindowHours: config.fundingWindowHours,
    xaman: xaman.xamanEnabled(),
    devWallet: config.network !== 'mainnet',
    me,
    isAdmin: isAdmin(me),
  })
})

api.get('/nfts/:address', async (req, res) => {
  const nfts = await getAccountNfts(String(req.params.address))
  res.json(nfts.map((n) => ({ ...describeNft(n.NFTokenID), uri: decodeUri(n.URI) })))
})

// ---------------------------------------------------------------- auth
api.post('/auth/challenge', (_req, res) => res.json(createChallenge()))
api.post('/auth/verify', (req, res) => {
  const { address, publicKey, signature, nonce } = req.body ?? {}
  const token = verifyChallenge({ address: str(address, 'address'), publicKey: str(publicKey, 'publicKey'), signature: str(signature, 'signature'), nonce: str(nonce, 'nonce') })
  res.json({ token, address })
})
api.post('/auth/logout', (req, res) => { logout(req); res.json({ ok: true }) })

// ---------------------------------------------------------------- xaman
api.post('/xaman/signin', async (_req, res) => res.json(await xaman.createSignIn()))
api.post('/xaman/tx', requireAuth, async (req, res) => {
  const txjson = { ...(req.body?.txjson ?? {}), Account: req.address }
  res.json(await xaman.createTxPayload(txjson))
})
api.get('/xaman/payload/:uuid', async (req, res) => res.json(await xaman.payloadStatus(String(req.params.uuid))))

// ---------------------------------------------------------------- dev wallet relay (testnet/devnet only)
api.post('/xrpl/prepare', async (req, res) => {
  if (config.network === 'mainnet') throw new HttpError(403, 'Disabled on mainnet')
  const c = await getClient()
  res.json(await c.autofill(req.body.tx))
})
api.post('/xrpl/submit', async (req, res) => {
  if (config.network === 'mainnet') throw new HttpError(403, 'Disabled on mainnet')
  const c = await getClient()
  const r: any = await c.submitAndWait(str(req.body.tx_blob, 'tx_blob'))
  res.json({ hash: r.result.hash, result: r.result.meta?.TransactionResult, meta: r.result.meta })
})
api.post('/xrpl/faucet', async (req, res) => {
  if (config.network === 'mainnet') throw new HttpError(403, 'Disabled on mainnet')
  const r = await fetch(`https://faucet.alt${config.network === 'devnet' ? 'devnet' : 'net'}.rippletest.net/accounts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ destination: str(req.body.address, 'address') }),
  })
  if (!r.ok) throw new HttpError(502, 'Faucet unavailable')
  res.json({ ok: true })
})

// ---------------------------------------------------------------- safe / custody
api.get('/custody', requireAuth, (req, res) => res.json(custody.listCustody(req.address!)))
api.post('/custody/deposit', requireAuth, async (req, res) => res.json(await custody.deposit(req.address!, str(req.body.txHash, 'txHash'))))
api.post('/custody/:nftId/withdraw', requireAuth, async (req, res) => res.json(await custody.withdraw(req.address!, String(req.params.nftId))))
api.post('/custody/:nftId/sync', requireAuth, async (req, res) => res.json(await custody.syncRelease(String(req.params.nftId).toUpperCase()) ?? null))

// ---------------------------------------------------------------- appraisal
api.get('/appraise/:nftId', (req, res) => res.json(appraisal.appraise(String(req.params.nftId))))
api.get('/collections', (_req, res) => res.json(appraisal.listCollections()))

// ---------------------------------------------------------------- loans
api.get('/loans', (req, res) => {
  const q = req.query
  if (q.mine) {
    const a = sessionAddress(req)
    if (!a) throw new HttpError(401, 'Connect your wallet first')
    return res.json(loans.listLoans({ address: a }))
  }
  res.json(loans.listLoans({ status: typeof q.status === 'string' ? q.status : undefined }))
})
api.get('/loans/:id', (req, res) => {
  const l = loans.getLoan(id(req))
  if (!l) throw new HttpError(404, 'Loan not found')
  res.json(loans.loanView(l))
})
api.post('/loans/platform', requireAuth, async (req, res) => {
  const b = req.body ?? {}
  res.json(await loans.createPlatformLoan(req.address!, str(b.nftId, 'nftId'), str(b.principalDrops, 'principalDrops'), Number(b.durationDays)))
})
api.post('/loans/p2p', requireAuth, async (req, res) => {
  const b = req.body ?? {}
  res.json(await loans.requestP2PLoan(req.address!, str(b.nftId, 'nftId'), str(b.principalDrops, 'principalDrops'), Number(b.aprBps), Number(b.durationDays)))
})
api.post('/loans/:id/cancel', requireAuth, async (req, res) => res.json(await loans.cancelP2PRequest(req.address!, id(req))))
api.post('/loans/:id/offers', requireAuth, (req, res) => {
  const b = req.body ?? {}
  res.json(loans.makeOffer(req.address!, id(req), str(b.principalDrops, 'principalDrops'), Number(b.aprBps), Number(b.durationDays)))
})
api.post('/loans/:id/offers/:offerId/accept', requireAuth, async (req, res) => res.json(await loans.acceptOffer(req.address!, id(req), id(req, 'offerId'))))
api.post('/offers/:offerId/withdraw', requireAuth, (req, res) => res.json(loans.withdrawOffer(req.address!, id(req, 'offerId'))))
api.post('/loans/:id/fund', requireAuth, async (req, res) => res.json(await loans.reportFunding(req.address!, id(req), str(req.body.txHash, 'txHash'))))
api.post('/loans/:id/repay', async (req, res) => res.json(await loans.reportRepayment(id(req), str(req.body.txHash, 'txHash'))))

// ---------------------------------------------------------------- marketplace
api.get('/market/listings', (req, res) => {
  res.json(market.listListings({ seller: typeof req.query.seller === 'string' ? req.query.seller : undefined, status: typeof req.query.status === 'string' ? req.query.status : undefined }))
})
api.post('/market/listings', requireAuth, async (req, res) => res.json(await market.createListing(req.address!, str(req.body.txHash, 'txHash'))))
api.post('/market/listings/:id/buy', requireAuth, async (req, res) => res.json(await market.buy(req.address!, id(req), str(req.body.txHash, 'txHash'))))
api.post('/market/listings/:id/cancel', requireAuth, async (req, res) => res.json(await market.cancelListing(req.address!, id(req), isAdmin(req.address))))

// ---------------------------------------------------------------- notifications
api.get('/notifications', requireAuth, (req, res) => res.json(notifications.listNotifications(req.address!)))
api.post('/notifications/read', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : undefined
  notifications.markRead(req.address!, ids)
  res.json(notifications.listNotifications(req.address!))
})

// ---------------------------------------------------------------- admin
api.get('/admin/overview', requireAdmin, async (_req, res) => {
  const treasury = treasuryWallet().classicAddress
  res.json({
    treasury,
    vault: vaultAddress(),
    treasurySpendableDrops: (await getSpendableDrops(treasury)).toString(),
    loans: all("SELECT kind, status, COUNT(*) AS n, SUM(CAST(principal_drops AS INTEGER)) AS principal FROM loans GROUP BY kind, status"),
    inventory: all("SELECT * FROM custody WHERE purpose='inventory' AND status='held'"),
    custodyCount: all("SELECT purpose, COUNT(*) AS n FROM custody WHERE status != 'released' GROUP BY purpose"),
  })
})
api.post('/admin/collections', requireAdmin, (req, res) => {
  const b = req.body ?? {}
  appraisal.upsertCollection({ issuer: str(b.issuer, 'issuer'), taxon: Number(b.taxon ?? -1), name: str(b.name, 'name'), floorDrops: str(b.floorDrops, 'floorDrops'), ltvBps: b.ltvBps ? Number(b.ltvBps) : undefined })
  res.json(appraisal.listCollections())
})
api.delete('/admin/collections/:issuer/:taxon', requireAdmin, (req, res) => {
  appraisal.deleteCollection(String(req.params.issuer), Number(req.params.taxon))
  res.json(appraisal.listCollections())
})
api.post('/admin/collections/refresh', requireAdmin, async (_req, res) => {
  await appraisal.refreshFloors()
  res.json(appraisal.listCollections())
})
api.post('/admin/inventory/:nftId/list', requireAdmin, async (req, res) => res.json(await market.createShopListing(String(req.params.nftId), str(req.body.askDrops, 'askDrops'))))
api.post('/admin/jobs/run', requireAdmin, async (_req, res) => {
  const { runJobs } = await import('./jobs.js')
  await runJobs()
  res.json({ ok: true })
})
