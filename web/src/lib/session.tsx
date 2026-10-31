import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, getToken, setToken, type AppConfig } from './api'
import { registerXamanUi, signAndSubmit, signIn, type Tx, type WalletKind, type XamanPrompt } from './wallet'

interface Session {
  config: AppConfig | null
  address: string | null
  kind: WalletKind | null
  isAdmin: boolean
  connect: (k: WalletKind) => Promise<void>
  disconnect: () => Promise<void>
  submit: (tx: Tx, title?: string) => Promise<string>
  refreshConfig: () => Promise<void>
  xaman: XamanPrompt | null
  cancelXaman: () => void
  toast: (msg: string, kind?: 'ok' | 'err') => void
  toasts: { id: number; msg: string; kind: 'ok' | 'err' }[]
}

const Ctx = createContext<Session | null>(null)
export const useSession = () => useContext(Ctx)!

const KIND_KEY = 'xrpawn.kind'

export function SessionProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [kind, setKind] = useState<WalletKind | null>(() => {
    try { return (localStorage.getItem(KIND_KEY) as WalletKind) || null } catch { return null }
  })
  const [xaman, setXaman] = useState<XamanPrompt | null>(null)
  const cancelled = useRef(false)
  const [toasts, setToasts] = useState<Session['toasts']>([])

  const toast = useCallback((msg: string, k: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, msg, kind: k }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000)
  }, [])

  const refreshConfig = useCallback(async () => {
    const c = await api<AppConfig>('/config')
    setConfig(c)
    if (!c.me && getToken()) setToken(null)
  }, [])

  useEffect(() => {
    refreshConfig().catch((e) => toast(`API unreachable: ${e.message}`, 'err'))
    registerXamanUi({
      open: (p) => { cancelled.current = false; setXaman(p) },
      close: () => setXaman(null),
      cancelled: () => cancelled.current,
    })
  }, [refreshConfig, toast])

  const connect = async (k: WalletKind) => {
    await signIn(k)
    setKind(k)
    try { localStorage.setItem(KIND_KEY, k) } catch { /* ignore */ }
    await refreshConfig()
  }

  const disconnect = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {})
    setToken(null)
    setKind(null)
    try { localStorage.removeItem(KIND_KEY) } catch { /* ignore */ }
    await refreshConfig()
  }

  const address = config?.me ?? null

  const submit = async (tx: Tx, title?: string) => {
    if (!address || !kind) throw new Error('Connect a wallet first')
    return signAndSubmit(kind, address, tx, title)
  }

  return (
    <Ctx.Provider value={{
      config, address, kind: address ? kind : null, isAdmin: !!config?.isAdmin, connect, disconnect, submit, refreshConfig,
      xaman, cancelXaman: () => { cancelled.current = true; setXaman(null) }, toast, toasts,
    }}>
      {children}
    </Ctx.Provider>
  )
}

/** Run an async UI action with busy state + toast on error. */
export function useAction() {
  const { toast } = useSession()
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (label: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(label)
    try {
      await fn()
      if (success) toast(success)
    } catch (e: any) {
      toast(e?.message ?? String(e), 'err')
    } finally {
      setBusy(null)
    }
  }
  return { busy, run }
}
