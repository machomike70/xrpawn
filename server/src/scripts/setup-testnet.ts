/**
 * Creates and funds the vault + treasury accounts on testnet, configures them, and writes .env.
 *   npm run setup:testnet            (keeps existing seeds if .env already has them)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { AccountSetAsfFlags, Client, Wallet } from 'xrpl'
import { HttpsProxyAgent } from 'https-proxy-agent'

const ENV = '.env'
const url = process.env.XRPL_WS_URL ?? 'wss://testnet.xrpl-labs.com'
const proxy = process.env.HTTPS_PROXY

function readEnv(): Record<string, string> {
  if (!existsSync(ENV)) return {}
  return Object.fromEntries(readFileSync(ENV, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
}

async function fund(address: string) {
  const r = await fetch('https://faucet.altnet.rippletest.net/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ destination: address }) })
  if (!r.ok) throw new Error(`faucet ${r.status}`)
}

async function waitForAccount(c: Client, address: string) {
  for (let i = 0; i < 20; i++) {
    try { await c.request({ command: 'account_info', account: address }); return } catch { await new Promise((r) => setTimeout(r, 2000)) }
  }
  throw new Error(`account ${address} not funded`)
}

const env = readEnv()
const c = new Client(url, proxy ? { agent: new HttpsProxyAgent(proxy) as any } : {})
await c.connect()

const vault = env.VAULT_SEED ? Wallet.fromSeed(env.VAULT_SEED) : Wallet.generate()
const treasury = env.TREASURY_SEED ? Wallet.fromSeed(env.TREASURY_SEED) : Wallet.generate()

for (const w of [vault, treasury]) {
  if (!env.VAULT_SEED || !env.TREASURY_SEED) {
    console.log('funding', w.classicAddress)
    await fund(w.classicAddress)
    await fund(w.classicAddress) // 2x faucet = ~200 test XRP of liquidity
  }
  await waitForAccount(c, w.classicAddress)
}

// Treasury requires a DestinationTag so every inbound repayment is attributable to a loan.
const r = await c.submitAndWait({ TransactionType: 'AccountSet', Account: treasury.classicAddress, SetFlag: AccountSetAsfFlags.asfRequireDest }, { wallet: treasury, autofill: true })
console.log('treasury RequireDest:', (r.result.meta as any).TransactionResult)
await c.disconnect()

const out = {
  PORT: env.PORT ?? '8787',
  XRPL_NETWORK: 'testnet',
  XRPL_WS_URL: url,
  CORS_ORIGIN: env.CORS_ORIGIN ?? 'http://localhost:5173',
  VAULT_SEED: vault.seed!,
  TREASURY_SEED: treasury.seed!,
  ADMIN_ADDRESSES: env.ADMIN_ADDRESSES ?? '',
  XAMAN_API_KEY: env.XAMAN_API_KEY ?? '',
  XAMAN_API_SECRET: env.XAMAN_API_SECRET ?? '',
}
const extra = Object.entries(env).filter(([k]) => !(k in out))
writeFileSync(ENV, [...Object.entries(out), ...extra].map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
console.log(`\nWrote ${ENV}\n  vault    ${vault.classicAddress}\n  treasury ${treasury.classicAddress}`)
console.log('Add your wallet address to ADMIN_ADDRESSES and your Xaman keys to .env, then: npm run dev')
