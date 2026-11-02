import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkVaultTx, PolicyError, type PolicyConfig, type PolicyDeps, type ProofTx } from './policy.js'

const VAULT = 'rVAULT', BROKER = 'rBROKER', ALICE = 'rALICE', BOB = 'rBOB', MALLORY = 'rMALLORY'
const NFT = 'A'.repeat(64)
const FUND = 'F'.repeat(64)
const NOW = 1_800_000_000
const DAY = 86400

const cfg: PolicyConfig = {
  vault: VAULT, broker: BROKER, maxFeeDrops: 5000n, minLoanAgeHours: 96, minProofDrops: 1_000_000n,
  shopMinBps: 5000, dailyReturnLimit: 3, dailyTransferLimit: 2,
}

function deps(over: Partial<PolicyDeps> & { proof?: Partial<ProofTx>; offer?: Record<string, any> | null } = {}): PolicyDeps {
  const proofs: Record<string, string> = {}
  const counts: Record<string, number> = {}
  return {
    getOffer: async () => (over.offer === undefined ? { Flags: 1, Destination: VAULT, Amount: '0', Owner: ALICE } : over.offer),
    findDeposit: async () => ({ depositor: ALICE, closeTimeUnix: NOW - 10 * DAY }),
    getProofTx: async () => ({ type: 'Payment', account: BOB, destination: ALICE, deliveredDrops: 50_000_000n, closeTimeUnix: NOW - 5 * DAY, ...over.proof }),
    now: () => NOW,
    claimProof: (k, r) => { if (proofs[k] && proofs[k] !== r) return false; proofs[k] = r; return true },
    bump: (k) => (counts[k] = (counts[k] ?? 0) + 1),
    ...over,
  }
}

const base = { Account: VAULT, SigningPubKey: '', Fee: '36' }
const offer = (o: Record<string, any>) => ({ ...base, TransactionType: 'NFTokenCreateOffer', NFTokenID: NFT, Flags: 1, ...o })
const refuses = async (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: any) => e instanceof PolicyError && re.test(e.message))

test('accepts a free deposit addressed to the vault', async () => {
  assert.match(await checkVaultTx({ ...base, TransactionType: 'NFTokenAcceptOffer', NFTokenSellOffer: 'X' }, {}, deps(), cfg), /deposit/)
})

test('refuses to buy NFTs (accepting a priced sell offer would spend vault XRP)', async () => {
  await refuses(checkVaultTx({ ...base, TransactionType: 'NFTokenAcceptOffer', NFTokenSellOffer: 'X' }, {},
    deps({ offer: { Flags: 1, Destination: VAULT, Amount: '5000000', Owner: MALLORY } }), cfg), /free/)
})

test('refuses payments and account changes from the vault', async () => {
  await refuses(checkVaultTx({ ...base, TransactionType: 'Payment', Destination: MALLORY, Amount: '1' }, {}, deps(), cfg), /may not/)
  await refuses(checkVaultTx({ ...base, TransactionType: 'SignerListSet' }, {}, deps(), cfg), /may not/)
})

test('refuses single-signed transactions and high fees', async () => {
  await refuses(checkVaultTx(offer({ Amount: '0', Destination: ALICE, SigningPubKey: 'ED00' }), {}, deps(), cfg), /multisigned/)
  await refuses(checkVaultTx(offer({ Amount: '0', Destination: ALICE, Fee: '9000000' }), {}, deps(), cfg), /Fee/)
})

test('returns an NFT to its depositor without proof', async () => {
  assert.match(await checkVaultTx(offer({ Amount: '0', Destination: ALICE }), {}, deps(), cfg), /return NFT to depositor/)
})

test('refuses to give an NFT to a stranger without loan proof', async () => {
  await refuses(checkVaultTx(offer({ Amount: '0', Destination: MALLORY }), {}, deps(), cfg), /fundTx/)
})

test('refuses default transfer when the proof was paid by someone else', async () => {
  await refuses(checkVaultTx(offer({ Amount: '0', Destination: MALLORY }), { fundTx: FUND }, deps(), cfg), /not paid by the recipient/)
})

test('refuses default transfer when the loan is too young to be in default', async () => {
  await refuses(checkVaultTx(offer({ Amount: '0', Destination: BOB }), { fundTx: FUND },
    deps({ proof: { closeTimeUnix: NOW - 1 * DAY } }), cfg), /minimum before default/)
})

test('refuses proof that predates the deposit or is tiny', async () => {
  await refuses(checkVaultTx(offer({ Amount: '0', Destination: BOB }), { fundTx: FUND },
    deps({ proof: { closeTimeUnix: NOW - 20 * DAY } }), cfg), /predates/)
  await refuses(checkVaultTx(offer({ Amount: '0', Destination: BOB }), { fundTx: FUND },
    deps({ proof: { deliveredDrops: 10n } }), cfg), /too small/)
})

test('allows a defaulted loan to go to the lender, and one payment cannot be redirected', async () => {
  const d = deps()
  assert.match(await checkVaultTx(offer({ Amount: '0', Destination: BOB }), { fundTx: FUND }, d, cfg), /default transfer to lender/)
  // Re-issuing the same transfer (expired offer) is fine
  assert.match(await checkVaultTx(offer({ Amount: '0', Destination: BOB }), { fundTx: FUND }, d, cfg), /lender/)
})

test('enforces the daily transfer limit', async () => {
  const d = deps()
  await checkVaultTx(offer({ Amount: '0', Destination: BOB }), { fundTx: FUND }, d, cfg)
  await checkVaultTx(offer({ Amount: '0', Destination: BOB }), { fundTx: FUND }, d, cfg)
  await refuses(checkVaultTx(offer({ Amount: '0', Destination: BOB }), { fundTx: FUND }, d, cfg), /Daily transfer limit/)
})

test('shop listings need a treasury pawn loan and a minimum price, and must go through the broker', async () => {
  const pawn = { proof: { account: BROKER, deliveredDrops: 10_000_000n } }
  assert.match(await checkVaultTx(offer({ Amount: '6000000', Destination: BROKER }), { fundTx: FUND }, deps(pawn), cfg), /shop listing/)
  await refuses(checkVaultTx(offer({ Amount: '1000000', Destination: BROKER }), { fundTx: FUND }, deps(pawn), cfg), /at least 5000000/)
  await refuses(checkVaultTx(offer({ Amount: '6000000', Destination: MALLORY }), { fundTx: FUND }, deps(pawn), cfg), /broker/)
  await refuses(checkVaultTx(offer({ Amount: '6000000', Destination: BROKER }), { fundTx: FUND }, deps(), cfg), /not paid by the recipient/)
})

test('refuses buy offers and odd flags', async () => {
  await refuses(checkVaultTx(offer({ Amount: '0', Destination: ALICE, Flags: 0, Owner: MALLORY }), {}, deps(), cfg), /plain sell offers/)
})
