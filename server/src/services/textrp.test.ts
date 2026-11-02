import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

// Mock TextRP (Matrix) homeserver recording what the bot does
const calls: { method: string; url: string; auth?: string; body: any }[] = []
const NO_ACCOUNT = 'rNOACCOUNT'
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined
    calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body })
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== 'Bearer syt_test') { res.statusCode = 401; return res.end(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN', error: 'bad token' })) }
    if (req.url === '/_matrix/client/v3/createRoom') {
      if (body.invite[0].startsWith(`@${NO_ACCOUNT}:`)) { res.statusCode = 404; return res.end(JSON.stringify({ errcode: 'M_NOT_FOUND', error: 'Unknown user' })) }
      return res.end(JSON.stringify({ room_id: `!room-${body.invite[0].slice(1, 8)}:textrp.test` }))
    }
    if (req.url?.includes('/send/m.room.message/')) return res.end(JSON.stringify({ event_id: '$e' + calls.length }))
    res.statusCode = 404; res.end(JSON.stringify({ errcode: 'M_UNRECOGNIZED' }))
  })
})
await new Promise<void>((r) => server.listen(0, r))
after(() => server.close())

Object.assign(process.env, {
  DB_PATH: ':memory:',
  TEXTRP_HOMESERVER: `http://127.0.0.1:${(server.address() as any).port}`,
  TEXTRP_SERVER_NAME: 'textrp.test',
  TEXTRP_ACCESS_TOKEN: 'syt_test',
  PUBLIC_WEB_URL: 'https://xrpawn.example',
})
const { notify } = await import('./notify.js')
const textrp = await import('./textrp.js')

const ALICE = 'rALICEaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const BOB = 'rBOBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

test('user IDs are the wallet address on the TextRP server', () => {
  assert.equal(textrp.textrpUserId(ALICE), `@${ALICE}:textrp.test`)
})

test('only opted-in users are messaged; DM room is created once and reused', async () => {
  textrp.setPrefs(ALICE, { textrp: true })
  notify(ALICE, 'due_soon', 'Loan #1 is due within 24 hours', 'Repay 10 XRP to keep your NFT.', { link: '/borrow', loanId: 1 })
  notify(BOB, 'due_soon', 'Loan #2 is due', 'Bob did not opt in', { loanId: 2 })
  await textrp.deliverTextrp()
  notify(ALICE, 'repaid', 'Loan #1 repaid', 'Claim your NFT.', { link: '/safe' })
  await textrp.deliverTextrp()
  await textrp.deliverTextrp() // nothing left to send

  const creates = calls.filter((c) => c.url.endsWith('/createRoom'))
  assert.equal(creates.length, 1, 'one DM room')
  assert.deepEqual(creates[0].body.invite, [`@${ALICE}:textrp.test`])
  assert.equal(creates[0].body.is_direct, true)
  const sends = calls.filter((c) => c.url.includes('/send/m.room.message/'))
  assert.equal(sends.length, 2, 'two messages, none to Bob')
  assert.match(sends[0].body.body, /Loan #1 is due within 24 hours\nRepay 10 XRP.*\nhttps:\/\/xrpawn\.example\/borrow/)
  assert.match(sends[0].body.formatted_body, /<b>Loan #1 is due within 24 hours<\/b>/)
  assert.ok(sends.every((s) => s.auth === 'Bearer syt_test'))
  assert.notEqual(sends[0].url, sends[1].url, 'unique transaction ids')
})

test('wallets without a TextRP account are marked undeliverable instead of retried forever', async () => {
  textrp.setPrefs(NO_ACCOUNT, { textrp: true })
  notify(NO_ACCOUNT, 'due_soon', 'x', 'y')
  await textrp.deliverTextrp()
  const before = calls.length
  await textrp.deliverTextrp()
  assert.equal(calls.length, before, 'no retry')
})

test('html in messages is escaped', async () => {
  notify(ALICE, 'refund', '<script>x</script>', 'a & b')
  await textrp.deliverTextrp()
  const last = calls.filter((c) => c.url.includes('/send/')).at(-1)!
  assert.match(last.body.formatted_body, /&lt;script&gt;x&lt;\/script&gt;.*a &amp; b/)
})

test('opting in does not replay alerts from before the opt-in', async () => {
  const CAROL = 'rCAROLccccccccccccccccccccccccccc'
  notify(CAROL, 'offer_received', 'old alert', 'before opt-in')
  await new Promise((r) => setTimeout(r, 1100)) // timestamps are in seconds
  textrp.setPrefs(CAROL, { textrp: true })
  notify(CAROL, 'due_soon', 'new alert', 'after opt-in')
  const before = calls.length
  await textrp.deliverTextrp()
  const sent = calls.slice(before).filter((c) => c.url.includes('/send/')).map((c) => c.body.body)
  assert.deepEqual(sent.map((b) => b.split('\n')[0]), ['new alert'])
})

test('opting out stops delivery', async () => {
  textrp.setPrefs(ALICE, { textrp: false })
  const before = calls.length
  notify(ALICE, 'due_soon', 'z', 'z')
  await textrp.deliverTextrp()
  assert.equal(calls.length, before)
})
