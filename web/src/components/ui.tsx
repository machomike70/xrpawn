import { useEffect, useState, type ReactNode } from 'react'
import { resolveUri, short } from '../lib/format'
import { useSession } from '../lib/session'
import { WALLET_LABELS, type WalletKind } from '../lib/wallet'

const metaCache = new Map<string, Promise<string | null>>()

async function imageFor(uri: string): Promise<string | null> {
  const url = resolveUri(uri)
  if (!url) return null
  if (/\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(url)) return url
  try {
    const r = await fetch(url)
    const ct = r.headers.get('content-type') ?? ''
    if (ct.startsWith('image/')) return url
    const j = await r.json()
    return resolveUri(j.image ?? j.image_url ?? j.animation_url)
  } catch {
    return null
  }
}

export function NftImage({ nftId, uri, size = 'md' }: { nftId: string; uri?: string | null; size?: 'sm' | 'md' }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!uri) return
    if (!metaCache.has(uri)) metaCache.set(uri, imageFor(uri))
    let live = true
    metaCache.get(uri)!.then((s) => live && setSrc(s))
    return () => { live = false }
  }, [uri])
  const hue = parseInt(nftId.slice(-6), 16) % 360
  return (
    <div className={`nft-img ${size}`} style={{ background: `linear-gradient(135deg, hsl(${hue} 45% 28%), hsl(${(hue + 60) % 360} 50% 16%))` }}>
      {src ? <img src={src} alt="" loading="lazy" onError={() => setSrc(null)} /> : <span>#{nftId.slice(-6)}</span>}
    </div>
  )
}

export function Addr({ a }: { a?: string | null }) {
  const { config } = useSession()
  if (!a) return <span className="muted">–</span>
  return <a className="mono" href={`${config?.explorer}/accounts/${a}`} target="_blank" rel="noreferrer">{short(a)}</a>
}

export function TxLink({ hash }: { hash?: string | null }) {
  const { config } = useSession()
  if (!hash) return null
  return <a className="mono" href={`${config?.explorer}/transactions/${hash}`} target="_blank" rel="noreferrer">{short(hash, 8)}</a>
}

export function Badge({ s }: { s: string }) {
  return <span className={`badge b-${s}`}>{s.replace('_', ' ')}</span>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && <header className="card-h"><h2>{title}</h2><div>{actions}</div></header>}
      {children}
    </section>
  )
}

export function NeedWallet({ children }: { children: ReactNode }) {
  const { address } = useSession()
  if (!address) return <Empty>Connect a wallet to continue.</Empty>
  return <>{children}</>
}

export function ConnectMenu() {
  const { config, address, kind, connect, disconnect, toast } = useSession()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  if (address) {
    return (
      <div className="connect">
        <span className="pill"><span className="dot" />{WALLET_LABELS[kind ?? 'dev']} · {short(address)}</span>
        <button className="ghost" onClick={disconnect}>Disconnect</button>
      </div>
    )
  }
  const kinds: WalletKind[] = ['xaman', 'gem', 'crossmark', ...(config?.devWallet ? (['dev'] as WalletKind[]) : [])]
  const go = async (k: WalletKind) => {
    setBusy(true)
    try { await connect(k); setOpen(false) } catch (e: any) { toast(e.message, 'err') } finally { setBusy(false) }
  }
  return (
    <div className="connect">
      <button className="primary" onClick={() => setOpen(!open)} disabled={busy}>{busy ? 'Connecting…' : 'Connect wallet'}</button>
      {open && (
        <div className="menu">
          {kinds.map((k) => (
            <button key={k} onClick={() => go(k)} disabled={busy || (k === 'xaman' && !config?.xaman)}>
              {WALLET_LABELS[k]}
              {k === 'xaman' && !config?.xaman && <small>needs XAMAN_API_KEY on server</small>}
              {k === 'dev' && <small>browser-stored testnet key</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function XamanModal() {
  const { xaman, cancelXaman } = useSession()
  if (!xaman) return null
  return (
    <div className="modal-bg">
      <div className="modal">
        <h3>{xaman.title}</h3>
        <p className="muted">Scan with the Xaman app, or open it on this device.</p>
        <img src={xaman.qrPng} alt="Xaman QR code" width={240} height={240} />
        <div className="row">
          <a className="button primary" href={xaman.deeplink} target="_blank" rel="noreferrer">Open Xaman</a>
          <button className="ghost" onClick={cancelXaman}>Cancel</button>
        </div>
        <p className="muted small">Waiting for signature…</p>
      </div>
    </div>
  )
}

export function Toasts() {
  const { toasts } = useSession()
  return <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}</div>
}
