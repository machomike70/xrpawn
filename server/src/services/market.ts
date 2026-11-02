/**
 * P2P NFT marketplace using XRPL native brokered offers (XLS-20).
 *
 * The seller keeps the NFT in their own wallet. They create a sell offer for their asking price with
 * Destination = treasury (the broker). A buyer creates a buy offer for ask + broker fee. The broker submits
 * NFTokenAcceptOffer with both offers; the ledger swaps NFT and XRP atomically and pays the broker fee.
 * The broker can never take more than the buyer offered or give the seller less than they asked.
 *
 * Shop listings are NFTs the platform owns (defaulted pawn loans) sold from the vault the same way.
 */
import { config } from '../config.js'
import { all, claimTx, now, one, run, unclaimTx, withLock } from '../db.js'
import {
  HttpError, TF_SELL_NFTOKEN, decodeUri, getAccountNfts, getNftOffer, getValidatedTx, submitAsPlatform,
  submitAsVault, treasuryWallet, vaultAddress,
} from '../xrpl.js'
import { getCustody } from './custody.js'
import { notify } from './notify.js'

export interface ListingRow {
  id: number
  kind: 'p2p' | 'shop'
  nft_id: string
  seller: string
  sell_offer: string
  ask_drops: string
  status: 'active' | 'sold' | 'cancelled'
  buyer: string | null
  sale_tx: string | null
  uri: string | null
  created_at: number
  updated_at: number
}

export const buyerPrice = (ask: bigint) => ask + (ask * BigInt(config.marketFeeBps) + 9999n) / 10000n

const view = (l: ListingRow) => ({ ...l, price_drops: buyerPrice(BigInt(l.ask_drops)).toString(), broker: treasuryWallet().classicAddress })

export function listListings(filter: { seller?: string; status?: string } = {}) {
  const status = filter.status ?? 'active'
  const rows = filter.seller
    ? all<ListingRow>('SELECT * FROM listings WHERE seller = ? AND status = ? ORDER BY id DESC', filter.seller, status)
    : all<ListingRow>('SELECT * FROM listings WHERE status = ? ORDER BY id DESC LIMIT 200', status)
  return rows.map(view)
}

export const getListing = (id: number) => one<ListingRow>('SELECT * FROM listings WHERE id = ?', id)

/** Seller reports the sell offer they created (Destination = broker). */
export async function createListing(seller: string, offerTxHash: string) {
  const v = await getValidatedTx(offerTxHash)
  const t = v.tx
  const broker = treasuryWallet().classicAddress
  if (t.TransactionType !== 'NFTokenCreateOffer') throw new HttpError(400, 'Not an NFTokenCreateOffer transaction')
  if (t.Account !== seller) throw new HttpError(403, 'Offer was not created by your account')
  if (!(Number(t.Flags ?? 0) & TF_SELL_NFTOKEN)) throw new HttpError(400, 'Must be a sell offer')
  if (t.Destination !== broker) throw new HttpError(400, `Sell offer Destination must be the marketplace broker ${broker}`)
  if (typeof t.Amount !== 'string' || BigInt(t.Amount) <= 0n) throw new HttpError(400, 'Listings must be priced in XRP')
  const offerId: string = v.meta.offer_id
  if (!(await getNftOffer(offerId))) throw new HttpError(400, 'Offer no longer exists')
  const nftId = String(t.NFTokenID).toUpperCase()
  const nft = (await getAccountNfts(seller)).find((n) => n.NFTokenID === nftId)
  if (!nft) throw new HttpError(400, 'You do not hold this NFT')
  if (!claimTx(v.hash, 'listing')) throw new HttpError(409, 'Already listed')
  // A new listing replaces older active ones for the same NFT
  run("UPDATE listings SET status='cancelled', updated_at=? WHERE nft_id=? AND status='active'", now(), nftId)
  const r = run(
    `INSERT INTO listings (kind, nft_id, seller, sell_offer, ask_drops, status, uri, created_at, updated_at)
     VALUES ('p2p', ?, ?, ?, ?, 'active', ?, ?, ?)`,
    nftId, seller, offerId, t.Amount, decodeUri(nft.URI), now(), now(),
  )
  return view(getListing(Number(r.lastInsertRowid))!)
}

/** Admin lists a platform-owned NFT (from defaulted pawn loans) in the shop. */
export async function createShopListing(nftId: string, askDrops: string) {
  nftId = nftId.toUpperCase()
  if (!/^\d+$/.test(askDrops) || BigInt(askDrops) <= 0n) throw new HttpError(400, 'askDrops must be a positive integer string')
  return withLock(`nft:${nftId}`, async () => {
    const c = getCustody(nftId)
    if (!c || c.purpose !== 'inventory' || c.status !== 'held') throw new HttpError(404, 'Not in shop inventory')
    if (one("SELECT 1 FROM listings WHERE nft_id=? AND status='active'", nftId)) throw new HttpError(409, 'Already listed')
    // The co-signer only lets the vault sell an NFT whose pawn loan the treasury funded on-ledger.
    const loan = one<{ id: number; fund_tx: string }>(
      "SELECT id, fund_tx FROM loans WHERE nft_id=? AND kind='platform' AND status='defaulted' ORDER BY id DESC LIMIT 1", nftId)
    if (!loan?.fund_tx) throw new HttpError(409, 'No defaulted pawn loan found for this NFT')
    const res = await submitAsVault(
      { TransactionType: 'NFTokenCreateOffer', Account: vaultAddress(), NFTokenID: nftId, Amount: askDrops, Flags: TF_SELL_NFTOKEN, Destination: treasuryWallet().classicAddress },
      { reason: 'shop_listing', fundTx: loan.fund_tx, loanId: loan.id },
    )
    const r = run(
      `INSERT INTO listings (kind, nft_id, seller, sell_offer, ask_drops, status, uri, created_at, updated_at)
       VALUES ('shop', ?, ?, ?, ?, 'active', ?, ?, ?)`,
      nftId, vaultAddress(), res.meta.offer_id, askDrops, c.uri, now(), now(),
    )
    return view(getListing(Number(r.lastInsertRowid))!)
  })
}

