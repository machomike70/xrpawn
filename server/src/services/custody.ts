/**
 * The Safe: NFT custody in the platform vault account.
 *
 * Deposit: the owner creates a 0-XRP sell offer whose Destination is the vault, so only the vault can take it.
 *          The vault accepts it and we record the depositor as beneficial owner.
 * Release: the vault creates a 0-XRP sell offer whose Destination is the recipient. Only that recipient can
 *          accept it, so even a compromised API cannot redirect a release to someone else.
 */
import { config } from '../config.js'
import { all, claimTx, now, one, run, unclaimTx, withLock } from '../db.js'
import {
  HttpError, TF_SELL_NFTOKEN, describeNft, decodeUri, getAccountNfts, getNftOffer, getValidatedTx,
  submitAsPlatform, vaultWallet,
} from '../xrpl.js'

export interface CustodyRow {
  nft_id: string
  owner: string
  purpose: 'safe' | 'collateral' | 'inventory'
  status: 'held' | 'releasing' | 'released'
  loan_id: number | null
  uri: string | null
  deposit_tx: string | null
  release_to: string | null
  release_offer: string | null
  created_at: number
  updated_at: number
}

export const getCustody = (nftId: string) => one<CustodyRow>('SELECT * FROM custody WHERE nft_id = ?', nftId.toUpperCase())

export function listCustody(owner: string) {
  return all<CustodyRow>(
    "SELECT * FROM custody WHERE (owner = ? AND status != 'released') OR (release_to = ? AND status = 'releasing') ORDER BY updated_at DESC",
    owner, owner,
  )
}

/** Verify the depositor's offer transaction and pull the NFT into the vault. */
export async function deposit(owner: string, offerTxHash: string): Promise<CustodyRow> {
  const v = await getValidatedTx(offerTxHash)
  const t = v.tx
  const vault = vaultWallet().classicAddress
  if (t.TransactionType !== 'NFTokenCreateOffer') throw new HttpError(400, 'Not an NFTokenCreateOffer transaction')
  if (t.Account !== owner) throw new HttpError(403, 'Offer was not created by your account')
  if (!(Number(t.Flags ?? 0) & TF_SELL_NFTOKEN)) throw new HttpError(400, 'Offer must be a sell offer')
  if (t.Destination !== vault) throw new HttpError(400, `Offer Destination must be the vault ${vault}`)
  if (t.Amount !== '0') throw new HttpError(400, 'Deposit offer amount must be 0')
  const offerId: string = v.meta.offer_id
  const nftId = String(t.NFTokenID).toUpperCase()
  if (!offerId) throw new HttpError(400, 'Could not determine offer id from transaction metadata')

  const info = describeNft(nftId)
  if (!info.transferable && info.issuer !== vault) {
    throw new HttpError(400, 'This NFT was minted without the transferable flag and cannot be moved into custody')
  }

  return withLock(`nft:${nftId}`, async () => {
    const existing = getCustody(nftId)
    if (existing && existing.status !== 'released') throw new HttpError(409, 'NFT is already in custody')
    if (!claimTx(v.hash, 'deposit')) throw new HttpError(409, 'This deposit was already processed')
    try {
      if (!(await getNftOffer(offerId))) throw new HttpError(400, 'Deposit offer no longer exists (cancelled or expired)')
      await submitAsPlatform({ TransactionType: 'NFTokenAcceptOffer', Account: vault, NFTokenSellOffer: offerId }, vaultWallet())
    } catch (e) {
      unclaimTx(v.hash)
      throw e
    }
    const held = (await getAccountNfts(vault)).find((n) => n.NFTokenID === nftId)
    const uri = decodeUri(held?.URI)
    const ts = now()
    run(
      `INSERT INTO custody (nft_id, owner, purpose, status, loan_id, uri, deposit_tx, release_to, release_offer, created_at, updated_at)
       VALUES (?, ?, 'safe', 'held', NULL, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(nft_id) DO UPDATE SET owner = excluded.owner, purpose = 'safe', status = 'held', loan_id = NULL,
         uri = excluded.uri, deposit_tx = excluded.deposit_tx, release_to = NULL, release_offer = NULL, updated_at = excluded.updated_at`,
      nftId, owner, uri, v.hash, ts, ts,
    )
    return getCustody(nftId)!
  })
}

/** Create a destination-locked 0 XRP sell offer from the vault to `to`. Caller must hold the NFT lock. */
export async function releaseTo(nftId: string, to: string): Promise<CustodyRow> {
  const res = await submitAsPlatform(
    {
      TransactionType: 'NFTokenCreateOffer',
      Account: vaultWallet().classicAddress,
      NFTokenID: nftId,
      Amount: '0',
      Flags: TF_SELL_NFTOKEN,
      Destination: to,
    },
    vaultWallet(),
  )
  run(
    "UPDATE custody SET status = 'releasing', release_to = ?, release_offer = ?, updated_at = ? WHERE nft_id = ?",
    to, res.meta.offer_id, now(), nftId,
  )
  return getCustody(nftId)!
}

/** Owner withdraws an NFT they stored in the Safe. */
export async function withdraw(owner: string, nftId: string) {
  nftId = nftId.toUpperCase()
  return withLock(`nft:${nftId}`, async () => {
    const c = getCustody(nftId)
    if (!c || c.owner !== owner) throw new HttpError(404, 'NFT not found in your Safe')
    if (c.status === 'releasing') return c // offer already waiting for the owner
    if (c.status !== 'held' || c.purpose !== 'safe') throw new HttpError(409, 'NFT is locked as loan collateral and cannot be withdrawn')
    return releaseTo(nftId, owner)
  })
}

/** Mark releases complete once the recipient has accepted the offer. */
export async function syncRelease(nftId: string): Promise<CustodyRow | undefined> {
  const c = getCustody(nftId)
  if (!c || c.status !== 'releasing') return c
  const vaultHas = (await getAccountNfts(vaultWallet().classicAddress)).some((n) => n.NFTokenID === c.nft_id)
  if (!vaultHas) {
    run("UPDATE custody SET status = 'released', owner = COALESCE(release_to, owner), updated_at = ? WHERE nft_id = ?", now(), nftId)
  } else if (c.release_offer && !(await getNftOffer(c.release_offer))) {
    // Offer vanished but NFT still here (e.g. recipient cancelled it); recreate so it can be claimed.
    await withLock(`nft:${nftId}`, () => releaseTo(nftId, c.release_to!))
  }
  return getCustody(nftId)
}

export async function syncAllReleases() {
  for (const r of all<{ nft_id: string }>("SELECT nft_id FROM custody WHERE status = 'releasing'")) {
    try { await syncRelease(r.nft_id) } catch (e) { console.error('syncRelease', r.nft_id, e) }
  }
}

export const vaultAddress = () => vaultWallet().classicAddress
export { config }
