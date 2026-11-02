/**
 * Loans secured by NFTs held in the vault.
 *
 * Platform (pawn) loan: NFT in Safe -> borrower requests up to LTV x floor -> treasury pays XRP immediately.
 * P2P loan: NFT in Safe -> borrower posts terms -> lenders make offers -> borrower accepts one
 *           -> lender pays borrower directly on-ledger -> loan active.
 * Repay (both): borrower pays principal + interest to the treasury with the loan's DestinationTag.
 *           The vault releases the NFT to the borrower; for P2P the treasury forwards the repayment
 *           minus the platform fee to the lender.
 * Default: unpaid after due date + grace -> P2P: NFT released to lender. Platform: NFT goes to shop inventory.
 *
 * Interest is a fixed fee for the whole term: principal x APR x days / 365 (repaying early costs the same).
 */
import { convertStringToHex } from 'xrpl'
import { config } from '../config.js'
import { all, claimTx, now, one, run, tx, unclaimTx, withLock } from '../db.js'
import {
  HttpError, deliveredDrops, getClient, getSpendableDrops, getValidatedTx, submitAsPlatform, treasuryWallet,
} from '../xrpl.js'
import { appraise } from './appraisal.js'
import { getCustody, releaseTo } from './custody.js'
import { notify, once, pushRepayment } from './notify.js'
import { xrpToDrops, dropsToXrp } from 'xrpl'

const X = (drops: bigint | string) => `${dropsToXrp(String(drops))} XRP`
void xrpToDrops

export interface LoanRow {
  id: number
  kind: 'platform' | 'p2p'
  status: 'requested' | 'awaiting_funding' | 'active' | 'repaid' | 'defaulted' | 'cancelled'
  borrower: string
  lender: string | null
  nft_id: string
  principal_drops: string
  apr_bps: number
  duration_days: number
  interest_drops: string
  accepted_offer_id: number | null
  accepted_at: number | null
  fund_tx: string | null
  funded_at: number | null
  due_at: number | null
  repay_tx: string | null
  repaid_at: number | null
  payout_tx: string | null
  payout_drops: string | null
  defaulted_at: number | null
  created_at: number
  updated_at: number
}

const REPAY_TAG_OFFSET = 1_000_000
export const repayTag = (loanId: number) => REPAY_TAG_OFFSET + loanId

export function interestFor(principal: bigint, aprBps: number, days: number): bigint {
  const num = principal * BigInt(aprBps) * BigInt(days)
  const den = 365n * 10000n
  return (num + den - 1n) / den // round up
}

function parseTerms(principalDrops: unknown, aprBps: unknown, durationDays: unknown) {
  if (typeof principalDrops !== 'string' || !/^\d+$/.test(principalDrops) || BigInt(principalDrops) < 1_000_000n) {
    throw new HttpError(400, 'principalDrops must be an integer string of at least 1 XRP (1000000 drops)')
  }
  const apr = Number(aprBps), days = Number(durationDays)
  if (!Number.isInteger(apr) || apr < 0 || apr > 100_000) throw new HttpError(400, 'aprBps must be an integer 0-100000')
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'durationDays must be 1-365')
  return { principal: BigInt(principalDrops), apr, days }
}

export const getLoan = (id: number) => one<LoanRow>('SELECT * FROM loans WHERE id = ?', id)

export function loanView(l: LoanRow) {
  const custody = getCustody(l.nft_id)
  const owed = BigInt(l.principal_drops) + BigInt(l.interest_drops)
  return {
    ...l,
    amount_due_drops: owed.toString(),
    repay_to: treasuryWallet().classicAddress,
    repay_tag: repayTag(l.id),
    grace_ends_at: l.due_at ? l.due_at + config.graceHours * 3600 : null,
    funding_deadline: l.accepted_at ? l.accepted_at + config.fundingWindowHours * 3600 : null,
    nft_uri: custody?.uri ?? null,
    offers: l.kind === 'p2p' ? all('SELECT * FROM loan_offers WHERE loan_id = ? ORDER BY id DESC', l.id) : [],
  }
}

export function listLoans(filter: { status?: string; address?: string }) {
  if (filter.address) {
    return all<LoanRow>('SELECT * FROM loans WHERE borrower = ? OR lender = ? ORDER BY id DESC', filter.address, filter.address).map(loanView)
  }
  if (filter.status) return all<LoanRow>('SELECT * FROM loans WHERE status = ? ORDER BY id DESC', filter.status).map(loanView)
  return all<LoanRow>('SELECT * FROM loans ORDER BY id DESC LIMIT 200').map(loanView)
}

