/**
 * End-to-end test against the real XRPL testnet.
 * Spawns the API with a temp DB, creates user wallets via faucet, and walks every flow.
 *   npm run e2e
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import 'dotenv/config'
import { Client, Wallet, convertStringToHex, NFTokenMintFlags, type SubmittableTransaction } from 'xrpl'
import { sign as kpSign } from 'ripple-keypairs'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { randomBytes } from 'node:crypto'
import { convertToMultisig } from '../multisig.js'
import { submitWithWallet } from '../xrpl.js'

// E2E_MULTISIG=1 runs every flow against a fresh 2-of-3 multisig vault + the co-signer service.
const MULTISIG = process.env.E2E_MULTISIG === '1'
const COSIGNER_PORT = 8798

const PORT = 8799
const API = `http://localhost:${PORT}/api`
const dbPath = join(mkdtempSync(join(tmpdir(), 'xrpawn-e2e-')), 'e2e.db')
const proxy = process.env.HTTPS_PROXY
const XRP = (n: number) => String(Math.round(n * 1_000_000))

const step = (s: string) => console.log(`\n=== ${s}`)
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
  console.log(`  ok  ${msg}`)
}

const client = new Client(process.env.XRPL_WS_URL ?? 'wss://testnet.xrpl-labs.com', proxy ? { agent: new HttpsProxyAgent(proxy) as any } : {})
await client.connect()

async function faucet(): Promise<Wallet> {
  const w = Wallet.generate()
  const r = await fetch('https://faucet.altnet.rippletest.net/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ destination: w.classicAddress }) })
  if (!r.ok) throw new Error('faucet failed')
  for (let i = 0; i < 20; i++) {
    try { await client.request({ command: 'account_info', account: w.classicAddress }); return w } catch { await new Promise((r) => setTimeout(r, 2000)) }
  }
  throw new Error('account never funded')
}

async function send(w: Wallet, tx: SubmittableTransaction) {
  const r = await submitWithWallet(client, tx, w) // throws unless tesSUCCESS
  return { hash: r.hash, meta: r.meta }
}

const balance = async (a: string) => BigInt((await client.request({ command: 'account_info', account: a })).result.account_data.Balance)
const ownsNft = async (a: string, id: string) => ((await client.request({ command: 'account_nfts', account: a })).result.account_nfts as any[]).some((n) => n.NFTokenID === id)

async function call(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j: any = await r.json()
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${j.error}`)
  return j
}
async function callExpectError(method: string, path: string, body: unknown, token: string | undefined, status: number) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  assert(r.status === status, `${method} ${path} rejected with ${status} (got ${r.status}: ${((await r.json()) as any).error})`)
}

async function login(w: Wallet) {
  const ch = await call('POST', '/auth/challenge')
  const signature = kpSign(ch.hex, w.privateKey)
  return (await call('POST', '/auth/verify', { address: w.classicAddress, publicKey: w.publicKey, signature, nonce: ch.nonce })).token as string
}

async function mint(w: Wallet, n: number) {
  const r = await send(w, { TransactionType: 'NFTokenMint', Account: w.classicAddress, NFTokenTaxon: 7, Flags: NFTokenMintFlags.tfTransferable, URI: convertStringToHex(`ipfs://xrpawn-test/${n}.json`) })
  return r.meta.nftoken_id as string
}

async function depositToSafe(w: Wallet, token: string, nftId: string, vault: string) {
  const r = await send(w, { TransactionType: 'NFTokenCreateOffer', Account: w.classicAddress, NFTokenID: nftId, Amount: '0', Flags: 1, Destination: vault })
  return call('POST', '/custody/deposit', { txHash: r.hash }, token)
}

async function claimRelease(w: Wallet, token: string, nftId: string) {
  const list = await call('GET', '/custody', undefined, token)
  const row = list.find((c: any) => c.nft_id === nftId && c.status === 'releasing')
  assert(row?.release_offer, `release offer waiting for ${w.classicAddress.slice(0, 8)}`)
  await send(w, { TransactionType: 'NFTokenAcceptOffer', Account: w.classicAddress, NFTokenSellOffer: row.release_offer })
  const synced = await call('POST', `/custody/${nftId}/sync`, {}, token)
  assert(synced.status === 'released', 'custody marked released')
  assert(await ownsNft(w.classicAddress, nftId), 'NFT back in wallet')
}

// ------------------------------------------------------------------------------------------
step('Create test wallets')
const [alice, bob, carol] = await Promise.all([faucet(), faucet(), faucet()])
const admin = Wallet.generate() // only needs to sign in
console.log({ alice: alice.classicAddress, bob: bob.classicAddress, carol: carol.classicAddress, admin: admin.classicAddress })

const children: ReturnType<typeof spawn>[] = []
function startProc(label: string, script: string, env: Record<string, string | undefined>) {
  const p = spawn('npx', ['tsx', script], { env: { ...process.env, ...env } as any, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout!.on('data', (d) => process.stdout.write(`  [${label}] ${d}`))
  p.stderr!.on('data', (d) => { const s = String(d); if (!s.includes('Warning') && !s.includes('trace-warnings')) process.stdout.write(`  [${label}!] ${s}`) })
  children.push(p)
  return p
}
// own process groups so we can kill npx + tsx + node together
const stopServer = () => { for (const c of children) { try { process.kill(-c.pid!, 'SIGTERM') } catch { /* already gone */ } } }
process.on('exit', stopServer)

