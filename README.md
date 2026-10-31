# XRPawn: NFT pawn shop, lending and P2P trading on the XRP Ledger

XRPawn is a web app for XLS-20 NFTs on the XRP Ledger (XRPL). It has five parts:

| Feature | What it does |
|---|---|
| **Pawn loans** | Borrow XRP instantly from the platform treasury against an approved NFT (up to the collection's loan-to-value (LTV) limit, fixed fee). If the loan isn't repaid, the NFT goes to the shop. |
| **P2P lending** | A borrower posts terms, lenders compete with offers, the borrower picks one, and the lender pays the borrower directly. If the loan defaults, the lender gets the NFT. The platform keeps a % of the interest. |
| **Marketplace** | Peer-to-peer NFT sales using XRPL's native *brokered offers*. The NFT stays in the seller's wallet until it sells, and the ledger swaps NFT and XRP atomically. Buyers pay a broker fee. Forfeited pawn NFTs are sold here as "Pawn shop" listings. |
| **The Safe** | Custody for NFTs in the platform vault. Withdrawals are offers that only the owner's address can accept. |
| **Back office** | The admin approves collections and sets floor prices, watches treasury liquidity, and lists forfeited NFTs for sale. |

Supported wallets: **Xaman** (QR code / mobile), **GemWallet**, **Crossmark**, plus a built-in **testnet dev wallet** so you can try everything with nothing installed.

---

## Run it on Windows (step by step)

1. Install **Node.js 22 LTS** from https://nodejs.org (use the default options).
2. Open **PowerShell** in the `xrpawn` folder (in File Explorer, Shift + right-click → *Open PowerShell window here*).
3. Install everything:
   ```powershell
   npm run install:all
   ```
4. Create the platform's testnet accounts (vault + treasury, funded with free test XRP):
   ```powershell
   npm run setup
   ```
5. Start the app:
   ```powershell
   npm run dev
   ```
6. Open **http://localhost:5173** → *Connect wallet* → *Testnet dev wallet* → go to **Safe** → *Get test XRP* → *Mint test NFT* → *Deposit to Safe*.

### Make yourself admin
Connect a wallet, copy your `r…` address from the top bar, put it in `server\.env`:
```
ADMIN_ADDRESSES=rYourAddressHere
```
Restart `npm run dev`. An **Admin** tab appears. Approve a collection there (issuer address + floor price) so pawn loans can be quoted. Test NFTs minted in the app use your own address as issuer and taxon `0`.

### Turn on Xaman
1. Go to https://apps.xumm.dev and sign in with the Xaman app.
2. **Create app**, add `http://localhost:5173` (and later your real domain) as the website.
3. Copy the API key and secret into `server\.env`:
   ```
   XAMAN_API_KEY=...
   XAMAN_API_SECRET=...
   ```
4. Restart. The Xaman option in *Connect wallet* is now enabled. Never share these keys or commit `.env`.

---

## How it works on the XRPL

The XRP Ledger mainnet has no general-purpose smart contracts, so XRPawn combines **native ledger features** (which enforce the safety-critical parts) with a **platform server** (which enforces loan terms).

| Step | On-ledger mechanism | Who can cheat? |
|---|---|---|
| Deposit to Safe | User creates a 0 XRP `NFTokenCreateOffer` with `Destination = vault`; vault accepts | Only the vault can take the offer |
| Release from Safe / repaid loan | Vault creates 0 XRP sell offer with `Destination = owner` | Only the owner can accept, so even a hacked API can't redirect it |
| Platform loan payout | Treasury `Payment` → borrower | – |
| P2P funding | Lender `Payment` → borrower, verified by tx hash (or found automatically by the server) | – |
| Repayment | Borrower `Payment` → treasury with the loan's `DestinationTag` (treasury has `RequireDest`) | Underpayments and payments to closed loans are auto-refunded, as is any overpaid excess |
| Marketplace sale | Brokered `NFTokenAcceptOffer` (sell offer + buy offer + `NFTokenBrokerFee`) | Ledger guarantees seller gets ≥ ask and buyer pays ≤ bid |

**Trust model (be upfront with users about this):** while an NFT is in custody, users trust the operator's vault account, and lenders trust the operator to release collateral on default. The server checks every claim against validated ledger data, using `delivered_amount` (which protects against the partial-payment trick), rejects reused transactions, and gives each NFT and loan its own lock. Before mainnet, harden the keys as described below.

### Project layout
```
server/   Node + Express + xrpl.js API, SQLite (node:sqlite), background jobs
  src/services/custody.ts    Safe deposits / releases
  src/services/loans.ts      pawn + P2P loans, repayment, refunds, defaults
  src/services/market.ts     brokered marketplace + shop listings
  src/services/appraisal.ts  collection floors & LTV
  src/services/xaman.ts      Xaman sign-in + sign requests
  src/scripts/e2e.ts         full end-to-end test on XRPL testnet
web/      React + Vite front end (Borrow, Lend, Market, Safe, Admin)
```

### Tests
```powershell
cd server
npm run e2e
```
This creates fresh testnet wallets and runs every flow against the real testnet: Safe deposit and withdraw, a pawn loan (including LTV limits, collateral lock, short-payment refund, replay protection), a P2P loan (offer, accept, fund, repay, lender payout, overpayment refund), a P2P default where the lender gets the NFT, an unreported funding payment that the server finds on-ledger, a marketplace sale with the broker fee, and a pawn default sold through the shop.

### Configuration (`server/.env`)
See `server/.env.example`. Key terms (bps = basis points, 100 = 1%):
`PLATFORM_APR_BPS` (24%), `DEFAULT_LTV_BPS` (40%), `PLATFORM_MAX_DAYS` (90), `GRACE_HOURS` (72), `P2P_FEE_BPS` (10% of interest), `MARKET_FEE_BPS` (2%), `PLATFORM_EXPOSURE_CAP_DROPS`.

Interest is a **fixed fee for the term**: principal × APR × days / 365. Repaying early costs the same.

---

## Before going to mainnet (checklist)

**Keys & accounts**
- [ ] Vault: set up a `SignerListSet` multisig (e.g. 2-of-3 on separate devices/HSM) and **disable the master key**. The server then needs a co-signing flow, or should hold only a regular key with limited funds.
- [ ] Treasury: keep only working liquidity hot; refill from cold storage.
- [ ] Seeds in a secrets manager (not a `.env` file on disk).
- [ ] `XRPL_NETWORK=mainnet`, `XRPL_WS_URL=wss://xrplcluster.com` (dev wallet and faucet routes switch off automatically on mainnet).

**Business / legal (talk to a lawyer: these are regulated activities in most places)**
- [ ] Pawn / consumer-lending licences and interest-rate (usury) caps where your users live.
- [ ] KYC/AML for borrowers and lenders, sanctions screening.
- [ ] Custody disclosures and terms of service; how forfeited NFTs are handled.
- [ ] Tax treatment of loans, defaults and sales.

**Product**
- [ ] Live price feed for appraisals (plug into `services/appraisal.ts`; keys `PRICE_FEED_URL` / `PRICE_FEED_API_KEY` / `BITHOMP_API_KEY` are reserved in `.env`).
- [ ] Notifications (due-date reminders, offer received).
- [ ] Use Postgres instead of SQLite if you run more than one server instance.
- [ ] Watch for XRPL's native lending protocol (XLS-65/66): once enabled on mainnet, parts of the loan logic could move fully on-ledger.