/** Buyer reports the buy offer they created; the broker matches it with the listing. */
export async function buy(buyer: string, listingId: number, buyOfferTxHash: string) {
  const v = await getValidatedTx(buyOfferTxHash)
  return withLock(`listing:${listingId}`, async () => {
    const l = getListing(listingId)
    if (!l || l.status !== 'active') throw new HttpError(404, 'Listing not available')
    if (l.seller === buyer) throw new HttpError(400, 'You cannot buy your own listing')
    const t = v.tx
    if (t.TransactionType !== 'NFTokenCreateOffer') throw new HttpError(400, 'Not an NFTokenCreateOffer transaction')
    if (t.Account !== buyer) throw new HttpError(403, 'Buy offer was not created by your account')
    if (Number(t.Flags ?? 0) & TF_SELL_NFTOKEN) throw new HttpError(400, 'Must be a buy offer')
    if (String(t.NFTokenID).toUpperCase() !== l.nft_id) throw new HttpError(400, 'Buy offer is for a different NFT')
    if (t.Owner !== l.seller) throw new HttpError(400, 'Buy offer Owner must be the seller')
    const price = buyerPrice(BigInt(l.ask_drops))
    if (typeof t.Amount !== 'string' || BigInt(t.Amount) < price) throw new HttpError(400, `Buy offer must be at least ${price} drops`)
    const buyOffer: string = v.meta.offer_id
    if (!claimTx(v.hash, `buy:${l.id}`)) throw new HttpError(409, 'This buy offer was already used')

    const sellExists = await getNftOffer(l.sell_offer)
    if (!sellExists) {
      unclaimTx(v.hash)
      run("UPDATE listings SET status='cancelled', updated_at=? WHERE id=?", now(), l.id)
      throw new HttpError(410, 'Seller cancelled this listing. Cancel your buy offer to unlock your XRP reserve.')
    }
    const brokerFee = BigInt(t.Amount) - BigInt(l.ask_drops)
    let res
    try {
      res = await submitAsPlatform(
        {
          TransactionType: 'NFTokenAcceptOffer',
          Account: treasuryWallet().classicAddress,
          NFTokenSellOffer: l.sell_offer,
          NFTokenBuyOffer: buyOffer,
          ...(brokerFee > 0n ? { NFTokenBrokerFee: brokerFee.toString() } : {}),
        },
        treasuryWallet(),
      )
    } catch (e) {
      unclaimTx(v.hash)
      throw e
    }
    run("UPDATE listings SET status='sold', buyer=?, sale_tx=?, updated_at=? WHERE id=?", buyer, res.hash, now(), l.id)
    if (l.kind === 'p2p') notify(l.seller, 'nft_sold', 'Your NFT sold', `You received ${Number(l.ask_drops) / 1e6} XRP.`, { link: '/market' })
    if (l.kind === 'shop') {
      run("UPDATE custody SET status='released', owner=?, purpose='inventory', updated_at=? WHERE nft_id=?", buyer, now(), l.nft_id)
    }
    return view(getListing(l.id)!)
  })
}

/** Seller cancels: p2p sellers cancel the offer on-ledger themselves; shop listings are cancelled by the vault. */
export async function cancelListing(address: string, listingId: number, isAdmin: boolean) {
  return withLock(`listing:${listingId}`, async () => {
    const l = getListing(listingId)
    if (!l || l.status !== 'active') throw new HttpError(404, 'Listing not active')
    if (l.kind === 'shop') {
      if (!isAdmin) throw new HttpError(403, 'Admin only')
      if (await getNftOffer(l.sell_offer)) {
        await submitAsVault({ TransactionType: 'NFTokenCancelOffer', Account: vaultAddress(), NFTokenOffers: [l.sell_offer] }, { reason: 'cancel_offer' })
      }
    } else {
      if (l.seller !== address) throw new HttpError(403, 'Not your listing')
      if (await getNftOffer(l.sell_offer)) {
        throw new HttpError(409, 'Cancel the sell offer in your wallet first (NFTokenCancelOffer), then retry')
      }
    }
    run("UPDATE listings SET status='cancelled', updated_at=? WHERE id=?", now(), l.id)
    return view(getListing(l.id)!)
  })
}

/** Drop listings whose sell offer disappeared (seller cancelled, NFT moved). */
export async function syncListings() {
  for (const l of all<ListingRow>("SELECT * FROM listings WHERE status='active'")) {
    try {
      if (!(await getNftOffer(l.sell_offer))) run("UPDATE listings SET status='cancelled', updated_at=? WHERE id=?", now(), l.id)
    } catch (e) { console.error('syncListings', l.id, e) }
  }
}