let apiEnv: Record<string, string | undefined> = {}
let multisigVault: Wallet | null = null
const cosignerToken = randomBytes(16).toString('hex')
if (MULTISIG) {
  step('Create a fresh 2-of-3 multisig vault + start the co-signer')
  multisigVault = await faucet()
  const apiSigner = Wallet.generate(), cosigner = Wallet.generate(), backup = Wallet.generate()
  await convertToMultisig(client, multisigVault, [apiSigner.classicAddress, cosigner.classicAddress, backup.classicAddress], 2)
  const flags = (await client.request({ command: 'account_info', account: multisigVault.classicAddress })).result.account_data.Flags
  assert((flags & 0x00100000) !== 0, 'vault master key is disabled on-ledger')
  const treasuryAddr = Wallet.fromSeed(process.env.TREASURY_SEED!).classicAddress
  startProc('cosigner', 'src/cosigner/index.ts', {
    COSIGNER_SEED: cosigner.seed, COSIGNER_TOKEN: cosignerToken, COSIGNER_PORT: String(COSIGNER_PORT),
    VAULT_ADDRESS: multisigVault.classicAddress, TREASURY_ADDRESS: treasuryAddr,
    COSIGNER_STATE_FILE: join(dbPath, '..', 'cosigner.json'),
    COSIGNER_MIN_LOAN_AGE_HOURS: '0', // the test fast-forwards due dates instead of waiting days
  })
  for (let i = 0; ; i++) {
    try { await fetch(`http://localhost:${COSIGNER_PORT}/health`); break } catch { if (i > 60) throw new Error('co-signer did not start'); await new Promise((r) => setTimeout(r, 500)) }
  }
  apiEnv = {
    VAULT_SEED: '', VAULT_ADDRESS: multisigVault.classicAddress, VAULT_SIGNER_SEED: apiSigner.seed,
    COSIGNER_URL: `http://localhost:${COSIGNER_PORT}`, COSIGNER_TOKEN: cosignerToken,
  }
}

step('Start API')
if (await fetch(API + '/config').then(() => true, () => false)) throw new Error(`Port ${PORT} already in use; stop the old server first`)
startProc('api', 'src/index.ts', { PORT: String(PORT), DB_PATH: dbPath, ADMIN_ADDRESSES: admin.classicAddress, JOB_INTERVAL_MS: '3600000', GRACE_HOURS: '0', ...apiEnv })
for (let i = 0; ; i++) {
  try { await fetch(API + '/config'); break } catch { if (i > 60) throw new Error('API did not start'); await new Promise((r) => setTimeout(r, 500)) }
}
const db = new DatabaseSync(dbPath)

