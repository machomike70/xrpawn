import { config } from './config.js'
import { run, now } from './db.js'
import { runLoanJobs } from './services/loans.js'
import { syncAllReleases } from './services/custody.js'
import { syncListings } from './services/market.js'
import { maybeRefreshFloors } from './services/appraisal.js'

let running = false

export async function runJobs() {
  if (running) return
  running = true
  try {
    await runLoanJobs()
    await syncAllReleases()
    await syncListings()
    await maybeRefreshFloors().catch((e) => console.error('price feed', e))
    run('DELETE FROM sessions WHERE expires_at < ?', now())
    run('DELETE FROM challenges WHERE created_at < ?', now() - 3600)
  } finally {
    running = false
  }
}

export function startJobs() {
  const tick = () => runJobs().catch((e) => console.error('jobs', e))
  setInterval(tick, config.jobIntervalMs)
  setTimeout(tick, 5_000)
}
