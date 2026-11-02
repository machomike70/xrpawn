/**
 * XRPawn vault co-signer: a separate service holding the second vault signer key.
 * Run it on a different machine/account than the API so one compromised box cannot move NFTs.
 *
 *   COSIGNER_SEED=s...  COSIGNER_TOKEN=...  VAULT_ADDRESS=r...  TREASURY_ADDRESS=r...  npm run cosigner
 *
 * The API POSTs {tx, context} to /sign with the shared bearer token. The co-signer checks the transaction
 * against src/cosigner/policy.ts using only ledger data, then returns its multisig signature.
 */
import 'dotenv/config'
import express from 'express'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { Wallet } from 'xrpl'
import { getClient, getNftOffer, getValidatedTx, deliveredDrops } from '../xrpl.js'
import { PolicyError, checkVaultTx, type Deposit, type PolicyConfig, type PolicyDeps } from './policy.js'

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (!v) throw new Error(`Missing env ${name}`)
  return v
}

const wallet = Wallet.fromSeed(env('COSIGNER_SEED'))
const token = env('COSIGNER_TOKEN')
const port = Number(env('COSIGNER_PORT', '8788'))
const stateFile = env('COSIGNER_STATE_FILE', 'data/cosigner-state.json')

const cfg: PolicyConfig = {
  vault: env('VAULT_ADDRESS'),
  broker: env('TREASURY_ADDRESS'),
  maxFeeDrops: BigInt(env('COSIGNER_MAX_FEE_DROPS', '5000')),
  minLoanAgeHours: Number(env('COSIGNER_MIN_LOAN_AGE_HOURS', '96')), // 1-day minimum term + 72h grace
  minProofDrops: BigInt(env('COSIGNER_MIN_PROOF_DROPS', '1000000')),
  shopMinBps: Number(env('COSIGNER_SHOP_MIN_BPS', '5000')),
  dailyReturnLimit: Number(env('COSIGNER_DAILY_RETURN_LIMIT', '500')),
  dailyTransferLimit: Number(env('COSIGNER_DAILY_TRANSFER_LIMIT', '20')),
}

// ---------------------------------------------------------------- tiny persistent state
interface State { proofs: Record<string, string>; events: { kind: string; t: number }[] }
mkdirSync(dirname(stateFile), { recursive: true })
const state: State = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { proofs: {}, events: [] }
const save = () => writeFileSync(stateFile, JSON.stringify(state))

// ---------------------------------------------------------------- ledger lookups
async function findDeposit(nftId: string): Promise<Deposit | null> {
  const c = await getClient()
  let marker: unknown
  for (let page = 0; page < 20; page++) {
    const r: any = await c.request({ command: 'account_tx', account: cfg.vault, limit: 200, forward: false, marker } as any)
    for (const e of r.result.transactions) {
      const t = e.tx_json ?? e.tx
      if (!e.validated || t?.TransactionType !== 'NFTokenAcceptOffer' || t.Account !== cfg.vault) continue
      if (e.meta?.TransactionResult !== 'tesSUCCESS') continue
      for (const n of e.meta.AffectedNodes ?? []) {
        const d = n.DeletedNode
        const f = d?.FinalFields
        if (d?.LedgerEntryType === 'NFTokenOffer' && f?.NFTokenID === nftId && f.Destination === cfg.vault && f.Amount === '0') {
          return { depositor: f.Owner, closeTimeUnix: e.close_time_iso ? Date.parse(e.close_time_iso) / 1000 : 0 }
        }
      }
    }
    marker = r.result.marker
    if (!marker) break
  }
  return null
}

const deps: PolicyDeps = {
  getOffer: getNftOffer,
  findDeposit,
  async getProofTx(hash) {
    const v = await getValidatedTx(hash).catch((e) => { throw new PolicyError(`Loan proof invalid: ${e.message}`) })
    return { type: v.tx.TransactionType, account: v.tx.Account, destination: v.tx.Destination, deliveredDrops: deliveredDrops(v.meta), closeTimeUnix: v.closeTimeUnix }
  },
  now: () => Date.now() / 1000,
  claimProof(key, recipient) {
    const prev = state.proofs[key]
    if (prev && prev !== recipient) return false
    state.proofs[key] = recipient
    save()
    return true
  },
  bump(kind) {
    const since = Date.now() / 1000 - 86400
    state.events = state.events.filter((e) => e.t > since)
    state.events.push({ kind, t: Date.now() / 1000 })
    save()
    return state.events.filter((e) => e.kind === kind).length
  },
}

// ---------------------------------------------------------------- http
const app = express()
app.use(express.json({ limit: '50kb' }))

function authorized(h?: string) {
  const a = Buffer.from(h ?? '')
  const b = Buffer.from(`Bearer ${token}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

app.get('/health', (_req, res) => res.json({ ok: true, signer: wallet.classicAddress, vault: cfg.vault }))

app.post('/sign', async (req, res) => {
  if (!authorized(req.header('authorization'))) return res.status(401).json({ error: 'unauthorized' })
  const { tx, context } = req.body ?? {}
  try {
    const what = await checkVaultTx(tx, context ?? {}, deps, cfg)
    const signed = wallet.sign(tx, true)
    console.log(new Date().toISOString(), 'SIGNED', tx.TransactionType, what)
    res.json({ tx_blob: signed.tx_blob, signer: wallet.classicAddress })
  } catch (e: any) {
    const msg = e instanceof PolicyError ? e.message : `internal: ${e?.message}`
    console.warn(new Date().toISOString(), 'REFUSED', tx?.TransactionType, msg)
    res.status(e instanceof PolicyError ? 403 : 500).json({ error: msg })
  }
})

await getClient()
app.listen(port, () => console.log(`XRPawn vault co-signer on :${port}  signer=${wallet.classicAddress} vault=${cfg.vault}`))