try {
  const cfg = await call('GET', '/config')
  const { vault, treasury } = cfg
  assert(cfg.network === 'testnet', 'API on testnet')
  if (MULTISIG) assert(vault === multisigVault!.classicAddress, 'API uses the multisig vault')

  step('Sign in (challenge signature)')
  const [ta, tb, tc, tadmin] = await Promise.all([login(alice), login(bob), login(carol), login(admin)])
  assert((await call('GET', '/config', undefined, tadmin)).isAdmin, 'admin recognised')
  await callExpectError('POST', '/admin/collections', { issuer: alice.classicAddress, name: 'x', floorDrops: '1' }, ta, 403)

  step('Mint test NFTs (Alice is the artist)')
  const nft1 = await mint(alice, 1), nft2 = await mint(alice, 2), nft3 = await mint(alice, 3)
  console.log({ nft1, nft2, nft3 })

  step('Admin approves collection: floor 50 XRP, 40% LTV')
  await call('POST', '/admin/collections', { issuer: alice.classicAddress, taxon: 7, name: 'Test Punks', floorDrops: XRP(50), ltvBps: 4000 }, tadmin)
  const ap = await call('GET', `/appraise/${nft1}`)
  assert(ap.eligible && ap.maxLoanDrops === XRP(20), 'appraisal: max loan 20 XRP')

  // ---------------------------------------------------------------- SAFE
  step('Safe: deposit + withdraw NFT2')
  const dep2 = await depositToSafe(alice, ta, nft2, vault)
  assert(dep2.status === 'held' && dep2.owner === alice.classicAddress, 'NFT2 held in vault for Alice')
  assert(await ownsNft(vault, nft2), 'vault holds NFT2 on-ledger')
  await callExpectError('POST', `/custody/${nft2}/withdraw`, {}, tb, 404) // Bob can't withdraw Alice's NFT
  await call('POST', `/custody/${nft2}/withdraw`, {}, ta)
  await claimRelease(alice, ta, nft2)

  // ---------------------------------------------------------------- PLATFORM LOAN
  step('Pawn loan: 10 XRP for 30 days against NFT1')
  await depositToSafe(alice, ta, nft1, vault)
  await callExpectError('POST', '/loans/platform', { nftId: nft1, principalDrops: XRP(25), durationDays: 30 }, ta, 400) // over LTV
  const before = await balance(alice.classicAddress)
  const loan = await call('POST', '/loans/platform', { nftId: nft1, principalDrops: XRP(10), durationDays: 30 }, ta)
  assert(loan.status === 'active', 'loan active')
  assert((await balance(alice.classicAddress)) - before === BigInt(XRP(10)), 'Alice received 10 XRP')
  await callExpectError('POST', `/custody/${nft1}/withdraw`, {}, ta, 409) // collateral locked
  assert(loan.interest_drops === String(Math.ceil(10_000_000 * 2400 * 30 / 3650000)), `interest = ${loan.interest_drops} drops`)

  step('Repay pawn loan')
  const shortPay = await send(alice, { TransactionType: 'Payment', Account: alice.classicAddress, Destination: treasury, DestinationTag: loan.repay_tag, Amount: XRP(1) })
  const bShort = await balance(alice.classicAddress)
  await callExpectError('POST', `/loans/${loan.id}/repay`, { txHash: shortPay.hash }, undefined, 400)
  assert((await balance(alice.classicAddress)) - bShort === BigInt(XRP(1)), 'short payment refunded to Alice')
  const pay = await send(alice, { TransactionType: 'Payment', Account: alice.classicAddress, Destination: treasury, DestinationTag: loan.repay_tag, Amount: loan.amount_due_drops })
  const repaid = await call('POST', `/loans/${loan.id}/repay`, { txHash: pay.hash })
  assert(repaid.status === 'repaid', 'loan repaid')
  await callExpectError('POST', `/loans/${loan.id}/repay`, { txHash: pay.hash }, undefined, 409) // replay
  await claimRelease(alice, ta, nft1)

  // ---------------------------------------------------------------- P2P LOAN
  step('P2P loan: Alice asks 15 XRP / 20% / 10d on NFT3, Bob offers 12 XRP / 18%')
  await depositToSafe(alice, ta, nft3, vault)
  const req = await call('POST', '/loans/p2p', { nftId: nft3, principalDrops: XRP(15), aprBps: 2000, durationDays: 10 }, ta)
  assert(req.status === 'requested', 'request open')
  await callExpectError('POST', `/loans/${req.id}/offers`, { principalDrops: XRP(12), aprBps: 1800, durationDays: 10 }, ta, 400) // self
  const withOffer = await call('POST', `/loans/${req.id}/offers`, { principalDrops: XRP(12), aprBps: 1800, durationDays: 10 }, tb)
  const offer = withOffer.offers[0]
  const inbox = async (t: string) => (await call('GET', '/notifications', undefined, t)) as { items: any[]; unread: number }
  assert((await inbox(ta)).items.some((n) => n.kind === 'offer_received' && n.loan_id === req.id), 'borrower notified of new offer')
  await callExpectError('POST', `/loans/${req.id}/offers/${offer.id}/accept`, {}, tb, 404) // only borrower accepts
  const accepted = await call('POST', `/loans/${req.id}/offers/${offer.id}/accept`, {}, ta)
  assert(accepted.status === 'awaiting_funding' && accepted.lender === bob.classicAddress, 'offer accepted, awaiting Bob')
  assert((await inbox(tb)).items.some((n) => n.kind === 'offer_accepted'), 'lender notified to fund')

  step('Bob funds the loan directly to Alice')
  const fundTx = await send(bob, { TransactionType: 'Payment', Account: bob.classicAddress, Destination: alice.classicAddress, Amount: XRP(12) })
  const active = await call('POST', `/loans/${req.id}/fund`, { txHash: fundTx.hash }, tb)
  assert(active.status === 'active' && active.due_at, 'P2P loan active')

  step('Alice repays; Bob gets principal + interest - 10% platform fee')
  const bobBefore = await balance(bob.classicAddress)
  const aliceBeforeOver = await balance(alice.classicAddress)
  const p2pPay = await send(alice, { TransactionType: 'Payment', Account: alice.classicAddress, Destination: treasury, DestinationTag: active.repay_tag, Amount: String(BigInt(active.amount_due_drops) + 2_000_000n) })
  const p2pRepaid = await call('POST', `/loans/${req.id}/repay`, { txHash: p2pPay.hash })
  assert(p2pRepaid.status === 'repaid' && p2pRepaid.payout_tx, 'repaid and lender payout sent')
  const interest = BigInt(active.interest_drops)
  const expected = BigInt(XRP(12)) + interest - (interest * 1000n) / 10000n
  assert((await balance(bob.classicAddress)) - bobBefore === expected, `Bob received ${expected} drops`)
  assert((await inbox(tb)).items.some((n) => n.kind === 'payout' && n.loan_id === req.id), 'lender notified of payout')
  const aliceNet = aliceBeforeOver - (await balance(alice.classicAddress))
  assert(aliceNet > BigInt(active.amount_due_drops) && aliceNet < BigInt(active.amount_due_drops) + 1000n, 'Alice overpaid 2 XRP and got the excess back (net = amount due + fee)')
  await claimRelease(alice, ta, nft3)

  // ---------------------------------------------------------------- REMINDERS + AUTO-DETECTED REPAYMENT
  step('Reminders: pawn loan due in 20h -> reminder; then repaid without reporting -> detected from ledger')
  await depositToSafe(alice, ta, nft1, vault)
  const rl = await call('POST', '/loans/platform', { nftId: nft1, principalDrops: XRP(2), durationDays: 7 }, ta)
  db.prepare('UPDATE loans SET due_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) + 20 * 3600, rl.id)
  await call('POST', '/admin/jobs/run', {}, tadmin)
  const ib = await inbox(ta)
  assert(ib.items.some((n) => n.kind === 'due_soon' && n.loan_id === rl.id && /24 hours/.test(n.title)), '24h due reminder sent')
  await call('POST', '/admin/jobs/run', {}, tadmin)
  assert((await inbox(ta)).items.filter((n) => n.kind === 'due_soon' && n.loan_id === rl.id).length === 1, 'reminder not duplicated')
  await send(alice, { TransactionType: 'Payment', Account: alice.classicAddress, Destination: treasury, DestinationTag: rl.repay_tag, Amount: rl.amount_due_drops })
  await call('POST', '/admin/jobs/run', {}, tadmin) // Alice never calls /repay
  assert((await call('GET', `/loans/${rl.id}`)).status === 'repaid', 'unreported repayment detected on-ledger')
  await claimRelease(alice, ta, nft1)
  const readAll = await call('POST', '/notifications/read', {}, ta)
  assert(readAll.unread === 0, 'mark all notifications read')

  // ---------------------------------------------------------------- P2P DEFAULT
  step('P2P default: Bob lends on NFT3 again, Alice never repays -> NFT goes to Bob')
  await depositToSafe(alice, ta, nft3, vault)
  const r2 = await call('POST', '/loans/p2p', { nftId: nft3, principalDrops: XRP(5), aprBps: 1000, durationDays: 1 }, ta)
  const o2 = (await call('POST', `/loans/${r2.id}/offers`, { principalDrops: XRP(5), aprBps: 1000, durationDays: 1 }, tb)).offers[0]
  await call('POST', `/loans/${r2.id}/offers/${o2.id}/accept`, {}, ta)
  await send(bob, { TransactionType: 'Payment', Account: bob.classicAddress, Destination: alice.classicAddress, Amount: XRP(5) })
  // Bob does NOT report the payment; the job must find it on-ledger.
  await call('POST', '/admin/jobs/run', {}, tadmin)
  assert((await call('GET', `/loans/${r2.id}`)).status === 'active', 'job detected unreported funding payment')
  db.prepare('UPDATE loans SET due_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 10, r2.id)
  await call('POST', '/admin/jobs/run', {}, tadmin)
  assert((await call('GET', `/loans/${r2.id}`)).status === 'defaulted', 'loan defaulted')
  await claimRelease(bob, tb, nft3)
  assert((await inbox(ta)).items.some((n) => n.kind === 'defaulted' && n.loan_id === r2.id), 'borrower notified of default')

  if (MULTISIG) {
    step('Attack: compromised API asks the co-signer to give a vaulted NFT to a stranger')
    await depositToSafe(carol, tc, await mint(carol, 9), vault).then(async (dep: any) => {
      const tx = await client.autofill({ TransactionType: 'NFTokenCreateOffer', Account: vault, NFTokenID: dep.nft_id, Amount: '0', Flags: 1, Destination: admin.classicAddress }, 2)
      const r = await fetch(`http://localhost:${COSIGNER_PORT}/sign`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cosignerToken}` },
        body: JSON.stringify({ tx, context: { reason: 'default_to_lender', fundTx: fundTx.hash } }),
      })
      const j: any = await r.json()
      assert(r.status === 403, `co-signer refused theft (${j.error})`)
      const r2 = await fetch(`http://localhost:${COSIGNER_PORT}/sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: JSON.stringify({ tx }) })
      assert(r2.status === 401, 'co-signer rejects a wrong token')
    })
  }

  // ---------------------------------------------------------------- MARKETPLACE
  step('Marketplace: Alice lists NFT1 for 5 XRP, Carol buys (pays 5 + 2% broker fee)')
  const sell = await send(alice, { TransactionType: 'NFTokenCreateOffer', Account: alice.classicAddress, NFTokenID: nft1, Amount: XRP(5), Flags: 1, Destination: treasury })
  const listing = await call('POST', '/market/listings', { txHash: sell.hash }, ta)
  assert(listing.price_drops === XRP(5.1), 'buyer price 5.1 XRP')
  const lowBid = await send(carol, { TransactionType: 'NFTokenCreateOffer', Account: carol.classicAddress, NFTokenID: nft1, Amount: XRP(5), Owner: alice.classicAddress })
  await callExpectError('POST', `/market/listings/${listing.id}/buy`, { txHash: lowBid.hash }, tc, 400)
  const bid = await send(carol, { TransactionType: 'NFTokenCreateOffer', Account: carol.classicAddress, NFTokenID: nft1, Amount: listing.price_drops, Owner: alice.classicAddress })
  const aliceBefore = await balance(alice.classicAddress)
  const sold = await call('POST', `/market/listings/${listing.id}/buy`, { txHash: bid.hash }, tc)
  assert(sold.status === 'sold', 'listing sold')
  assert(await ownsNft(carol.classicAddress, nft1), 'Carol owns NFT1')
  assert((await balance(alice.classicAddress)) - aliceBefore === BigInt(XRP(5)), 'Alice received exactly her 5 XRP ask')

  // ---------------------------------------------------------------- PAWN DEFAULT -> SHOP
  step('Pawn default: NFT2 forfeited -> shop inventory -> sold to Carol')
  await depositToSafe(alice, ta, nft2, vault)
  const l3 = await call('POST', '/loans/platform', { nftId: nft2, principalDrops: XRP(3), durationDays: 7 }, ta)
  db.prepare('UPDATE loans SET due_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 10, l3.id)
  await call('POST', '/admin/jobs/run', {}, tadmin)
  const ov = await call('GET', '/admin/overview', undefined, tadmin)
  assert(ov.inventory.some((c: any) => c.nft_id === nft2), 'NFT2 in shop inventory')
  const shop = await call('POST', `/admin/inventory/${nft2}/list`, { askDrops: XRP(8) }, tadmin)
  const shopBid = await send(carol, { TransactionType: 'NFTokenCreateOffer', Account: carol.classicAddress, NFTokenID: nft2, Amount: shop.price_drops, Owner: vault })
  await call('POST', `/market/listings/${shop.id}/buy`, { txHash: shopBid.hash }, tc)
  assert(await ownsNft(carol.classicAddress, nft2), 'Carol owns NFT2 from the shop')

  console.log('\nALL E2E CHECKS PASSED')
} finally {
  stopServer()
  await client.disconnect()
  process.exit(process.exitCode ?? 0)
}
