/**
 * Vault co-signer policy. The co-signer holds one of the vault's signer keys and only adds its signature
 * when a transaction passes these checks, all of which it verifies against the ledger itself.
 * It never trusts the main API's database, so a compromised API server alone cannot move NFTs.
 *
 * What the vault may do:
 *  1. Accept a deposit:    NFTokenAcceptOffer of a 0-XRP sell offer whose Destination is the vault.
 *  2. Return an NFT:       0-XRP sell offer to the NFT's depositor (found from the vault's own ledger history).
 *  3. Default to a lender: 0-XRP sell offer to someone else ONLY with a validated payment from that address to the
 *                          depositor (the loan funding), made after the deposit and older than the minimum loan age.
 *  4. Shop listing:        priced sell offer with Destination = broker (treasury) ONLY with a validated treasury
 *                          payment to the depositor (the pawn loan), older than the minimum loan age, priced at or
 *                          above a minimum fraction of that loan.
 *  5. Cancel its own offers.
 * Plus: fee cap, multisig-only, daily rate limits, and each loan payment can justify only one transfer.
 */

export class PolicyError extends Error {}

export interface Deposit { depositor: string; closeTimeUnix: number }
export interface ProofTx { account: string; destination: string; deliveredDrops: bigint | null; closeTimeUnix: number; type: string }

export interface PolicyDeps {
  getOffer(index: string): Promise<Record<string, any> | null>
  findDeposit(nftId: string): Promise<Deposit | null>
  getProofTx(hash: string): Promise<ProofTx>
  now(): number
  /** Bind a loan payment to one recipient of one NFT. False if it was already bound to a different recipient. */
  claimProof(key: string, recipient: string): boolean
  /** Count + record an event for rate limiting; returns the count in the last 24h including this one. */
  bump(kind: 'return' | 'transfer'): number
}

export interface PolicyConfig {
  vault: string
  broker: string // treasury address (also the pawn lender)
  maxFeeDrops: bigint
  minLoanAgeHours: number
  minProofDrops: bigint
  shopMinBps: number
  dailyReturnLimit: number
  dailyTransferLimit: number
}

export interface Context { reason?: string; fundTx?: string; loanId?: number }

const ALLOWED = new Set(['NFTokenAcceptOffer', 'NFTokenCreateOffer', 'NFTokenCancelOffer'])

