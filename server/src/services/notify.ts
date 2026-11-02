/**
 * Notifications: an in-app inbox for every user, plus Xaman push for users who signed in with Xaman.
 *
 * Xaman can push *sign requests* to a user's phone once they have signed anything for this app (Xaman then
 * issues a "user token"). We use that for repayment reminders: the push opens a ready-to-sign repayment,
 * so repaying is one tap. Everything else goes to the in-app inbox (bell icon).
 */
import { all, now, one, run } from '../db.js'
import { xamanEnabled, pushTxToUser } from './xaman.js'

export type NotificationKind =
  | 'offer_received' | 'offer_accepted' | 'loan_funded' | 'funding_expired'
  | 'due_soon' | 'overdue' | 'repaid' | 'payout' | 'defaulted' | 'collateral_claimed'
  | 'nft_sold' | 'nft_ready' | 'refund'

export interface NotificationRow {
  id: number
  address: string
  kind: NotificationKind
  title: string
  body: string
  link: string | null
  loan_id: number | null
  created_at: number
  read_at: number | null
}

export function notify(address: string | null | undefined, kind: NotificationKind, title: string, body: string, opts: { link?: string; loanId?: number } = {}) {
  if (!address) return
  run(
    'INSERT INTO notifications (address, kind, title, body, link, loan_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    address, kind, title, body, opts.link ?? null, opts.loanId ?? null, now(),
  )
}

export function listNotifications(address: string) {
  const items = all<NotificationRow>('SELECT * FROM notifications WHERE address = ? ORDER BY id DESC LIMIT 50', address)
  const unread = one<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE address = ? AND read_at IS NULL', address)!.n
  return { items, unread }
}

export function markRead(address: string, ids?: number[]) {
  if (ids?.length) {
    for (const id of ids) run('UPDATE notifications SET read_at = ? WHERE id = ? AND address = ? AND read_at IS NULL', now(), id, address)
  } else {
    run('UPDATE notifications SET read_at = ? WHERE address = ? AND read_at IS NULL', now(), address)
  }
}

/** Run `fn` once per (loan, stage); returns false if it already ran. */
export function once(loanId: number, stage: string): boolean {
  try {
    run('INSERT INTO reminders_sent (loan_id, stage, created_at) VALUES (?, ?, ?)', loanId, stage, now())
    return true
  } catch {
    return false
  }
}

/** Push a ready-to-sign repayment to the borrower's Xaman app, if we have a Xaman user token for them. */
export async function pushRepayment(borrower: string, tx: Record<string, unknown>, instruction: string) {
  if (!xamanEnabled()) return false
  const row = one<{ user_token: string }>('SELECT user_token FROM xaman_users WHERE address = ?', borrower)
  if (!row) return false
  return pushTxToUser(row.user_token, tx, instruction).then(() => true, (e) => { console.error('xaman push', e?.message); return false })
}
