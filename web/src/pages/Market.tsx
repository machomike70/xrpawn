import { useState } from 'react'
import { api, report } from '../lib/api'
import { pct, toDrops, xrp } from '../lib/format'
import { useAction, useSession } from '../lib/session'
import { useLoad } from '../lib/useLoad'
import { Addr, Badge, Card, Empty, NftImage } from '../components/ui'
import { useWalletNfts } from './Safe'

interface Listing { id: number; kind: 'p2p' | 'shop'; nft_id: string; seller: string; sell_offer: string; ask_drops: string; price_drops: string; status: string; uri: string | null; broker: string }

export default function Market() {
  const { address, config, submit } = useSession()
  const listings = useLoad(() => api<Listing[]>('/market/listings'), [])
  const wallet = useWalletNfts()
  const { busy, run } = useAction()
  const [sellNft, setSellNft] = useState<string>('')
  const [price, setPrice] = useState('')
  const [filter, setFilter] = useState<'all' | 'shop' | 'p2p'>('all')
  const reload = () => { listings.reload(); wallet.reload() }

  const buy = (l: Listing) => run(`buy${l.id}`, async () => {
    const hash = await submit(
      { TransactionType: 'NFTokenCreateOffer', NFTokenID: l.nft_id, Amount: l.price_drops, Owner: l.seller },
      `Buy NFT for ${xrp(l.price_drops, 6)}`,
    )
    await report(`/market/listings/${l.id}/buy`, { txHash: hash })
    reload()
  }, 'Purchased. The NFT is in your wallet.')

  const list = () => run('list', async () => {
    if (!sellNft) throw new Error('Choose an NFT')
    const hash = await submit(
      { TransactionType: 'NFTokenCreateOffer', NFTokenID: sellNft, Amount: toDrops(price), Flags: 1, Destination: config!.treasury },
      'List NFT for sale',
    )
    await report('/market/listings', { txHash: hash })
    setSellNft(''); setPrice('')
    reload()
  }, 'Listed on the marketplace')

  const cancel = (l: Listing) => run(`c${l.id}`, async () => {
    await submit({ TransactionType: 'NFTokenCancelOffer', NFTokenOffers: [l.sell_offer] }, 'Cancel listing')
    await api(`/market/listings/${l.id}/cancel`, { method: 'POST' })
    reload()
  }, 'Listing cancelled')

  const listedIds = new Set((listings.data ?? []).map((l) => l.nft_id))
  const shown = (listings.data ?? []).filter((l) => filter === 'all' || l.kind === filter)

  return (
    <>
      <div className="page-h">
        <div>
          <h1>Marketplace</h1>
          <p className="muted">
            Peer-to-peer NFT trading on XRPL brokered offers. Your NFT stays in your wallet until it sells, and the ledger swaps NFT and XRP atomically.
            Buyers pay a {pct(config?.marketFeeBps ?? 0)} fee.
          </p>
        </div>
        <div className="seg">
          {(['all', 'shop', 'p2p'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f === 'shop' ? 'Pawn shop' : f === 'p2p' ? 'Community' : 'All'}</button>)}
        </div>
      </div>

      <Card title="For sale" actions={<button className="ghost" onClick={reload}>Refresh</button>}>
        {shown.length === 0 ? <Empty>No listings yet.</Empty> : (
          <div className="grid">
            {shown.map((l) => (
              <div className="tile" key={l.id}>
                <NftImage nftId={l.nft_id} uri={l.uri} />
                <div className="tile-b">
                  <div className="row between">{l.kind === 'shop' ? <Badge s="pawn_shop" /> : <Addr a={l.seller} />}<span className="gold">{xrp(l.price_drops)}</span></div>
                  {l.seller === address ? (
                    <button className="ghost" disabled={!!busy} onClick={() => cancel(l)}>Cancel listing</button>
                  ) : (
                    <button className="primary" disabled={!address || !!busy} onClick={() => buy(l)}>{busy === `buy${l.id}` ? 'Buying…' : address ? 'Buy now' : 'Connect to buy'}</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {address && (
        <Card title="Sell an NFT">
          {(wallet.data ?? []).filter((n) => n.transferable && !listedIds.has(n.nftId)).length === 0 ? <Empty>No unlisted transferable NFTs in your wallet.</Empty> : (
            <>
              <div className="grid">
                {wallet.data!.filter((n) => n.transferable && !listedIds.has(n.nftId)).map((n) => (
                  <button key={n.nftId} className={`tile pick ${sellNft === n.nftId ? 'sel' : ''}`} onClick={() => setSellNft(n.nftId)}>
                    <NftImage nftId={n.nftId} uri={n.uri} />
                    <div className="tile-b"><span className="mono small">{n.nftId.slice(-10)}</span></div>
                  </button>
                ))}
              </div>
              <div className="row end">
                <label>You receive (XRP)<input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" /></label>
                <button className="primary" disabled={!!busy || !sellNft || !price} onClick={list}>{busy === 'list' ? 'Listing…' : 'List for sale'}</button>
              </div>
            </>
          )}
        </Card>
      )}
    </>
  )
}
