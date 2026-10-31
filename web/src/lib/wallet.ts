/**
 * Wallet adapters. Every adapter can (1) sign in (prove address ownership to the API)
 * and (2) sign + submit a transaction, returning the tx hash.
 *
 *  - Xaman: server creates a payload; we show a QR / deeplink; poll until signed.
 *  - GemWallet & Crossmark: browser extensions.
 *  - Dev wallet: a testnet seed kept in this browser (testnet/devnet only).
 */
import { Wallet as XrplWallet } from 'xrpl'
import { sign as kpSign } from 'ripple-keypairs'
import * as gem from '@gemwallet/api'
import sdk from '@crossmarkio/sdk'
import { api, setToken } from './api'

export type WalletKind = 'xaman' | 'gem' | 'crossmark' | 'dev'
export type Tx = Record<string, unknown> & { TransactionType: string }

export interface XamanPrompt {
  uuid: string
  qrPng: string
  deeplink: string
  title: string
}

// The UI registers a handler so adapters can show the Xaman QR modal.
let xamanUi: { open: (p: XamanPrompt) => void; close: () => void; cancelled: () => boolean } | null = null
export function registerXamanUi(ui: typeof xamanUi) { xamanUi = ui }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function xamanFlow(created: { uuid: string; qrPng: string; deeplink: string }, title: string) {
  xamanUi?.open({ ...created, title })
  try {
    for (;;) {
      await sleep(2000)
      if (xamanUi?.cancelled()) throw new Error('Cancelled')
      const s = await api(`/xaman/payload/${created.uuid}`)
      if (s.resolved || s.expired) {
        if (!s.signed) throw new Error(s.expired ? 'Xaman request expired' : 'Rejected in Xaman')
        return s
      }
    }
  } finally {
    xamanUi?.close()
  }
}

// ---------------------------------------------------------------- dev wallet
const DEV_KEY = 'xrpawn.devseed'
export function devWallet(): XrplWallet {
  let seed: string | null = null
  try { seed = localStorage.getItem(DEV_KEY) } catch { /* ignore */ }
  if (!seed) {
    seed = XrplWallet.generate().seed!
    try { localStorage.setItem(DEV_KEY, seed) } catch { /* ignore */ }
  }
  return XrplWallet.fromSeed(seed)
}
export function resetDevWallet() {
  try { localStorage.removeItem(DEV_KEY) } catch { /* ignore */ }
}

// ---------------------------------------------------------------- sign in
export async function signIn(kind: WalletKind): Promise<string> {
  if (kind === 'xaman') {
    const created = await api('/xaman/signin', { method: 'POST' })
    const s = await xamanFlow(created, 'Sign in with Xaman')
    if (!s.token) throw new Error('Xaman sign-in could not be verified')
    setToken(s.token)
    return s.account
  }

  const ch = await api<{ nonce: string; hex: string }>('/auth/challenge', { method: 'POST' })
  let address: string, publicKey: string, signature: string

  if (kind === 'dev') {
    const w = devWallet()
    address = w.classicAddress
    publicKey = w.publicKey
    signature = kpSign(ch.hex, w.privateKey)
  } else if (kind === 'gem') {
    if (!(await gem.isInstalled()).result?.isInstalled) throw new Error('GemWallet extension not found')
    const pk = await gem.getPublicKey()
    if (!pk.result) throw new Error('GemWallet: request rejected')
    const sig = await gem.signMessage(ch.hex, true)
    if (!sig.result?.signedMessage) throw new Error('GemWallet: signature rejected')
    ;({ address, publicKey } = pk.result)
    signature = sig.result.signedMessage
  } else {
    if (!sdk.sync.isInstalled()) throw new Error('Crossmark extension not found')
    const r = await sdk.methods.signInAndWait(ch.hex)
    const d = r.response.data
    if (!d?.address || !d.signature) throw new Error('Crossmark: sign-in rejected')
    ;({ address, publicKey } = d)
    signature = d.signature
  }

  const { token } = await api('/auth/verify', { body: { address, publicKey, signature, nonce: ch.nonce } })
  setToken(token)
  return address
}

// ---------------------------------------------------------------- sign & submit
export async function signAndSubmit(kind: WalletKind, account: string, tx: Tx, title = 'Approve transaction'): Promise<string> {
  const full = { ...tx, Account: account }

  if (kind === 'xaman') {
    const created = await api('/xaman/tx', { body: { txjson: full } })
    const s = await xamanFlow(created, title)
    if (!s.txid) throw new Error('Xaman did not return a transaction id')
    if (s.dispatchedResult && s.dispatchedResult !== 'tesSUCCESS') throw new Error(`Ledger result: ${s.dispatchedResult}`)
    return s.txid
  }

  if (kind === 'dev') {
    const w = devWallet()
    const prepared = await api('/xrpl/prepare', { body: { tx: full } })
    const signed = w.sign(prepared)
    const r = await api('/xrpl/submit', { body: { tx_blob: signed.tx_blob } })
    if (r.result !== 'tesSUCCESS') throw new Error(`Ledger result: ${r.result}`)
    return r.hash
  }

  if (kind === 'gem') {
    const r = await gem.submitTransaction({ transaction: full as any })
    if (!r.result?.hash) throw new Error('GemWallet: transaction rejected')
    return r.result.hash
  }

  const r: any = await sdk.methods.signAndSubmitAndWait(full as any)
  const resp = r.response?.data?.resp
  const hash = resp?.result?.hash ?? resp?.hash
  const code = resp?.result?.meta?.TransactionResult ?? resp?.result?.engine_result
  if (!hash) throw new Error('Crossmark: transaction rejected')
  if (code && code !== 'tesSUCCESS') throw new Error(`Ledger result: ${code}`)
  return hash
}

export const WALLET_LABELS: Record<WalletKind, string> = {
  xaman: 'Xaman',
  gem: 'GemWallet',
  crossmark: 'Crossmark',
  dev: 'Testnet dev wallet',
}
