import { Client, Wallet, parseNFTokenID, convertHexToString, type SubmittableTransaction } from 'xrpl'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { config, RIPPLE_EPOCH_OFFSET } from './config.js'

let client: Client | null = null
let connecting: Promise<void> | null = null

export async function getClient(): Promise<Client> {
  if (!client) {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    client = new Client(config.xrplUrl, {
      connectionTimeout: 15_000,
      timeout: 30_000,
      ...(proxy ? { agent: new HttpsProxyAgent(proxy) as any } : {}),
    })
  }
  if (!client.isConnected()) {
    connecting ??= client.connect().finally(() => { connecting = null })
    await connecting
  }
  return client
}

let _vault: Wallet | null = null
let _treasury: Wallet | null = null
export const vaultWallet = () => (_vault ??= Wallet.fromSeed(config.vaultSeed))
export const treasuryWallet = () => (_treasury ??= Wallet.fromSeed(config.treasurySeed))

export class LedgerError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? `Ledger rejected transaction: ${code}`)
  }
}

export interface ValidatedTx {
  hash: string
  tx: Record<string, any>
  meta: Record<string, any>
  closeTimeUnix: number
}

/** Sign with a platform wallet, submit, wait for validation, throw unless tesSUCCESS. */
export async function submitAsPlatform(tx: SubmittableTransaction, wallet: Wallet): Promise<ValidatedTx> {
  const c = await getClient()
  const prepared = await c.autofill(tx)
  const signed = wallet.sign(prepared)
  let result: any
  try {
    result = (await c.submitAndWait(signed.tx_blob)).result
  } catch (e: any) {
    // submitAndWait can give up while the tx is still being validated (slow/lagging node).
    // Never assume failure for a signed tx: look it up by hash until LastLedgerSequence has passed.
    result = await waitForFinalTx(c, signed.hash, prepared.LastLedgerSequence!)
    if (!result) throw new LedgerError('timeout', `Transaction ${signed.hash} was not validated: ${e?.message}`)
  }
  const meta = result.meta as any
  const code = typeof meta === 'object' ? meta.TransactionResult : 'unknown'
  if (code !== 'tesSUCCESS') throw new LedgerError(code)
  return {
    hash: signed.hash,
    tx: result.tx_json ?? result,
    meta,
    closeTimeUnix: result.close_time_iso ? Date.parse(result.close_time_iso) / 1000 : Date.now() / 1000,
  }
}

async function waitForFinalTx(c: Client, hash: string, lastLedger: number) {
  for (let i = 0; i < 30; i++) {
    try {
      const r: any = (await c.request({ command: 'tx', transaction: hash } as any)).result
      if (r.validated) return r
    } catch { /* not found yet */ }
    const cur = await c.getLedgerIndex().catch(() => 0)
    if (cur > lastLedger + 2) return null
    await new Promise((r) => setTimeout(r, 2000))
  }
  return null
}

/** Fetch a transaction and require that it is validated and succeeded. */
export async function getValidatedTx(hash: string): Promise<ValidatedTx> {
  if (!/^[0-9A-Fa-f]{64}$/.test(hash)) throw new HttpError(400, 'Invalid transaction hash')
  const c = await getClient()
  let r: any
  try {
    r = (await c.request({ command: 'tx', transaction: hash } as any)).result
  } catch (e: any) {
    if (String(e?.data?.error ?? e?.message).includes('txnNotFound')) throw new HttpError(404, 'Transaction not found yet, try again in a few seconds')
    throw e
  }
  if (!r.validated) throw new HttpError(409, 'Transaction is not validated yet, try again in a few seconds')
  const meta = r.meta
  if (meta?.TransactionResult !== 'tesSUCCESS') throw new HttpError(400, `Transaction failed on ledger: ${meta?.TransactionResult}`)
  const tx = r.tx_json ?? r
  const closeTimeUnix = r.close_time_iso ? Date.parse(r.close_time_iso) / 1000 : (tx.date ?? 0) + RIPPLE_EPOCH_OFFSET
  return { hash: (r.hash ?? hash).toUpperCase(), tx, meta, closeTimeUnix }
}

/** Return an NFTokenOffer ledger object, or null if it no longer exists. */
export async function getNftOffer(offerIndex: string): Promise<Record<string, any> | null> {
  const c = await getClient()
  try {
    const r: any = await c.request({ command: 'ledger_entry', index: offerIndex, ledger_index: 'validated' } as any)
    const node = r.result.node
    return node?.LedgerEntryType === 'NFTokenOffer' ? node : null
  } catch (e: any) {
    if (String(e?.data?.error ?? e?.message).includes('entryNotFound')) return null
    throw e
  }
}

export interface AccountNft {
  NFTokenID: string
  Issuer: string
  NFTokenTaxon: number
  Flags: number
  TransferFee: number
  URI?: string
}

export async function getAccountNfts(address: string): Promise<AccountNft[]> {
  const c = await getClient()
  const out: AccountNft[] = []
  let marker: unknown
  do {
    try {
      const r: any = await c.request({ command: 'account_nfts', account: address, limit: 400, marker, ledger_index: 'validated' } as any)
      out.push(...r.result.account_nfts)
      marker = r.result.marker
    } catch (e: any) {
      if (String(e?.data?.error ?? e?.message).includes('actNotFound')) return []
      throw e
    }
  } while (marker)
  return out
}

export async function getXrpBalanceDrops(address: string): Promise<bigint> {
  const c = await getClient()
  const r: any = await c.request({ command: 'account_info', account: address, ledger_index: 'validated' } as any)
  return BigInt(r.result.account_data.Balance)
}

export async function getSpendableDrops(address: string): Promise<bigint> {
  const c = await getClient()
  const [info, state]: any[] = await Promise.all([
    c.request({ command: 'account_info', account: address, ledger_index: 'validated' } as any),
    c.request({ command: 'server_state' } as any),
  ])
  const vl = state.result.state.validated_ledger
  const reserve = BigInt(vl.reserve_base) + BigInt(vl.reserve_inc) * BigInt(info.result.account_data.OwnerCount)
  const bal = BigInt(info.result.account_data.Balance)
  return bal > reserve ? bal - reserve : 0n
}

export function describeNft(nftId: string) {
  const p = parseNFTokenID(nftId)
  return {
    nftId: nftId.toUpperCase(),
    issuer: p.Issuer,
    taxon: p.Taxon,
    flags: p.Flags,
    transferFee: p.TransferFee,
    transferable: (p.Flags & 0x0008) !== 0,
  }
}

export function decodeUri(hex?: string): string | null {
  if (!hex) return null
  try { return convertHexToString(hex) } catch { return null }
}

/** delivered_amount for XRP payments, in drops. Returns null for tokens (IOUs/MPTs). */
export function deliveredDrops(meta: Record<string, any>): bigint | null {
  const d = meta.delivered_amount ?? meta.DeliveredAmount
  return typeof d === 'string' ? BigInt(d) : null
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export const LSF_SELL_NFTOKEN = 0x00000001
export const TF_SELL_NFTOKEN = 0x00000001
