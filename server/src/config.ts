import 'dotenv/config'

function num(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number`)
  return n
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env ${name}. Run "npm run setup:testnet" or copy .env.example to .env.`)
  return v
}

export const config = {
  port: num('PORT', 8787),
  network: (process.env.XRPL_NETWORK ?? 'testnet') as 'testnet' | 'devnet' | 'mainnet',
  xrplUrl: process.env.XRPL_WS_URL ?? 'wss://testnet.xrpl-labs.com',
  dbPath: process.env.DB_PATH ?? 'data/xrpawn.db',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',

  /** Account that holds NFTs in custody (Safe deposits + loan collateral + shop inventory). */
  get vaultSeed() { return required('VAULT_SEED') },
  /** Account that funds platform loans, receives repayments and acts as NFT broker. */
  get treasurySeed() { return required('TREASURY_SEED') },

  adminAddresses: (process.env.ADMIN_ADDRESSES ?? '').split(',').map((s) => s.trim()).filter(Boolean),

  // Platform (pawn) loan terms
  platformAprBps: num('PLATFORM_APR_BPS', 2400), // 24% APR
  platformMaxDays: num('PLATFORM_MAX_DAYS', 90),
  defaultLtvBps: num('DEFAULT_LTV_BPS', 4000), // lend up to 40% of floor
  // Max total XRP the treasury may have out on platform loans (drops). 0 = only limited by balance.
  platformExposureCapDrops: BigInt(process.env.PLATFORM_EXPOSURE_CAP_DROPS ?? '0'),

  // P2P loans
  p2pFeeBps: num('P2P_FEE_BPS', 1000), // platform keeps 10% of the interest
  fundingWindowHours: num('FUNDING_WINDOW_HOURS', 24),

  // Both loan types
  graceHours: num('GRACE_HOURS', 72),

  // Marketplace
  marketFeeBps: num('MARKET_FEE_BPS', 200), // 2% broker fee, paid by buyer on top of ask

  jobIntervalMs: num('JOB_INTERVAL_MS', 60_000),
  sessionHours: num('SESSION_HOURS', 24),
}

export const RIPPLE_EPOCH_OFFSET = 946684800
