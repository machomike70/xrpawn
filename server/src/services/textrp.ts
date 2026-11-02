/**
 * TextRP delivery for notifications. TextRP is a Matrix chat network where every user ID is their XRPL wallet
 * (e.g. @rN7n3473SaZBCG4dFL83w7a1RXtXtbk2D9:synapse.textrp.io), so XRPawn can DM a borrower's wallet directly.
 *
 * Setup: create a bot account on TextRP, get its access token (starts with syt_), then in .env:
 *   TEXTRP_HOMESERVER=https://synapse.textrp.io
 *   TEXTRP_SERVER_NAME=synapse.textrp.io      (the part after ":" in user IDs)
 *   TEXTRP_ACCESS_TOKEN=syt_...
 * Users opt in from the notification bell ("Also send to TextRP"). Nobody is messaged without opting in.
 *
 * Uses the standard Matrix client-server API (no SDK): createRoom with is_direct + invite, then send m.room.message.
 */
import { randomUUID } from 'node:crypto'
import { all, now, one, run } from '../db.js'

const cfg = () => ({
  homeserver: (process.env.TEXTRP_HOMESERVER ?? 'https://synapse.textrp.io').replace(/\/$/, ''),
  serverName: process.env.TEXTRP_SERVER_NAME ?? 'synapse.textrp.io',
  token: process.env.TEXTRP_ACCESS_TOKEN ?? '',
  appUrl: process.env.PUBLIC_WEB_URL ?? '',
})

export const textrpEnabled = () => Boolean(cfg().token)
export const textrpUserId = (address: string) => `@${address}:${cfg().serverName}`

class MatrixError extends Error {
  constructor(public status: number, public errcode: string, message: string) { super(message) }
}

async function matrix(method: string, path: string, body?: unknown) {
  const c = cfg()
  const r = await fetch(`${c.homeserver}/_matrix/client/v3${path}`, {
    method,
    headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new MatrixError(r.status, j.errcode ?? 'M_UNKNOWN', j.error ?? `HTTP ${r.status}`)
  return j
}

/** Find or create the DM room between the XRPawn bot and this wallet. */
async function dmRoom(address: string): Promise<string> {
  const row = one<{ room_id: string }>('SELECT room_id FROM textrp_rooms WHERE address = ?', address)
  if (row) return row.room_id
  const r = await matrix('POST', '/createRoom', {
    is_direct: true,
    preset: 'trusted_private_chat',
    invite: [textrpUserId(address)],
    name: 'XRPawn alerts',
    topic: 'Loan reminders and alerts from XRPawn. Turn off under the bell icon in XRPawn.',
  })
  run('INSERT OR REPLACE INTO textrp_rooms (address, room_id, created_at) VALUES (?, ?, ?)', address, r.room_id, now())
  return r.room_id
}

export async function sendTextrp(address: string, title: string, body: string, link?: string | null) {
  const room = await dmRoom(address)
  const url = link && cfg().appUrl ? `${cfg().appUrl.replace(/\/$/, '')}${link}` : ''
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
  await matrix('PUT', `/rooms/${encodeURIComponent(room)}/send/m.room.message/${randomUUID()}`, {
    msgtype: 'm.text',
    body: `${title}\n${body}${url ? `\n${url}` : ''}`,
    format: 'org.matrix.custom.html',
    formatted_body: `<b>${esc(title)}</b><br>${esc(body)}${url ? `<br><a href="${esc(url)}">Open XRPawn</a>` : ''}`,
  })
}

// ---------------------------------------------------------------- preferences + delivery queue

export function getPrefs(address: string) {
  const r = one<{ textrp: number }>('SELECT textrp FROM user_prefs WHERE address = ?', address)
  return { textrp: Boolean(r?.textrp), textrpAvailable: textrpEnabled(), textrpUserId: textrpUserId(address) }
}

export function setPrefs(address: string, p: { textrp?: boolean }) {
  if (p.textrp !== undefined) {
    run(
      'INSERT INTO user_prefs (address, textrp, updated_at) VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET textrp = excluded.textrp, updated_at = excluded.updated_at',
      address, p.textrp ? 1 : 0, now(),
    )
  }
  return getPrefs(address)
}

/**
 * Deliver pending notifications to opted-in users over TextRP (only ones created after they opted in). Runs from the background job, so a TextRP outage
 * never blocks the app; each notification is tried for up to 6 hours.
 */
export async function deliverTextrp() {
  if (!textrpEnabled()) return
  const pending = all<{ id: number; address: string; title: string; body: string; link: string | null }>(
    `SELECT n.id, n.address, n.title, n.body, n.link FROM notifications n JOIN user_prefs p ON p.address = n.address
     WHERE p.textrp = 1 AND n.textrp_status IS NULL AND n.created_at > ? AND n.created_at >= p.updated_at
     ORDER BY n.id LIMIT 50`,
    now() - 6 * 3600,
  )
  for (const n of pending) {
    try {
      await sendTextrp(n.address, n.title, n.body, n.link)
      run("UPDATE notifications SET textrp_status = 'sent' WHERE id = ?", n.id)
    } catch (e: any) {
      // The wallet has no TextRP account (or blocked the bot): stop trying for this message.
      if (e instanceof MatrixError && (e.status === 403 || e.status === 404 || e.errcode === 'M_NOT_FOUND')) {
        run("UPDATE notifications SET textrp_status = 'undeliverable' WHERE id = ?", n.id)
        run('DELETE FROM textrp_rooms WHERE address = ?', n.address)
      } else {
        console.error('textrp send failed, will retry', n.id, e?.message)
      }
    }
  }
}
