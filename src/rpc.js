// The wire between the two ends: one signed JSON POST per request, answered with a signed reply.
//
// Each end has an Ed25519 key pair and is configured with the other end's public key. A request
// is signed for one recipient and one moment, so it cannot be passed on to another DSH or sent
// again. The reply is signed over the request's signature, so nobody else can answer and an
// answer cannot be moved to another request. Signatures prove who is talking; keeping the
// content private is HTTPS's job.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'

export const ROUTE = '/remote-dsh-bridge/rpc'
const CLOCK_SLACK_MS = 5 * 60_000
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** The remote DSH understood the request and said no. Asking again will not help. */
export class Refused extends Error {}

/** This DSH's key pair, created on first use. `publicKey` is the text the other end is configured with. */
export async function loadKeys(dir) {
  const file = join(dir, 'key.pem')
  let pem = await readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error })
  if (!pem) {
    pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
    await mkdir(dir, { recursive: true })
    await writeFile(file, pem, { mode: 0o600 })
  }
  const privateKey = createPrivateKey(pem)
  const publicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x
  await writeFile(join(dir, 'key.pub'), publicKey + '\n')
  return { privateKey, publicKey }
}

export function keyOf(publicKey) {
  try { return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }) }
  catch { throw new Error(`"${publicKey}" is not a public key as written in a DSH's key.pub`) }
}

const bytes = parts => Buffer.from(JSON.stringify(parts))
const signatureOf = (keys, ...parts) => sign(null, bytes(parts), keys.privateKey).toString('base64')
const isSignedBy = (publicKey, signature, ...parts) => verify(null, bytes(parts), keyOf(publicKey), Buffer.from(signature ?? '', 'base64'))

export async function call(keys, remote, method, args, signal) {
  // The id makes every request distinct, so an honest repeat is not taken for a replay.
  const body = JSON.stringify({ id: randomUUID(), method, args })
  const time = String(Date.now())
  const signature = signatureOf(keys, 'request', remote.publicKey, time, body)
  const response = await fetch(remote.url.replace(/\/$/, '') + ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-from': keys.publicKey, 'x-bridge-time': time, 'x-bridge-signature': signature },
    body,
    signal,
  })
  const answer = await response.text()
  if (response.status === 401) throw new Error(`The remote DSH refused the request: ${answer.slice(0, 200)}`)
  // Anything unsigned is not from the remote bridge: another server at that URL, or something in between.
  if (!isSignedBy(remote.publicKey, response.headers.get('x-bridge-signature'), 'reply', signature, answer)) throw new Error(`${remote.url} did not answer with the remote DSH's key (HTTP ${response.status})`)
  const reply = JSON.parse(answer)
  if (!reply.ok) throw new Refused(reply.error)
  return reply.value
}

export function serve(receiver, keys, peers) {
  const seen = new Map()   // signature of each request received → when it can no longer arrive in time; oldest first
  return async (request, response) => {
    const refuse = why => response.writeHead(401, { 'content-type': 'text/plain' }).end(why)
    const { 'x-bridge-from': from, 'x-bridge-time': time, 'x-bridge-signature': signature } = request.headers
    const peer = peers.find(peer => peer.publicKey === from)
    if (!peer) return refuse('this key is not accepted here')
    const now = Date.now()
    if (!(Math.abs(now - time) <= CLOCK_SLACK_MS)) return refuse('the clocks of the two DSH differ by more than five minutes')
    // The body has to be read before its signature can be checked, so its size is bounded first.
    if (!(request.headers['content-length'] <= MAX_BODY_BYTES)) return response.writeHead(413).end()
    const body = await text(request)
    if (!isSignedBy(from, signature, 'request', keys.publicKey, time, body)) return refuse('the request is not signed by that key for this DSH')
    for (const [old, until] of seen) {
      if (until > now) break
      seen.delete(old)
    }
    if (seen.has(signature)) return refuse('this request was already received')
    seen.set(signature, now + 2 * CLOCK_SLACK_MS)

    // A caller that hangs up no longer wants the result: stop the work it asked for.
    const gone = new AbortController()
    response.on('close', () => response.writableEnded || gone.abort())
    let reply
    try {
      const { method, args } = JSON.parse(body)
      reply = { ok: true, value: await receiver.handle(method, args, peer, gone.signal) }
    } catch (error) {
      reply = { ok: false, error: error.message }
    }
    const answer = JSON.stringify(reply)
    response.writeHead(200, { 'content-type': 'application/json', 'x-bridge-signature': signatureOf(keys, 'reply', signature, answer) }).end(answer)
  }
}
