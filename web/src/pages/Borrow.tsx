import { useEffect, useState } from 'react'
import { api, report } from '../lib/api'
import { date, pct, toDrops, xrp } from '../lib/format'
import { useAction, useSession } from '../lib/session'
import { useLoad } from '../lib/useLoad'
import { Addr, Badge, Card, Empty, NeedWallet, NftImage, TxLink } from '../components/ui'
import { useCustody } from './Safe'
import { Link } from 'react-router-dom'

export interface Loan {
  id: number; kind: 'platform' | 'p2p'; status: string; borrower: string; lender: string | null; nft_id: string
  principal_drops: string; apr_bps: number; duration_days: number; interest_drops: string; amount_due_drops: string
  due_at: number | null; grace_ends_at: number | null; funding_deadline: number | null; repay_to: string; repay_tag: number
  fund_tx: string | null; repay_tx: string | null; payout_tx: string | null; payout_drops: string | null; nft_uri: string | null
  offers: { id: number; lender: string; principal_drops: string; apr_bps: number; duration_days: number; status: string }[]
}

export const interestFor = (principalDrops: number, aprBps: number, days: number) => Math.ceil((principalDrops * aprBps * days) / (365 * 10000))

export function useMyLoans() {
  const { address } = useSession()
  return useLoad(() => (address ? api<Loan[]>('/loans?mine=1') : Promise.resolve([])), [address])
}

function Appraisal({ nftId, onDone }: { nftId: string; onDone: () => void }) {
  const { config } = useSession()
  const { busy, run } = useAction()
  const ap = useLoad(() => api(`/appraise/${nftId}`), [nftId])
  const [amount, setAmount] = useState('')
  const [days, setDays] = useState('30')
  const [p2pAmount, setP2pAmount] = useState('')
  const [p2pApr, setP2pApr] = useState('20')
  const [p2pDays, setP2pDays] = useState('30')

  useEffect(() => { if (ap.data?.maxLoanDrops) setAmount(String(Number(ap.data.maxLoanDrops) / 1e6)) }, [ap.data])

  const pawn = () => run('pawn', async () => {
    await api('/loans/platform', { body: { nftId, principalDrops: toDrops(amount), durationDays: Number(days) } })
    onDone()
  }, 'Loan funded. XRP sent to your wallet.')

  const p2p = () => run('p2p', async () => {
    await api('/loans/p2p', { body: { nftId, principalDrops: toDrops(p2pAmount), aprBps: Math.round(Number(p2pApr) * 100), durationDays: Number(p2pDays) } })
    onDone()
  }, 'Loan request posted to lenders')

  const a = ap.data
  const pawnInterest = amount && Number(amount) > 0 ? interestFor(Number(amount) * 1e6, config!.platformAprBps, Number(days) || 0) : 0
  const p2pInterest = p2pAmount && Number(p2pAmount) > 0 ? interestFor(Number(p2pAmount) * 1e6, Number(p2pApr) * 100, Number(p2pDays) || 0) : 0

  return (
    <div className="two-col">
      <Card title="Instant pawn loan">
        {!a ? <Empty>Appraising…</Empty> : !a.eligible || !a.maxLoanDrops ? (
          <Empty>{a.reason}</Empty>
        ) : (
          <>
            <dl className="kv">
              <dt>Collection</dt><dd>{a.collection}</dd>
              <dt>Appraised floor</dt><dd>{xrp(a.floorDrops)}</dd>
              <dt>Price basis</dt>
              <dd className="small">
                {a.floorBasis === 'admin' ? 'Platform appraisal'
                  : a.floorBasis === 'live' ? `Live market (${a.liveListings} listings)`
                  : `Platform cap (market is ${xrp(a.liveFloorDrops)})`}
              </dd>
              <dt>Max loan ({pct(a.ltvBps)} LTV)</dt><dd className="gold">{xrp(a.maxLoanDrops)}</dd>
              <dt>Rate</dt><dd>{pct(a.aprBps)} APR, fixed for the term</dd>
            </dl>
            <label>Amount (XRP)<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></label>
            <label>Term (days, max {a.maxDays})<input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" /></label>
            <p className="muted small">You repay {xrp(Number(amount || 0) * 1e6 + pawnInterest, 6)} by the due date. Grace period: {config!.graceHours}h. After that, the NFT is forfeited.</p>
            <button className="primary" disabled={!!busy} onClick={pawn}>{busy === 'pawn' ? 'Funding…' : 'Get XRP now'}</button>
          </>
        )}
      </Card>
      <Card title="Ask the P2P market">
        <p className="muted small">Set your terms. Lenders compete with offers, and you pick one. The platform keeps {pct(config!.p2pFeeBps)} of the interest.</p>
        <label>Amount (XRP)<input value={p2pAmount} onChange={(e) => setP2pAmount(e.target.value)} inputMode="decimal" placeholder="e.g. 500" /></label>
        <div className="row">
          <label>APR %<input value={p2pApr} onChange={(e) => setP2pApr(e.target.value)} inputMode="decimal" /></label>
          <label>Days<input value={p2pDays} onChange={(e) => setP2pDays(e.target.value)} inputMode="numeric" /></label>
        </div>
        {p2pInterest > 0 && <p className="muted small">Interest: {xrp(p2pInterest, 6)}</p>}
        <button disabled={!!busy || !p2pAmount} onClick={p2p}>{busy === 'p2p' ? 'Posting…' : 'Post loan request'}</button>
      </Card>
    </div>
  )
}

