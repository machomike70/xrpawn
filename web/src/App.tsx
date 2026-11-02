import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom'
import { SessionProvider, useSession } from './lib/session'
import { ConnectMenu, Toasts, XamanModal } from './components/ui'
import Bell from './components/Bell'
import { pct } from './lib/format'
import Safe from './pages/Safe'
import Borrow from './pages/Borrow'
import Lend from './pages/Lend'
import Market from './pages/Market'
import Admin from './pages/Admin'

function Home() {
  const { config } = useSession()
  return (
    <>
      <section className="hero">
        <p className="eyebrow">XRP Ledger · NFT-backed credit</p>
        <h1>Borrow XRP against your NFTs.<br /><span className="gold">Keep the upside.</span></h1>
        <p className="muted lead">
          Pawn your XLS-20 NFTs for instant XRP, borrow from other collectors at your own terms, trade peer-to-peer, or just keep
          your best pieces in the Safe.
        </p>
        <div className="row">
          <Link className="button primary" to="/borrow">Get a loan</Link>
          <Link className="button" to="/lend">Earn as a lender</Link>
        </div>
      </section>
      <div className="features">
        <Link to="/borrow" className="feature"><b>Pawn loans</b><p>Instant XRP from the platform treasury, up to the collection's LTV, at {pct(config?.platformAprBps ?? 0)} APR fixed.</p></Link>
        <Link to="/lend" className="feature"><b>P2P lending</b><p>Post your terms. Lenders compete with offers. If the loan defaults, the lender gets the NFT.</p></Link>
        <Link to="/market" className="feature"><b>Marketplace</b><p>Native XRPL brokered offers. The NFT stays in your wallet until it sells, and settlement is atomic.</p></Link>
        <Link to="/safe" className="feature"><b>The Safe</b><p>Vault custody for NFTs. Releases are destination-locked offers only you can claim.</p></Link>
      </div>
      <section className="card how">
        <h2>How a loan works</h2>
        <ol>
          <li><b>Deposit.</b> Send your NFT to the vault with a 0 XRP offer that only the vault can accept.</li>
          <li><b>Borrow.</b> Take the pawn quote, or accept a lender's offer. XRP lands in your wallet.</li>
          <li><b>Repay.</b> Pay principal + interest with your loan's destination tag before the due date ({config?.graceHours ?? 72}h grace).</li>
          <li><b>Reclaim.</b> The vault creates an offer locked to your address. Claim it and the NFT is yours again.</li>
        </ol>
      </section>
    </>
  )
}

function Shell() {
  const { config, isAdmin } = useSession()
  return (
    <>
      <header className="top">
        <Link to="/" className="logo"><span className="mark">◆</span> XRPawn</Link>
        <nav>
          <NavLink to="/borrow">Borrow</NavLink>
          <NavLink to="/lend">Lend</NavLink>
          <NavLink to="/market">Market</NavLink>
          <NavLink to="/safe">Safe</NavLink>
          {isAdmin && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        {config && config.network !== 'mainnet' && <span className="net">{config.network}</span>}
        <Bell />
        <ConnectMenu />
      </header>
      <main>
        {!config ? <div className="empty">Connecting to the XRPawn API…</div> : <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/borrow" element={<Borrow />} />
          <Route path="/lend" element={<Lend />} />
          <Route path="/market" element={<Market />} />
          <Route path="/safe" element={<Safe />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>}
      </main>
      <footer className="muted small">Loans are enforced by the platform's vault and treasury accounts on the XRP Ledger. Not financial advice.</footer>
      <XamanModal />
      <Toasts />
    </>
  )
}

export default function App() {
  return (
    <SessionProvider>
      <BrowserRouter><Shell /></BrowserRouter>
    </SessionProvider>
  )
}
