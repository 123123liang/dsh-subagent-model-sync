/**
 * Compatibility probe: run the production resolver against one real Session log.
 *
 * DSH appends one zstd frame per write, so a healthy log is *many* concatenated
 * frames — `zstdDecompressSync` only decodes the first. This probe splits on the
 * frame magic, replays the model-relevant events, and asks the real
 * `ownRoute` / `applyRoute` what a request from that Session would get.
 *
 * Run it before shipping a release: it proves the two Host surfaces the plugin
 * depends on (`sessionProjections.stateOf(session, 'modelSelection')` and
 * `session.requestHeader()`) still describe a real log the way the resolver
 * assumes. Unit tests use fakes; this one does not.
 *
 *   node tools/probe-resolver.mjs <path/to/session.v4.jsonl.zstd>
 */
import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node tools/probe-resolver.mjs <path/to/session.v4.jsonl.zstd>')
  process.exit(2)
}

const raw = await readFile(target)

/**
 * Split a concatenated zstd stream into its frames.
 * @param buffer - whole file.
 * @returns one buffer per frame.
 */
function splitFrames(buffer) {
  const offsets = []
  for (let index = buffer.indexOf(MAGIC, 0); index !== -1; index = buffer.indexOf(MAGIC, index + 4)) offsets.push(index)
  if (offsets.length === 0) throw new Error('not a zstd stream')
  return offsets.map((start, position) => buffer.subarray(start, offsets[position + 1] ?? buffer.length))
}

const text = raw.subarray(0, 4).equals(MAGIC)
  ? splitFrames(raw).map((frame) => {
    try {
      return zstdDecompressSync(frame).toString('utf8')
    } catch (error) {
      return `\u0000decode-error:${String(error)}\n`
    }
  }).join('')
  : raw.toString('utf8')

const lines = text.split('\n').filter((line) => line.trim() !== '')
const header = JSON.parse(lines[0])
const events = lines.slice(1).flatMap((line) => {
  try {
    return [JSON.parse(line)]
  } catch {
    return []
  }
})

console.log('session:', header.id)
console.log('origin :', header.origin ?? '(root)')
console.log('parent :', header.parentSession ?? '(none)')
console.log('events :', events.length)

const { ownRoute, applyRoute } = await import('../lib/resolver.js')

let pending = null
let lastHeader = null
for (const event of events) {
  if (event.type === 'model/selection') pending = event.data
  if (event.type === 'request/header') lastHeader = event.data?.header ?? lastHeader
}

const projections = { stateOf: (_session, key) => (key === 'modelSelection' ? { pending, lastUsed: lastHeader?.config ?? null } : undefined) }
const session = { header: { id: header.id, origin: header.origin }, requestHeader: () => lastHeader }

console.log('model/selection events:', pending === null ? 0 : 1)
console.log('request/header  last :', lastHeader?.config ?? '(none)')

const route = ownRoute(projections, session)
console.log('resolved own route   :', route ?? '(none)')
if (route !== undefined) {
  console.log('applyRoute over a foreign config:', applyRoute({ provider: 'x', model: 'y', reasoningEffort: 'max', maxTokens: 8192 }, route))
}
