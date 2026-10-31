import { useState } from 'react'
import { api } from '../lib/api'
import { pct, toDrops, xrp } from '../lib/format'
import { useAction, useSession } from '../lib/session'
import { useLoad } from '../lib/useLoad'
import { Addr, Card, Empty, NftImage } from '../components/ui'
import { LoanRow, interestFor, useMyLoans, type Loan } from './Borrow'

function RequestCard({ l, onChange }: { l: Loan; onChange: () => void }) {
  const { address, config } = useSession()
  const { busy, run } = useAction()
  const [amount, setAmount] = useState(String(Number(l.principal_drops) / 1e6))
  const [apr, setApr] = useState(String(l.apr_bps / 100))
  const [days, setDays] = useState(String(l.duration_days))
  const myOffer = l.offers.find((o) => o.lender === address && o.status === 'open')
  const est = Number(amount) > 0 ? interestFor(Number(amount) * 1e6, Number(apr) * 100, Number(days) || 0) : 0
  const net = est - Math.floor((est * config!.p2pFeeBps) / 10000)

  const offer = () => run('offer', async () => {
    await api(`/loans/${l.id}/offers`, { body: { principalDrops: toDrops(amount), aprBps: Math.round(Number(apr) * 100), durationDays: Number(days) } })
    onChange()
  }, 'Offer sent to borrower')
  const withdraw = () => run('wd', async () => { await api(`/offers/${myOffer!.id}/withdraw`, { method: 'POST' }); onChange() }, 'Offer withdrawn')

  return (
    <div className="tile wide">
      <NftImage nftId={l.nft_id} uri={l.nft_uri} />
      <div className="tile-b">
        <div className="row between"><strong>Request #{l.id}</strong><Addr a={l.borrower} /></div>
        <p className="small">Asks <span className="gold">{xrp(l.principal_drops)}</span> · {pct(l.apr_bps)} APR · {l.duration_days} days</p>
        <p className="muted small">{l.offers.filter((o) => o.status === 'open').length} open offer(s). Collateral is held in the vault.</p>
        {!address ? <p className="muted small">Connect a wallet to make an offer.</p> : address === l.borrower ? <p className="muted small">This is your request.</p> : (
          <>
            <div className="row">
              <label>XRP<input value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
              <label>APR %<input value={apr} onChange={(e) => setApr(e.target.value)} /></label>
              <label>Days<input value={days} onChange={(e) => setDays(e.target.value)} /></label>
            </div>
            <p className="muted small">You'd earn about {xrp(net, 4)} after the platform fee. If the borrower doesn't repay, the NFT goes to you.</p>
            <div className="row">
              <button className="primary" disabled={!!busy} onClick={offer}>{myOffer ? 'Update offer' : 'Make offer'}</button>
              {myOffer && <button className="ghost" disabled={!!busy} onClick={withdraw}>Withdraw</button>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function Lend() {
  const { address } = useSession()
  const requests = useLoad(() => api<Loan[]>('/loans?status=requested'), [])
  const loans = useMyLoans()
  const mine = (loans.data ?? []).filter((l) => l.lender === address && l.kind === 'p2p')
  const reload = () => { requests.reload(); loans.reload() }
  return (
    <>
      <div className="page-h">
        <div>
          <h1>Lend</h1>
          <p className="muted">Earn yield by funding XRP loans backed by NFTs held in escrow. If the borrower defaults, you get the NFT.</p>
        </div>
      </div>
      {address && mine.length > 0 && (
        <Card title="Your lending" actions={<button className="ghost" onClick={reload}>Refresh</button>}>
          {mine.map((l) => <LoanRow key={l.id} l={l} me={address} onChange={reload} />)}
        </Card>
      )}
      <Card title="Open loan requests" actions={<button className="ghost" onClick={reload}>Refresh</button>}>
        {(requests.data ?? []).length === 0 ? <Empty>No open requests right now.</Empty> : (
          <div className="grid wide">{requests.data!.map((l) => <RequestCard key={l.id} l={l} onChange={reload} />)}</div>
        )}
      </Card>
    </>
  )
}
