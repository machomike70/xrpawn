import { convertStringToHex } from 'xrpl'
import { api, report } from '../lib/api'
import { useAction, useSession } from '../lib/session'
import { useLoad } from '../lib/useLoad'
import { Badge, Card, Empty, NeedWallet, NftImage } from '../components/ui'

export interface WalletNft { nftId: string; issuer: string; taxon: number; transferable: boolean; uri: string | null }
export interface CustodyRow { nft_id: string; owner: string; purpose: string; status: string; loan_id: number | null; uri: string | null; release_to: string | null; release_offer: string | null }

export function useWalletNfts() {
  const { address } = useSession()
  return useLoad(() => (address ? api<WalletNft[]>(`/nfts/${address}`) : Promise.resolve([])), [address])
}
export function useCustody() {
  const { address } = useSession()
  return useLoad(() => (address ? api<CustodyRow[]>('/custody') : Promise.resolve([])), [address])
}

/** Accept the vault's destination-locked release offer and mark it done. */
export async function claimNft(submit: ReturnType<typeof useSession>['submit'], c: CustodyRow) {
  await submit({ TransactionType: 'NFTokenAcceptOffer', NFTokenSellOffer: c.release_offer! }, 'Claim NFT from the vault')
  await api(`/custody/${c.nft_id}/sync`, { method: 'POST' })
}

export default function Safe() {
  const { address, config, kind, submit } = useSession()
  const wallet = useWalletNfts()
  const custody = useCustody()
  const { busy, run } = useAction()
  const reload = () => { wallet.reload(); custody.reload() }

  const deposit = (nftId: string) =>
    run(nftId, async () => {
      const hash = await submit(
        { TransactionType: 'NFTokenCreateOffer', NFTokenID: nftId, Amount: '0', Flags: 1, Destination: config!.vault },
        'Deposit NFT into the Safe',
      )
      await report('/custody/deposit', { txHash: hash })
      reload()
    }, 'NFT secured in the vault')

  const withdraw = (c: CustodyRow) =>
    run(c.nft_id, async () => {
      const row = await api<CustodyRow>(`/custody/${c.nft_id}/withdraw`, { method: 'POST' })
      await claimNft(submit, row)
      reload()
    }, 'NFT returned to your wallet')

  const claim = (c: CustodyRow) => run(c.nft_id, async () => { await claimNft(submit, c); reload() }, 'NFT claimed')

  const mintTest = () =>
    run('mint', async () => {
      await submit({ TransactionType: 'NFTokenMint', NFTokenTaxon: 0, Flags: 8, URI: convertStringToHex(`xrpawn-test-${Date.now()}`) }, 'Mint a test NFT')
      reload()
    }, 'Test NFT minted')

  const faucet = () => run('faucet', async () => { await api('/xrpl/faucet', { body: { address } }); reload() }, 'Funded with test XRP')

  const inSafe = (custody.data ?? []).filter((c) => c.status !== 'released')
  const pending = inSafe.filter((c) => c.status === 'releasing' && c.release_to === address)

  return (
    <NeedWallet>
      <div className="page-h">
        <div>
          <h1>The Safe</h1>
          <p className="muted">Store NFTs in the vault account. Withdrawals are destination-locked offers only you can accept.</p>
        </div>
        {kind === 'dev' && (
          <div className="row">
            <button className="ghost" disabled={!!busy} onClick={faucet}>Get test XRP</button>
            <button className="ghost" disabled={!!busy} onClick={mintTest}>Mint test NFT</button>
          </div>
        )}
      </div>

      {pending.length > 0 && (
        <Card title="Ready to claim">
          <div className="grid">
            {pending.map((c) => (
              <div className="tile" key={c.nft_id}>
                <NftImage nftId={c.nft_id} uri={c.uri} />
                <div className="tile-b">
                  <span className="mono small">{c.nft_id.slice(-10)}</span>
                  <button className="primary" disabled={busy === c.nft_id} onClick={() => claim(c)}>{busy === c.nft_id ? 'Claiming…' : 'Claim to wallet'}</button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title={`In the vault (${inSafe.filter((c) => c.owner === address).length})`} actions={<button className="ghost" onClick={reload}>Refresh</button>}>
        {inSafe.filter((c) => c.owner === address).length === 0 ? <Empty>Nothing stored yet. Deposit an NFT from your wallet below.</Empty> : (
          <div className="grid">
            {inSafe.filter((c) => c.owner === address).map((c) => (
              <div className="tile" key={c.nft_id}>
                <NftImage nftId={c.nft_id} uri={c.uri} />
                <div className="tile-b">
                  <div className="row between"><span className="mono small">{c.nft_id.slice(-10)}</span><Badge s={c.purpose === 'collateral' ? 'locked' : c.status} /></div>
                  {c.purpose === 'safe' && c.status === 'held' && (
                    <button disabled={busy === c.nft_id} onClick={() => withdraw(c)}>{busy === c.nft_id ? 'Withdrawing…' : 'Withdraw'}</button>
                  )}
                  {c.purpose === 'collateral' && <span className="muted small">Collateral for loan #{c.loan_id}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={`In your wallet (${wallet.data?.length ?? 0})`}>
        {wallet.loading && !wallet.data ? <Empty>Loading…</Empty> : (wallet.data ?? []).length === 0 ? <Empty>No NFTs in this wallet.</Empty> : (
          <div className="grid">
            {wallet.data!.map((n) => (
              <div className="tile" key={n.nftId}>
                <NftImage nftId={n.nftId} uri={n.uri} />
                <div className="tile-b">
                  <span className="mono small">{n.nftId.slice(-10)}</span>
                  {n.transferable ? (
                    <button className="primary" disabled={busy === n.nftId} onClick={() => deposit(n.nftId)}>{busy === n.nftId ? 'Depositing…' : 'Deposit to Safe'}</button>
                  ) : <span className="muted small">Not transferable</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </NeedWallet>
  )
}