function lockCollateral(borrower: string, nftId: string) {
  const c = getCustody(nftId)
  if (!c || c.owner !== borrower || c.status !== 'held') throw new HttpError(404, 'Deposit this NFT into your Safe first')
  if (c.purpose !== 'safe') throw new HttpError(409, 'NFT is already pledged')
}

function memo(type: string, data: string) {
  return [{ Memo: { MemoType: convertStringToHex(type), MemoData: convertStringToHex(data) } }]
}

// ---------------------------------------------------------------- platform loans

export async function createPlatformLoan(borrower: string, nftId: string, principalDrops: string, durationDays: number) {
  nftId = nftId.toUpperCase()
  const { principal, days } = parseTerms(principalDrops, config.platformAprBps, durationDays)
  const a = appraise(nftId)
  if (!a.eligible || !('maxLoanDrops' in a)) throw new HttpError(400, a.reason ?? 'Not eligible')
  if (principal > BigInt(a.maxLoanDrops)) throw new HttpError(400, `Maximum loan for this NFT is ${a.maxLoanDrops} drops`)
  if (days > config.platformMaxDays) throw new HttpError(400, `Maximum term is ${config.platformMaxDays} days`)

  return withLock(`nft:${nftId}`, async () => {
    lockCollateral(borrower, nftId)
    const treasury = treasuryWallet().classicAddress
    if ((await getSpendableDrops(treasury)) < principal) throw new HttpError(503, 'Treasury liquidity is low; try a smaller amount')
    if (config.platformExposureCapDrops > 0n) {
      const out = one<{ s: number }>("SELECT COALESCE(SUM(CAST(principal_drops AS INTEGER)),0) AS s FROM loans WHERE kind='platform' AND status='active'")!.s
      if (BigInt(out) + principal > config.platformExposureCapDrops) throw new HttpError(503, 'Platform lending cap reached')
    }

    const ts = now()
    const interest = interestFor(principal, config.platformAprBps, days)
    const loanId = tx(() => {
      const r = run(
        `INSERT INTO loans (kind, status, borrower, lender, nft_id, principal_drops, apr_bps, duration_days, interest_drops, created_at, updated_at)
         VALUES ('platform', 'awaiting_funding', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        borrower, treasury, nftId, principal.toString(), config.platformAprBps, days, interest.toString(), ts, ts,
      )
      const id = Number(r.lastInsertRowid)
      run("UPDATE custody SET purpose = 'collateral', loan_id = ?, updated_at = ? WHERE nft_id = ?", id, ts, nftId)
      return id
    })

    try {
      const pay = await submitAsPlatform(
        { TransactionType: 'Payment', Account: treasury, Destination: borrower, Amount: principal.toString(), Memos: memo('xrpawn/loan', String(loanId)) },
        treasuryWallet(),
      )
      const funded = now()
      run("UPDATE loans SET status='active', fund_tx=?, funded_at=?, due_at=?, updated_at=? WHERE id=?",
        pay.hash, funded, funded + days * 86400, funded, loanId)
    } catch (e) {
      // Payment failed: unwind so the NFT returns to the Safe.
      tx(() => {
        run("UPDATE loans SET status='cancelled', updated_at=? WHERE id=?", now(), loanId)
        run("UPDATE custody SET purpose='safe', loan_id=NULL, updated_at=? WHERE nft_id=?", now(), nftId)
      })
      throw e
    }
    return loanView(getLoan(loanId)!)
  })
}

// ---------------------------------------------------------------- p2p loans

export async function requestP2PLoan(borrower: string, nftId: string, principalDrops: string, aprBps: number, durationDays: number) {
  nftId = nftId.toUpperCase()
  const { principal, apr, days } = parseTerms(principalDrops, aprBps, durationDays)
  return withLock(`nft:${nftId}`, async () => {
    lockCollateral(borrower, nftId)
    const ts = now()
    const id = tx(() => {
      const r = run(
        `INSERT INTO loans (kind, status, borrower, nft_id, principal_drops, apr_bps, duration_days, interest_drops, created_at, updated_at)
         VALUES ('p2p', 'requested', ?, ?, ?, ?, ?, ?, ?, ?)`,
        borrower, nftId, principal.toString(), apr, days, interestFor(principal, apr, days).toString(), ts, ts,
      )
      const loanId = Number(r.lastInsertRowid)
      run("UPDATE custody SET purpose='collateral', loan_id=?, updated_at=? WHERE nft_id=?", loanId, ts, nftId)
      return loanId
    })
    return loanView(getLoan(id)!)
  })
}

export async function cancelP2PRequest(borrower: string, loanId: number) {
  return withLock(`loan:${loanId}`, async () => {
    const l = getLoan(loanId)
    if (!l || l.borrower !== borrower) throw new HttpError(404, 'Loan not found')
    if (l.status !== 'requested') throw new HttpError(409, 'Only open requests can be cancelled')
    tx(() => {
      run("UPDATE loans SET status='cancelled', updated_at=? WHERE id=?", now(), loanId)
      run("UPDATE loan_offers SET status='withdrawn' WHERE loan_id=? AND status='open'", loanId)
      run("UPDATE custody SET purpose='safe', loan_id=NULL, updated_at=? WHERE nft_id=?", now(), l.nft_id)
    })
    return loanView(getLoan(loanId)!)
  })
}

export function makeOffer(lender: string, loanId: number, principalDrops: string, aprBps: number, durationDays: number) {
  const l = getLoan(loanId)
  if (!l || l.kind !== 'p2p') throw new HttpError(404, 'Loan request not found')
  if (l.status !== 'requested') throw new HttpError(409, 'This request is no longer taking offers')
  if (l.borrower === lender) throw new HttpError(400, 'You cannot lend to yourself')
  const { principal, apr, days } = parseTerms(principalDrops, aprBps, durationDays)
  run("UPDATE loan_offers SET status='withdrawn' WHERE loan_id=? AND lender=? AND status='open'", loanId, lender)
  run(
    `INSERT INTO loan_offers (loan_id, lender, principal_drops, apr_bps, duration_days, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    loanId, lender, principal.toString(), apr, days, now(),
  )
  notify(l.borrower, 'offer_received', `New loan offer on request #${loanId}`,
    `A lender offers ${X(principal)} at ${apr / 100}% APR for ${days} days.`, { link: '/borrow', loanId })
  return loanView(getLoan(loanId)!)
}

export function withdrawOffer(lender: string, offerId: number) {
  const o = one<any>('SELECT * FROM loan_offers WHERE id = ?', offerId)
  if (!o || o.lender !== lender) throw new HttpError(404, 'Offer not found')
  if (o.status !== 'open') throw new HttpError(409, 'Offer is not open')
  run("UPDATE loan_offers SET status='withdrawn' WHERE id=?", offerId)
  return loanView(getLoan(o.loan_id)!)
}

export async function acceptOffer(borrower: string, loanId: number, offerId: number) {
  return withLock(`loan:${loanId}`, async () => {
    const l = getLoan(loanId)
    if (!l || l.borrower !== borrower) throw new HttpError(404, 'Loan not found')
    if (l.status !== 'requested') throw new HttpError(409, 'Loan is not open for offers')
    const o = one<any>("SELECT * FROM loan_offers WHERE id=? AND loan_id=? AND status='open'", offerId, loanId)
    if (!o) throw new HttpError(404, 'Offer not found or no longer open')
    const p = BigInt(o.principal_drops)
    tx(() => {
      run("UPDATE loan_offers SET status='accepted' WHERE id=?", offerId)
      run(
        `UPDATE loans SET status='awaiting_funding', lender=?, principal_drops=?, apr_bps=?, duration_days=?, interest_drops=?,
           accepted_offer_id=?, accepted_at=?, updated_at=? WHERE id=?`,
        o.lender, o.principal_drops, o.apr_bps, o.duration_days, interestFor(p, o.apr_bps, o.duration_days).toString(),
        offerId, now(), now(), loanId,
      )
    })
    notify(o.lender, 'offer_accepted', `Your offer on #${loanId} was accepted`,
      `Send ${X(o.principal_drops)} to the borrower within ${config.fundingWindowHours}h to start the loan.`, { link: '/lend', loanId })
    return loanView(getLoan(loanId)!)
  })
}

function checkFundingPayment(l: LoanRow, v: Awaited<ReturnType<typeof getValidatedTx>>) {
  const t = v.tx
  if (t.TransactionType !== 'Payment') return 'Not a Payment'
  if (t.Account !== l.lender) return 'Payment must come from the lender'
  if (t.Destination !== l.borrower) return 'Payment must go to the borrower'
  const d = deliveredDrops(v.meta)
  if (d === null || d < BigInt(l.principal_drops)) return 'Delivered amount is less than the loan principal'
  if (v.closeTimeUnix < (l.accepted_at ?? 0) - 60) return 'Payment predates the accepted offer'
  return null
}

async function activateWithFunding(l: LoanRow, hash: string) {
  if (!claimTx(hash, `fund:${l.id}`)) throw new HttpError(409, 'This payment was already used')
  const ts = now()
  run("UPDATE loans SET status='active', fund_tx=?, funded_at=?, due_at=?, updated_at=? WHERE id=?",
    hash, ts, ts + l.duration_days * 86400, ts, l.id)
  run("UPDATE loan_offers SET status='expired' WHERE loan_id=? AND status='open'", l.id)
  notify(l.borrower, 'loan_funded', `Loan #${l.id} is funded`,
    `You received ${X(l.principal_drops)}. Repay ${X(BigInt(l.principal_drops) + BigInt(l.interest_drops))} within ${l.duration_days} days.`, { link: '/borrow', loanId: l.id })
}

/** Lender reports the payment they sent to the borrower. */
export async function reportFunding(lender: string, loanId: number, txHash: string) {
  const v = await getValidatedTx(txHash)
  return withLock(`loan:${loanId}`, async () => {
    const l = getLoan(loanId)
    if (!l || l.lender !== lender) throw new HttpError(404, 'Loan not found')
    if (l.status !== 'awaiting_funding') throw new HttpError(409, `Loan is ${l.status}`)
    const err = checkFundingPayment(l, v)
    if (err) throw new HttpError(400, err)
    await activateWithFunding(l, v.hash)
    return loanView(getLoan(loanId)!)
  })
}

/** Look on-ledger for a funding payment the lender sent but did not report. */
async function findFundingPayment(l: LoanRow): Promise<string | null> {
  const c = await getClient()
  const r: any = await c.request({ command: 'account_tx', account: l.borrower, limit: 200, forward: false } as any)
  for (const e of r.result.transactions) {
    const t = e.tx_json ?? e.tx
    if (!e.validated || t?.TransactionType !== 'Payment' || e.meta?.TransactionResult !== 'tesSUCCESS') continue
    const hash = (e.hash ?? t.hash) as string
    if (one('SELECT 1 FROM used_tx WHERE hash = ?', hash.toUpperCase())) continue
    const closeTimeUnix = e.close_time_iso ? Date.parse(e.close_time_iso) / 1000 : 0
    if (!checkFundingPayment(l, { hash, tx: t, meta: e.meta, closeTimeUnix })) return hash.toUpperCase()
  }
  return null
}

// ---------------------------------------------------------------- repayment

/** Borrower (or anyone) reports a repayment Payment sent to the treasury with the loan's DestinationTag. */
export async function reportRepayment(loanId: number, txHash: string) {
  const v = await getValidatedTx(txHash)
  return withLock(`loan:${loanId}`, async () => {
    const l = getLoan(loanId)
    if (!l) throw new HttpError(404, 'Loan not found')
    const t = v.tx
    const owed = BigInt(l.principal_drops) + BigInt(l.interest_drops)
    if (t.TransactionType !== 'Payment') throw new HttpError(400, 'Not a Payment')
    if (t.Destination !== treasuryWallet().classicAddress) throw new HttpError(400, 'Repayment must be sent to the treasury')
    if (Number(t.DestinationTag) !== repayTag(l.id)) throw new HttpError(400, `DestinationTag must be ${repayTag(l.id)}`)
    const d = deliveredDrops(v.meta)
    if (d === null) throw new HttpError(400, 'Repayments must be in XRP. Contact support to recover token payments.')
    if (!claimTx(v.hash, `repay:${l.id}`)) throw new HttpError(409, 'This payment was already used')

    // Money that can't be applied (wrong amount, loan no longer active) goes straight back to the sender.
    if (l.status !== 'active' || d < owed) {
      const why = l.status !== 'active' ? `Loan is ${l.status}` : `Delivered ${d} drops but ${owed} are owed`
      const refund = await refundPayment(t.Account, d, `loan ${l.id}: ${why}`).catch((e) => { console.error('refund failed', v.hash, e); return null })
      notify(t.Account, 'refund', `Payment for loan #${l.id} refunded`, `${why}. ${refund ? `${X(d)} was sent back to you.` : 'Refund pending; contact support.'}`, { link: '/borrow', loanId: l.id })
      throw new HttpError(400, `${why}. ${refund ? `Your ${d} drops were refunded (tx ${refund}).` : 'Refund pending; contact support.'}`)
    }
    if (d > owed) {
      await refundPayment(t.Account, d - owed, `loan ${l.id}: overpayment`).catch((e) => console.error('overpayment refund failed', v.hash, e))
    }

    run("UPDATE loans SET status='repaid', repay_tx=?, repaid_at=?, updated_at=? WHERE id=?", v.hash, now(), now(), l.id)
    run("UPDATE custody SET purpose='safe', loan_id=NULL, updated_at=? WHERE nft_id=?", now(), l.nft_id)
    // Return NFT straight to the borrower's wallet.
    await withLock(`nft:${l.nft_id}`, () => releaseTo(l.nft_id, l.borrower))
    notify(l.borrower, 'repaid', `Loan #${l.id} repaid`, 'Your NFT is ready to claim in the Safe.', { link: '/safe', loanId: l.id })
    if (l.kind === 'p2p') await payoutLender(l.id).catch((e) => console.error('payout failed, will retry', l.id, e))
    return loanView(getLoan(l.id)!)
  })
}

async function refundPayment(to: string, drops: bigint, reason: string) {
  const r = await submitAsPlatform(
    { TransactionType: 'Payment', Account: treasuryWallet().classicAddress, Destination: to, Amount: drops.toString(), Memos: memo('xrpawn/refund', reason) },
    treasuryWallet(),
  )
  return r.hash
}

export function p2pPayoutAmount(l: LoanRow) {
  const fee = (BigInt(l.interest_drops) * BigInt(config.p2pFeeBps)) / 10000n
  return BigInt(l.principal_drops) + BigInt(l.interest_drops) - fee
}

async function payoutLender(loanId: number) {
  const l = getLoan(loanId)!
  if (l.kind !== 'p2p' || l.status !== 'repaid' || l.payout_tx) return
  const amount = p2pPayoutAmount(l)
  const r = await submitAsPlatform(
    { TransactionType: 'Payment', Account: treasuryWallet().classicAddress, Destination: l.lender!, Amount: amount.toString(), Memos: memo('xrpawn/payout', String(l.id)) },
    treasuryWallet(),
  )
  run('UPDATE loans SET payout_tx=?, payout_drops=?, updated_at=? WHERE id=?', r.hash, amount.toString(), now(), l.id)
  notify(l.lender, 'payout', `Loan #${l.id} repaid`, `You were paid ${X(amount)} (principal + interest after the platform fee).`, { link: '/lend', loanId: l.id })
}

// ---------------------------------------------------------------- background job

export async function runLoanJobs() {
  const ts = now()

  // 1) P2P loans whose lender never funded: check ledger once, then reopen the request.
  for (const l of all<LoanRow>("SELECT * FROM loans WHERE status='awaiting_funding' AND kind='p2p'")) {
    await withLock(`loan:${l.id}`, async () => {
      const cur = getLoan(l.id)!
      if (cur.status !== 'awaiting_funding') return
      const found = await findFundingPayment(cur).catch(() => null)
      if (found) return activateWithFunding(cur, found)
      if (ts > (cur.accepted_at ?? 0) + config.fundingWindowHours * 3600) {
        run("UPDATE loan_offers SET status='expired' WHERE id=?", cur.accepted_offer_id)
        run("UPDATE loans SET status='requested', lender=NULL, accepted_offer_id=NULL, accepted_at=NULL, updated_at=? WHERE id=?", ts, cur.id)
        notify(cur.borrower, 'funding_expired', `Lender didn't fund #${cur.id}`, 'Your request is open for offers again.', { link: '/borrow', loanId: cur.id })
        notify(cur.lender, 'funding_expired', `Offer on #${cur.id} expired`, 'You did not fund in time, so the request was reopened.', { link: '/lend', loanId: cur.id })
      }
    }).catch((e) => console.error('funding job', l.id, e))
  }

  // 2) Defaults
  const cutoff = ts - config.graceHours * 3600
  for (const l of all<LoanRow>("SELECT * FROM loans WHERE status='active' AND due_at < ?", cutoff)) {
    await withLock(`loan:${l.id}`, async () => {
      const cur = getLoan(l.id)!
      if (cur.status !== 'active') return
      run("UPDATE loans SET status='defaulted', defaulted_at=?, updated_at=? WHERE id=?", ts, ts, cur.id)
      if (cur.kind === 'p2p') {
        // Keep the loan proof with the NFT so any later release to the lender carries it (multisig co-signer needs it).
        const ctx = { reason: 'default_to_lender' as const, fundTx: cur.fund_tx!, loanId: cur.id }
        run("UPDATE custody SET owner=?, purpose='safe', loan_id=NULL, release_ctx=?, updated_at=? WHERE nft_id=?", cur.lender, JSON.stringify(ctx), ts, cur.nft_id)
        notify(cur.lender, 'collateral_claimed', `Loan #${cur.id} defaulted`, 'The collateral NFT is now yours. Claim it in the Safe.', { link: '/safe', loanId: cur.id })
        await withLock(`nft:${cur.nft_id}`, () => releaseTo(cur.nft_id, cur.lender!, ctx))
          .catch((e) => console.error('default release failed; lender can withdraw from the Safe later', cur.id, e?.message))
      } else {
        run("UPDATE custody SET owner=?, purpose='inventory', loan_id=NULL, updated_at=? WHERE nft_id=?", treasuryWallet().classicAddress, ts, cur.nft_id)
      }
      notify(cur.borrower, 'defaulted', `Loan #${cur.id} defaulted`, 'The grace period ended without repayment, so the collateral NFT was forfeited.', { link: '/borrow', loanId: cur.id })
    }).catch((e) => console.error('default job', l.id, e))
  }

  // 3) Retry failed lender payouts
  for (const l of all<LoanRow>("SELECT * FROM loans WHERE kind='p2p' AND status='repaid' AND payout_tx IS NULL")) {
    await withLock(`loan:${l.id}`, () => payoutLender(l.id)).catch((e) => console.error('payout job', l.id, e))
  }

  // 4) Apply repayments that borrowers sent but never reported (any wallet, incl. Xaman push)
  await scanRepayments().catch((e) => console.error('repayment scan', e?.message))

  // 5) Due-date reminders
  await sendReminders(now())
}

/** Look at recent treasury payments carrying a loan's repayment tag and apply them. */
export async function scanRepayments() {
  const c = await getClient()
  const r: any = await c.request({ command: 'account_tx', account: treasuryWallet().classicAddress, limit: 200, forward: false } as any)
  for (const e of r.result.transactions) {
    const t = e.tx_json ?? e.tx
    if (!e.validated || t?.TransactionType !== 'Payment' || t.Destination !== treasuryWallet().classicAddress) continue
    const tag = Number(t.DestinationTag)
    if (!(tag > REPAY_TAG_OFFSET)) continue
    const hash = String(e.hash ?? t.hash).toUpperCase()
    if (one('SELECT 1 FROM used_tx WHERE hash = ?', hash)) continue
    const loanId = tag - REPAY_TAG_OFFSET
    if (!getLoan(loanId)) continue
    await reportRepayment(loanId, hash).catch(() => { /* refund/other outcome handled + logged inside */ })
  }
}

/** Reminders at 72h and 24h before due, and once overdue (during the grace period). */
export async function sendReminders(ts: number) {
  for (const l of all<LoanRow>("SELECT * FROM loans WHERE status='active' AND due_at IS NOT NULL")) {
    const left = l.due_at! - ts
    const owed = BigInt(l.principal_drops) + BigInt(l.interest_drops)
    const repayTx = { TransactionType: 'Payment', Destination: treasuryWallet().classicAddress, DestinationTag: repayTag(l.id), Amount: owed.toString() }
    let stage: string | null = null
    let title = '', body = ''
    if (left < 0) {
      stage = 'overdue'
      const graceEnd = l.due_at! + config.graceHours * 3600
      title = `Loan #${l.id} is overdue`
      body = `Repay ${X(owed)} within ${Math.max(0, Math.round((graceEnd - ts) / 3600))}h or the collateral NFT is forfeited.`
    } else if (left <= 24 * 3600) {
      stage = 'due_24h'; title = `Loan #${l.id} is due within 24 hours`; body = `Repay ${X(owed)} to keep your NFT.`
    } else if (left <= 72 * 3600) {
      stage = 'due_72h'; title = `Loan #${l.id} is due in 3 days`; body = `Repay ${X(owed)} before the due date.`
    }
    if (!stage || !once(l.id, stage)) continue
    notify(l.borrower, stage === 'overdue' ? 'overdue' : 'due_soon', title, body, { link: '/borrow', loanId: l.id })
    if (stage !== 'due_72h') await pushRepayment(l.borrower, repayTx, `${title}. ${body}`)
  }
}
