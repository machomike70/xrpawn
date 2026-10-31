/**
 * Xaman (formerly XUMM) integration via the Xaman Platform API.
 * Get API credentials at https://apps.xumm.dev and put them in .env:
 *   XAMAN_API_KEY=...   XAMAN_API_SECRET=...
 *
 * Flow: server creates a payload -> browser shows QR / deeplink -> user signs in the Xaman app
 * -> browser polls /api/xaman/payload/:uuid -> server reads the result from Xaman.
 * Xaman submits signed transactions to the ledger itself (options.submit = true).
 */
import { XummSdk } from 'xumm-sdk'
import { decode, verifySignature } from 'xrpl'
import { deriveAddress } from 'ripple-keypairs'
import { config } from '../config.js'
import { one, run, now } from '../db.js'
import { issueSession } from '../auth.js'
import { HttpError } from '../xrpl.js'

let sdk: XummSdk | null = null
export function xamanEnabled() {
  return Boolean(process.env.XAMAN_API_KEY && process.env.XAMAN_API_SECRET)
}
function client(): XummSdk {
  if (!xamanEnabled()) throw new HttpError(501, 'Xaman is not configured on this server (XAMAN_API_KEY / XAMAN_API_SECRET)')
  return (sdk ??= new XummSdk(process.env.XAMAN_API_KEY!, process.env.XAMAN_API_SECRET!))
}

const NETWORK_NAME: Record<string, string> = { mainnet: 'MAINNET', testnet: 'TESTNET', devnet: 'DEVNET' }

async function create(body: any, purpose: 'signin' | 'tx') {
  const created = await client().payload.create(
    {
      ...body,
      options: {
        submit: purpose === 'tx',
        expire: 5,
        force_network: NETWORK_NAME[config.network],
        ...(process.env.PUBLIC_WEB_URL ? { return_url: { web: process.env.PUBLIC_WEB_URL } } : {}),
      },
    },
    true,
  )
  if (!created) throw new HttpError(502, 'Xaman did not create the payload')
  run('INSERT INTO xaman_payloads (uuid, purpose, created_at) VALUES (?, ?, ?)', created.uuid, purpose, now())
  return { uuid: created.uuid, qrPng: created.refs.qr_png, deeplink: created.next.always, websocket: created.refs.websocket_status }
}

export function createSignIn() {
  return create({ txjson: { TransactionType: 'SignIn' } }, 'signin')
}

/** txjson is a normal XRPL transaction. Account may be omitted; Xaman fills in the signer. */
export function createTxPayload(txjson: Record<string, unknown>) {
  if (!txjson || typeof txjson.TransactionType !== 'string') throw new HttpError(400, 'txjson.TransactionType required')
  return create({ txjson }, 'tx')
}

export async function payloadStatus(uuid: string) {
  const row = one<{ purpose: string; consumed: number }>('SELECT purpose, consumed FROM xaman_payloads WHERE uuid = ?', uuid)
  if (!row) throw new HttpError(404, 'Unknown payload')
  const p = await client().payload.get(uuid, true)
  if (!p) throw new HttpError(502, 'Xaman lookup failed')
  const base = {
    uuid,
    resolved: p.meta.resolved,
    signed: p.meta.signed,
    cancelled: p.meta.cancelled,
    expired: p.meta.expired,
    account: p.response.account,
    txid: p.response.txid,
    dispatchedResult: p.response.dispatched_result,
  }

  if (row.purpose === 'signin' && p.meta.signed && p.response.hex) {
    if (row.consumed) throw new HttpError(409, 'Sign-in already used')
    // Verify the signed SignIn blob ourselves instead of trusting the API response alone.
    const signer = verifySignedBlob(p.response.hex)
    if (signer !== p.response.account) throw new HttpError(401, 'Xaman signature did not match account')
    run('UPDATE xaman_payloads SET consumed = 1 WHERE uuid = ?', uuid)
    return { ...base, token: issueSession(signer) }
  }
  return base
}

function verifySignedBlob(hex: string): string {
  if (!verifySignature(hex)) throw new HttpError(401, 'Invalid Xaman signature')
  const tx = decode(hex) as Record<string, any>
  if (!tx.Account || !tx.SigningPubKey) throw new HttpError(401, 'Signed blob has no account')
  // verifySignature only proves the blob was signed by SigningPubKey; make sure that key is the account's master key.
  // (Accounts that sign with a regular key would need an account_info RegularKey lookup; not supported in MVP.)
  if (deriveAddress(tx.SigningPubKey) !== tx.Account) throw new HttpError(401, 'Signing key does not belong to account')
  return tx.Account
}
