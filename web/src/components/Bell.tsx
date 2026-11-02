import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useSession } from '../lib/session'

interface Note { id: number; kind: string; title: string; body: string; link: string | null; created_at: number; read_at: number | null }

const ago = (t: number) => {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - t))
  if (s < 3600) return `${Math.ceil(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default function Bell() {
  const { address } = useSession()
  const nav = useNavigate()
  const [data, setData] = useState<{ items: Note[]; unread: number }>({ items: [], unread: 0 })
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    if (address) api('/notifications').then(setData).catch(() => {})
  }, [address])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  if (!address) return null

  const click = async (n: Note) => {
    setOpen(false)
    if (!n.read_at) setData(await api('/notifications/read', { body: { ids: [n.id] } }))
    if (n.link) nav(n.link)
  }

  return (
    <div className="bell" ref={ref}>
      <button className="ghost icon" aria-label={`Notifications (${data.unread} unread)`} onClick={() => setOpen(!open)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {data.unread > 0 && <span className="count">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="menu notes">
          <div className="row between notes-h">
            <strong>Notifications</strong>
            {data.unread > 0 && <button className="ghost sm" onClick={async () => setData(await api('/notifications/read', { body: {} }))}>Mark all read</button>}
          </div>
          {data.items.length === 0 ? <p className="muted small pad">Nothing yet.</p> : data.items.map((n) => (
            <button key={n.id} className={`note ${n.read_at ? '' : 'unread'}`} onClick={() => click(n)}>
              <span className="note-t">{n.title}</span>
              <span className="note-b">{n.body}</span>
              <small>{ago(n.created_at)}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
