import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from './config.js'
import { api } from './routes.js'
import { HttpError, LedgerError, getClient, treasuryWallet, vaultAddress } from './xrpl.js'
import { startJobs } from './jobs.js'

const app = express()
app.use(cors({ origin: config.corsOrigin.split(',') }))
app.use(express.json({ limit: '100kb' }))
app.use('/api', api)

// In production, serve the built web app from ../web/dist
const webDist = resolve(import.meta.dirname, '../../web/dist')
if (existsSync(webDist)) {
  app.use(express.static(webDist))
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(resolve(webDist, 'index.html')))
}

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
  if (err instanceof LedgerError) return res.status(400).json({ error: err.message, code: err.code })
  console.error(err)
  res.status(500).json({ error: err?.data?.error_message ?? err?.message ?? 'Internal error' })
})

await getClient()
console.log(`XRPawn API on http://localhost:${config.port}  network=${config.network}`)
console.log(`  vault    ${vaultAddress()}`)
console.log(`  treasury ${treasuryWallet().classicAddress}`)
app.listen(config.port)
startJobs()
