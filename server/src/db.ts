import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })

export const db = new DatabaseSync(config.dbPath)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS challenges (
  nonce TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS xaman_payloads (
  uuid TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,            -- 'signin' | 'tx'
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Approved collections and their appraisal (floor) values
CREATE TABLE IF NOT EXISTS collections (
  issuer TEXT NOT NULL,
  taxon INTEGER NOT NULL,           -- -1 = any taxon from this issuer
  name TEXT NOT NULL,
  floor_drops TEXT NOT NULL,
  ltv_bps INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, taxon)
);

-- Every NFT the vault account holds, and who it belongs to
CREATE TABLE IF NOT EXISTS custody (
  nft_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,              -- beneficial owner (the platform treasury for shop inventory)
  purpose TEXT NOT NULL,            -- 'safe' | 'collateral' | 'inventory'
  status TEXT NOT NULL,             -- 'held' | 'releasing' | 'released'
  loan_id INTEGER,
  uri TEXT,
  deposit_tx TEXT,
  release_to TEXT,
  release_offer TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,               -- 'platform' | 'p2p'
  status TEXT NOT NULL,             -- 'requested' | 'awaiting_funding' | 'active' | 'repaid' | 'defaulted' | 'cancelled'
  borrower TEXT NOT NULL,
  lender TEXT,                      -- treasury address for platform loans
  nft_id TEXT NOT NULL,
  principal_drops TEXT NOT NULL,
  apr_bps INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  interest_drops TEXT NOT NULL,
  accepted_offer_id INTEGER,
  accepted_at INTEGER,
  fund_tx TEXT,
  funded_at INTEGER,
  due_at INTEGER,
  repay_tx TEXT,
  repaid_at INTEGER,
  payout_tx TEXT,                   -- p2p: treasury -> lender forward of repayment
  payout_drops TEXT,
  defaulted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loan_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  lender TEXT NOT NULL,
  principal_drops TEXT NOT NULL,
  apr_bps INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  status TEXT NOT NULL,             -- 'open' | 'accepted' | 'withdrawn' | 'expired'
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,               -- 'p2p' | 'shop'
  nft_id TEXT NOT NULL,
  seller TEXT NOT NULL,
  sell_offer TEXT NOT NULL UNIQUE,
  ask_drops TEXT NOT NULL,          -- what the seller receives
  status TEXT NOT NULL,             -- 'active' | 'sold' | 'cancelled'
  buyer TEXT,
  sale_tx TEXT,
  uri TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- In-app notifications + reminder bookkeeping
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  loan_id INTEGER,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_addr ON notifications (address, id);
CREATE TABLE IF NOT EXISTS reminders_sent (
  loan_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (loan_id, stage)
);
-- Xaman user tokens let us push sign requests (e.g. repayments) to a user's phone
CREATE TABLE IF NOT EXISTS xaman_users (
  address TEXT PRIMARY KEY,
  user_token TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- TextRP (Matrix) delivery: per-user opt-in + the DM room with each wallet
CREATE TABLE IF NOT EXISTS user_prefs (
  address TEXT PRIMARY KEY,
  textrp INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS textrp_rooms (
  address TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Replay protection: a ledger tx can only be credited once
CREATE TABLE IF NOT EXISTS used_tx (
  hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`)

// Lightweight migrations for databases created by earlier versions
for (const sql of [
  'ALTER TABLE custody ADD COLUMN release_ctx TEXT',
  'ALTER TABLE collections ADD COLUMN live_floor_drops TEXT',
  'ALTER TABLE collections ADD COLUMN live_listings INTEGER',
  'ALTER TABLE collections ADD COLUMN live_source TEXT',
  'ALTER TABLE collections ADD COLUMN live_updated_at INTEGER',
  'ALTER TABLE collections ADD COLUMN live_error TEXT',
  'ALTER TABLE notifications ADD COLUMN textrp_status TEXT',
]) {
  try { db.exec(sql) } catch { /* column already exists */ }
}

export const now = () => Math.floor(Date.now() / 1000)

export function one<T = any>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined
}
export function all<T = any>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[]
}
export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params)
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Mark a ledger tx as consumed. Returns false if it was already used. */
export function claimTx(hash: string, purpose: string): boolean {
  try {
    run('INSERT INTO used_tx (hash, purpose, created_at) VALUES (?, ?, ?)', hash.toUpperCase(), purpose, now())
    return true
  } catch {
    return false
  }
}
export function unclaimTx(hash: string) {
  run('DELETE FROM used_tx WHERE hash = ?', hash.toUpperCase())
}

// Simple per-key async mutex so two requests can't act on the same loan/NFT at once
const locks = new Map<string, Promise<unknown>>()
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((r) => (release = r))
  const chained = prev.then(() => next)
  locks.set(key, chained)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === chained) locks.delete(key)
  }
}