export function LoanRow({ l, me, onChange }: { l: Loan; me: string; onChange: () => void }) {
  const { submit } = useSession()
  const { busy, run } = useAction()
  const isBorrower = l.borrower === me

  const repay = () => run('repay', async () => {
    const hash = await submit({ TransactionType: 'Payment', Destination: l.repay_to, DestinationTag: l.repay_tag, Amount: l.amount_due_drops }, `Repay loan #${l.id}`)
    await report(`/loans/${l.id}/repay`, { txHash: hash })
    onChange()
  }, 'Repaid. Claim your NFT in the Safe.')

  const fund = () => run('fund', async () => {
    const hash = await submit({ TransactionType: 'Payment', Destination: l.borrower, Amount: l.principal_drops }, `Fund loan #${l.id}`)
    await report(`/loans/${l.id}/fund`, { txHash: hash })
    onChange()
  }, 'Loan funded')

  const accept = (offerId: number) => run(`acc${offerId}`, async () => { await api(`/loans/${l.id}/offers/${offerId}/accept`, { method: 'POST' }); onChange() }, 'Offer accepted. Waiting for the lender to fund.')
  const cancel = () => run('cancel', async () => { await api(`/loans/${l.id}/cancel`, { method: 'POST' }); onChange() }, 'Request cancelled. NFT is back in your Safe.')

  const openOffers = l.offers.filter((o) => o.status === 'open')
  return (
    <div className="loan">
      <NftImage nftId={l.nft_id} uri={l.nft_uri} size="sm" />
      <div className="loan-b">
        <div className="row between">
          <strong>#{l.id} · {l.kind === 'platform' ? 'Pawn loan' : 'P2P loan'}</strong>
          <Badge s={l.status} />
        </div>
        <div className="loan-stats">
          <span><small>Principal</small>{xrp(l.principal_drops)}</span>
          <span><small>APR</small>{pct(l.apr_bps)}</span>
          <span><small>Term</small>{l.duration_days}d</span>
          <span><small>Total due</small>{xrp(l.amount_due_drops, 6)}</span>
          {l.due_at && <span><small>Due</small>{date(l.due_at)}</span>}
          <span><small>{isBorrower ? 'Lender' : 'Borrower'}</small>{l.kind === 'platform' && isBorrower ? 'Platform' : <Addr a={isBorrower ? l.lender : l.borrower} />}</span>
        </div>
        <div className="row">
          {isBorrower && l.status === 'active' && <button className="primary" disabled={!!busy} onClick={repay}>{busy === 'repay' ? 'Repaying…' : `Repay ${xrp(l.amount_due_drops, 6)}`}</button>}
          {isBorrower && l.status === 'requested' && <button className="ghost" disabled={!!busy} onClick={cancel}>Cancel request</button>}
          {!isBorrower && l.status === 'awaiting_funding' && l.lender === me && (
            <button className="primary" disabled={!!busy} onClick={fund}>{busy === 'fund' ? 'Sending…' : `Send ${xrp(l.principal_drops)} to borrower`}</button>
          )}
          {l.status === 'awaiting_funding' && <span className="muted small">Funding deadline {date(l.funding_deadline)}</span>}
          {l.status === 'repaid' && isBorrower && <Link to="/safe" className="small">Claim NFT in Safe →</Link>}
          {l.status === 'defaulted' && !isBorrower && l.kind === 'p2p' && <Link to="/safe" className="small">Claim forfeited NFT in Safe →</Link>}
          {l.fund_tx && <span className="small muted">funded <TxLink hash={l.fund_tx} /></span>}
          {l.repay_tx && <span className="small muted">repaid <TxLink hash={l.repay_tx} /></span>}
          {l.payout_tx && !isBorrower && <span className="small muted">payout {xrp(l.payout_drops, 6)} <TxLink hash={l.payout_tx} /></span>}
        </div>
        {isBorrower && l.status === 'requested' && (
          openOffers.length === 0 ? <p className="muted small">No offers yet.</p> : (
            <table className="offers">
              <thead><tr><th>Lender</th><th>Amount</th><th>APR</th><th>Days</th><th /></tr></thead>
              <tbody>
                {openOffers.map((o) => (
                  <tr key={o.id}>
                    <td><Addr a={o.lender} /></td><td>{xrp(o.principal_drops)}</td><td>{pct(o.apr_bps)}</td><td>{o.duration_days}</td>
                    <td><button className="primary sm" disabled={!!busy} onClick={() => accept(o.id)}>Accept</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  )
}

export default function Borrow() {
  const { address } = useSession()
  const custody = useCustody()
  const loans = useMyLoans()
  const [selected, setSelected] = useState<string | null>(null)
  const available = (custody.data ?? []).filter((c) => c.owner === address && c.purpose === 'safe' && c.status === 'held')
  const mine = (loans.data ?? []).filter((l) => l.borrower === address)
  const done = () => { setSelected(null); custody.reload(); loans.reload() }

  return (
    <NeedWallet>
      <div className="page-h">
        <div>
          <h1>Borrow</h1>
          <p className="muted">Borrow XRP against NFTs in your Safe. Take an instant pawn loan from the platform, or post terms for P2P lenders.</p>
        </div>
      </div>
      <Card title="1 · Choose collateral">
        {available.length === 0 ? <Empty>No free NFTs in your Safe. <Link to="/safe">Deposit one first →</Link></Empty> : (
          <div className="grid">
            {available.map((c) => (
              <button key={c.nft_id} className={`tile pick ${selected === c.nft_id ? 'sel' : ''}`} onClick={() => setSelected(c.nft_id)}>
                <NftImage nftId={c.nft_id} uri={c.uri} />
                <div className="tile-b"><span className="mono small">{c.nft_id.slice(-10)}</span></div>
              </button>
            ))}
          </div>
        )}
      </Card>
      {selected && <Appraisal nftId={selected} onDone={done} />}
      <Card title="Your loans" actions={<button className="ghost" onClick={loans.reload}>Refresh</button>}>
        {mine.length === 0 ? <Empty>No loans yet.</Empty> : mine.map((l) => <LoanRow key={l.id} l={l} me={address!} onChange={done} />)}
      </Card>
    </NeedWallet>
  )
}