export async function checkVaultTx(tx: Record<string, any>, ctx: Context, deps: PolicyDeps, cfg: PolicyConfig): Promise<string> {
  if (tx.Account !== cfg.vault) throw new PolicyError('Transaction is not from the vault')
  if (!ALLOWED.has(tx.TransactionType)) throw new PolicyError(`Vault may not send ${tx.TransactionType}`)
  if (tx.SigningPubKey !== '' && tx.SigningPubKey !== undefined) throw new PolicyError('Vault transactions must be multisigned')
  if (tx.Signers) throw new PolicyError('Send the unsigned transaction')
  if (!/^\d+$/.test(String(tx.Fee)) || BigInt(tx.Fee) > cfg.maxFeeDrops) throw new PolicyError(`Fee above cap of ${cfg.maxFeeDrops} drops`)

  if (tx.TransactionType === 'NFTokenCancelOffer') {
    if (!Array.isArray(tx.NFTokenOffers) || tx.NFTokenOffers.length === 0) throw new PolicyError('Nothing to cancel')
    return 'cancel own offers'
  }

  if (tx.TransactionType === 'NFTokenAcceptOffer') {
    if (tx.NFTokenBuyOffer || tx.NFTokenBrokerFee) throw new PolicyError('Vault may only accept incoming deposit offers')
    const offer = await deps.getOffer(String(tx.NFTokenSellOffer))
    if (!offer) throw new PolicyError('Deposit offer not found on ledger')
    if (!(Number(offer.Flags) & 1)) throw new PolicyError('Not a sell offer')
    if (offer.Destination !== cfg.vault) throw new PolicyError('Deposit offer is not addressed to the vault')
    if (offer.Amount !== '0') throw new PolicyError('Vault only accepts free (0 XRP) deposits; it never pays for NFTs')
    return `accept deposit from ${offer.Owner}`
  }

  // NFTokenCreateOffer
  if (Number(tx.Flags) !== 1) throw new PolicyError('Vault may only create plain sell offers')
  if (tx.Owner) throw new PolicyError('Vault may not create buy offers')
  if (typeof tx.Amount !== 'string') throw new PolicyError('Only XRP amounts are allowed')
  if (!tx.Destination) throw new PolicyError('Vault offers must name a Destination')
  const nftId = String(tx.NFTokenID).toUpperCase()
  const deposit = await deps.findDeposit(nftId)
  if (!deposit) throw new PolicyError('No deposit of this NFT found in the vault history')

  if (tx.Amount === '0') {
    if (tx.Destination === deposit.depositor) {
      if (deps.bump('return') > cfg.dailyReturnLimit) throw new PolicyError('Daily return limit reached')
      return `return NFT to depositor ${deposit.depositor}`
    }
    // Transfer to someone else: must be a lender whose funding payment to the depositor is on-ledger.
    const proof = await verifyProof(ctx, deps, cfg, deposit, String(tx.Destination))
    claim(deps, ctx, nftId, String(tx.Destination))
    if (deps.bump('transfer') > cfg.dailyTransferLimit) throw new PolicyError('Daily transfer limit reached')
    return `default transfer to lender ${tx.Destination} (loan payment ${proof})`
  }

  // Priced sell offer: only shop listings of forfeited pawn collateral, sold through the broker.
  if (tx.Destination !== cfg.broker) throw new PolicyError('Priced vault offers must go through the marketplace broker')
  const proof = await deps.getProofTx(requireFundTx(ctx))
  checkProofShape(proof, cfg.broker, deposit, cfg, deps)
  const min = (proof.deliveredDrops! * BigInt(cfg.shopMinBps)) / 10000n
  if (BigInt(tx.Amount) < min) throw new PolicyError(`Shop price must be at least ${min} drops (${cfg.shopMinBps / 100}% of the loan)`)
  claim(deps, ctx, nftId, cfg.broker)
  if (deps.bump('transfer') > cfg.dailyTransferLimit) throw new PolicyError('Daily transfer limit reached')
  return `shop listing for ${tx.Amount} drops`
}

function requireFundTx(ctx: Context): string {
  if (!ctx.fundTx || !/^[0-9A-Fa-f]{64}$/.test(ctx.fundTx)) throw new PolicyError('Loan funding transaction (fundTx) required')
  return ctx.fundTx
}

async function verifyProof(ctx: Context, deps: PolicyDeps, cfg: PolicyConfig, deposit: Deposit, lender: string) {
  const hash = requireFundTx(ctx)
  const proof = await deps.getProofTx(hash)
  checkProofShape(proof, lender, deposit, cfg, deps)
  return hash
}

function checkProofShape(proof: ProofTx, from: string, deposit: Deposit, cfg: PolicyConfig, deps: PolicyDeps) {
  if (proof.type !== 'Payment') throw new PolicyError('Loan proof is not a Payment')
  if (proof.account !== from) throw new PolicyError('Loan proof was not paid by the recipient of the NFT')
  if (proof.destination !== deposit.depositor) throw new PolicyError('Loan proof was not paid to the depositor')
  if (proof.deliveredDrops === null || proof.deliveredDrops < cfg.minProofDrops) throw new PolicyError('Loan proof amount too small')
  if (proof.closeTimeUnix < deposit.closeTimeUnix) throw new PolicyError('Loan proof predates the deposit')
  const ageHours = (deps.now() - proof.closeTimeUnix) / 3600
  if (ageHours < cfg.minLoanAgeHours) throw new PolicyError(`Loan is only ${ageHours.toFixed(1)}h old; minimum before default is ${cfg.minLoanAgeHours}h`)
}

function claim(deps: PolicyDeps, ctx: Context, nftId: string, recipient: string) {
  // Re-issuing the same transfer (e.g. an expired offer) is fine; redirecting it to someone else is not.
  if (!deps.claimProof(`${ctx.fundTx!.toUpperCase()}:${nftId}`, recipient)) throw new PolicyError('This loan payment was already used to move this NFT elsewhere')
}
