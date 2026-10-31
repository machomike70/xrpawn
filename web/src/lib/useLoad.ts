import { useCallback, useEffect, useState } from 'react'

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], enabled = true) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fn, deps)
  const reload = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    try { setData(await load()); setError(null) } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [load, enabled])
  useEffect(() => { reload() }, [reload])
  return { data, error, loading, reload }
}
