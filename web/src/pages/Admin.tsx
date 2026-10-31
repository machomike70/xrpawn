import { useState } from 'react'
import { api } from '../lib/api'
import { pct, toDrops, xrp } from '../lib/format'
import { useAction, useSession } from '../lib/session'
import { useLoad } from '../lib/useLoad'
import { Addr, Card, Empty, NftImage } from '../components/ui'

export default function Admin() {
  const { isAdmin } = useSession()
  const overview = useLoad(() => api('/admin/overview'), [], isAdmin)
  const collections = useLoad(() => api<any[]>('/collections'), [])
  const { busy, run } = useAction()
  const [c, setC] = useState({ issuer: '', taxon: '-1', name: '', floor: '', ltv: '40' })
  const [asks, setAsks] = useState<Record<string, string>>({})

  if (!isAdmin) return <Empty>Admin only. Add your address to ADMIN_ADDRESSES in server/.env.</Empty>

  const save = () => run('save', async () => {
    await api('/admin/collections', { body: { issuer: c.issuer.trim(), taxon: Number(c.taxon), name: c.name, floorDrops: toDrops(c.floor), ltvBps: Math.round(Number(c.ltv) * 100) } })
    collections.reload()
  }, 'Collection saved')
  const del = (issuer: string, taxon: number) => run('del', async () => { await api(`/admin/collections/${issuer}/${taxon}`, { method: 'DELETE' }); collections.reload() })
  const listShop = (nftId: string) => run(nftId, async () => {
    await api(`/admin/inventory/${nftId}/list`, { body: { askDrops: toDrops(asks[nftId] ?? '') } })
    overview.reload()
  }, 'Listed in the pawn shop')
  const jobs = () => run('jobs', async () => { await api('/admin/jobs/run', { method: 'POST' }); overview.reload() }, 'Jobs ran')

  const o = overview.data
  return (
    <>
      <div className="page-h">
        <div><h1>Back office</h1><p className="muted">Treasury, appraisals, defaults and shop inventory.</p></div>
        <button className="ghost" disabled={!!busy} onClick={jobs}>Run default/settlement jobs</button>
      </div>
      {o && (
        <div className="stats">
          <div><small>Treasury liquidity</small><b>{xrp(o.treasurySpendableDrops)}</b><Addr a={o.treasury} /></div>
          <div><small>Vault</small><b>{o.custodyCount.reduce((s: number, r: any) => s + r.n, 0)} NFTs</b><Addr a={o.vault} /></div>
          {o.loans.filter((r: any) => r.status === 'active').map((r: any) => (
            <div key={r.kind}><small>Active {r.kind} loans</small><b>{r.n}</b><span className="muted small">{xrp(r.principal)} out</span></div>
          ))}
        </div>
      )}
      <Card title="Approved collections (appraisal table)">
        <table className="offers">
          <thead><tr><th>Name</th><th>Issuer</th><th>Taxon</th><th>Floor</th><th>LTV</th><th /></tr></thead>
          <tbody>
            {(collections.data ?? []).map((r) => (
              <tr key={`${r.issuer}${r.taxon}`}>
                <td>{r.name}</td><td><Addr a={r.issuer} /></td><td>{r.taxon === -1 ? 'any' : r.taxon}</td><td>{xrp(r.floor_drops)}</td><td>{pct(r.ltv_bps)}</td>
                <td><button className="ghost sm" onClick={() => del(r.issuer, r.taxon)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row wrap">
          <label>Name<input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></label>
          <label>Issuer r-address<input value={c.issuer} onChange={(e) => setC({ ...c, issuer: e.target.value })} /></label>
          <label>Taxon (-1 any)<input value={c.taxon} onChange={(e) => setC({ ...c, taxon: e.target.value })} /></label>
          <label>Floor XRP<input value={c.floor} onChange={(e) => setC({ ...c, floor: e.target.value })} /></label>
          <label>LTV %<input value={c.ltv} onChange={(e) => setC({ ...c, ltv: e.target.value })} /></label>
          <button className="primary" disabled={!!busy} onClick={save}>Save</button>
        </div>
      </Card>
      <Card title="Forfeited inventory">
        {!o || o.inventory.length === 0 ? <Empty>No forfeited NFTs.</Empty> : (
          <div className="grid">
            {o.inventory.map((n: any) => (
              <div className="tile" key={n.nft_id}>
                <NftImage nftId={n.nft_id} uri={n.uri} />
                <div className="tile-b">
                  <label>Ask (XRP)<input value={asks[n.nft_id] ?? ''} onChange={(e) => setAsks({ ...asks, [n.nft_id]: e.target.value })} /></label>
                  <button className="primary" disabled={!!busy} onClick={() => listShop(n.nft_id)}>List in shop</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
