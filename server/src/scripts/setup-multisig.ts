/**
 * Convert the vault to a 2-of-3 multisig account and disable its master key.
 *
 *   npm run setup:multisig
 *
 * Creates three signer keys:
 *   1. API signer      -> written to .env (VAULT_SIGNER_SEED)
 *   2. Co-signer       -> written to cosigner.env (run `npm run cosigner` with it, ideally on another machine)
 *   3. Backup (cold)   -> written ONCE to vault-backup-key.txt. Move it offline (paper/hardware) and delete the file.
 * Any two of them can sign. Normal operation uses 1 + 2; if either is lost, use 3 to recover.
 *
 * This is irreversible for the vault's master key. On mainnet pass --mainnet to confirm.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { Client, Wallet } from 'xrpl'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { convertToMultisig } from '../multisig.js'

const ENV = '.env'
const lines = existsSync(ENV) ? readFileSync(ENV, 'utf8').split('\n') : []
const env = Object.fromEntries(lines.filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))

if (!env.VAULT_SEED) throw new Error('VAULT_SEED not found in .env (already converted? look for VAULT_ADDRESS)')
if (env.XRPL_NETWORK === 'mainnet' && !process.argv.includes('--mainnet')) {
  throw new Error('This disables the vault master key on MAINNET. Re-run with --mainnet once you have read the README section on multisig.')
}

const master = Wallet.fromSeed(env.VAULT_SEED)
const apiSigner = Wallet.generate()
const cosigner = Wallet.generate()
const backup = Wallet.generate()
const token = randomBytes(32).toString('hex')

const proxy = process.env.HTTPS_PROXY
const client = new Client(env.XRPL_WS_URL ?? 'wss://testnet.xrpl-labs.com', proxy ? { agent: new HttpsProxyAgent(proxy) as any } : {})
await client.connect()
console.log(`Converting vault ${master.classicAddress} to 2-of-3 multisig…`)
await convertToMultisig(client, master, [apiSigner.classicAddress, cosigner.classicAddress, backup.classicAddress], 2)
await client.disconnect()

const treasury = Wallet.fromSeed(env.TREASURY_SEED).classicAddress
const keep = lines.filter((l) => !/^(VAULT_SEED|VAULT_ADDRESS|VAULT_SIGNER_SEED|COSIGNER_URL|COSIGNER_TOKEN)=/.test(l) && l.trim() !== '')
writeFileSync(ENV, [
  ...keep,
  `# Vault is multisig since ${new Date().toISOString()} (master key disabled)`,
  `VAULT_ADDRESS=${master.classicAddress}`,
  `VAULT_SIGNER_SEED=${apiSigner.seed}`,
  'COSIGNER_URL=http://localhost:8788',
  `COSIGNER_TOKEN=${token}`,
].join('\n') + '\n')

writeFileSync('cosigner.env', [
  `XRPL_WS_URL=${env.XRPL_WS_URL ?? 'wss://testnet.xrpl-labs.com'}`,
  `VAULT_ADDRESS=${master.classicAddress}`,
  `TREASURY_ADDRESS=${treasury}`,
  `COSIGNER_SEED=${cosigner.seed}`,
  `COSIGNER_TOKEN=${token}`,
  'COSIGNER_PORT=8788',
  'COSIGNER_MIN_LOAN_AGE_HOURS=96',
].join('\n') + '\n')

writeFileSync('vault-backup-key.txt', [
  'XRPawn vault BACKUP signer key. Anyone holding this AND one other signer key controls the vault.',
  'Copy it to paper or a hardware wallet, store it offline, then DELETE this file.',
  `Vault:          ${master.classicAddress}`,
  `Backup signer:  ${backup.classicAddress}`,
  `Backup seed:    ${backup.seed}`,
].join('\n') + '\n')

console.log(`Done.
  API signer     ${apiSigner.classicAddress}  (.env)
  Co-signer      ${cosigner.classicAddress}  (cosigner.env)
  Backup signer  ${backup.classicAddress}  (vault-backup-key.txt: move offline, then delete!)
Start the co-signer with:  npm run cosigner`)
