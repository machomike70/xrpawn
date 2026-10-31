import { randomBytes } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { deriveAddress, verify as verifyKeypair } from 'ripple-keypairs'
import { convertStringToHex, isValidClassicAddress } from 'xrpl'
import { config } from './config.js'
import { one, run, now } from './db.js'
import { HttpError } from './xrpl.js'

const CHALLENGE_TTL = 5 * 60

export function challengeMessage(nonce: string) {
  return `Sign in to XRPawn\nThis does not move any funds.\nNonce: ${nonce}`
}

export function createChallenge() {
  const nonce = randomBytes(16).toString('hex')
  run('INSERT INTO challenges (nonce, created_at) VALUES (?, ?)', nonce, now())
  const message = challengeMessage(nonce)
  return { nonce, message, hex: convertStringToHex(message) }
}

/**
 * Verify a wallet's signature over the challenge (GemWallet, Crossmark, dev wallet).
 * The public key must derive to the claimed address and must have signed the hex message.
 */
export function verifyChallenge(args: { address: string; publicKey: string; signature: string; nonce: string }): string {
  const { address, publicKey, signature, nonce } = args
  const row = one<{ created_at: number }>('SELECT created_at FROM challenges WHERE nonce = ?', nonce)
  if (!row || now() - row.created_at > CHALLENGE_TTL) throw new HttpError(401, 'Challenge expired, please try again')
  run('DELETE FROM challenges WHERE nonce = ?', nonce)
  if (!isValidClassicAddress(address)) throw new HttpError(400, 'Invalid address')
  let derived: string
  try { derived = deriveAddress(publicKey) } catch { throw new HttpError(400, 'Invalid public key') }
  // Note: accounts that use a regular key (master disabled) need the regular-key flow; not supported in MVP.
  if (derived !== address) throw new HttpError(401, 'Public key does not match address')
  const hex = convertStringToHex(challengeMessage(nonce))
  let ok = false
  try { ok = verifyKeypair(hex, signature, publicKey) } catch { ok = false }
  if (!ok) throw new HttpError(401, 'Bad signature')
  return issueSession(address)
}

export function issueSession(address: string): string {
  const token = randomBytes(32).toString('hex')
  run('INSERT INTO sessions (token, address, expires_at) VALUES (?, ?, ?)', token, address, now() + config.sessionHours * 3600)
  return token
}

export function sessionAddress(req: Request): string | null {
  const h = req.header('authorization')
  if (!h?.startsWith('Bearer ')) return null
  const row = one<{ address: string; expires_at: number }>('SELECT address, expires_at FROM sessions WHERE token = ?', h.slice(7))
  if (!row || row.expires_at < now()) return null
  return row.address
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { address?: string }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const a = sessionAddress(req)
  if (!a) throw new HttpError(401, 'Connect your wallet first')
  req.address = a
  next()
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (!config.adminAddresses.includes(req.address!)) throw new HttpError(403, 'Admin only')
    next()
  })
}

export function logout(req: Request) {
  const h = req.header('authorization')
  if (h?.startsWith('Bearer ')) run('DELETE FROM sessions WHERE token = ?', h.slice(7))
}
