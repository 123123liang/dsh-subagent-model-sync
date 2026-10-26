/**
 * Print the真实路由历史 of one Session, straight from its durable log.
 *
 * This is the only trustworthy answer to "did the model switch actually take
 * effect": the UI label can lag or describe an intent, but every model request
 * appends a `request/header` carrying the provider/model that really went out.
 *
 * Usage:
 *   node tools/route-report.mjs <sessionId> [--expect provider/model]
 *
 * Exit code is 0 when the last recorded route matches `--expect`, 1 otherwise,
 * so the same script doubles as an assertion in a scripted test.
 *
 * @module dsh-subagent-model-sync/tools/route-report
 */
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

/** Session logs are concatenated zstd frames, not one stream. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode every zstd frame in a concatenated log.
 *
 * `zstdDecompressSync` stops after the first frame, which yields only the
 * 200-byte session meta line and silently hides every event after it.
 *
 * @param buffer - whole file contents.
 * @returns the decoded UTF-8 text.
 */
function decodeFrames(buffer) {
  const offsets = []
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1] && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) {
      offsets.push(i)
    }
  }
  const parts = []
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      // A magic sequence inside compressed payload is not a frame boundary.
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Locate the log of one Session across every workspace bucket.
 * @param sessionId - Session id.
 * @returns absolute log path.
 */
function findLog(sessionId) {
  const root = join(homedir(), '.dsh', 'sessions')
  for (const workspace of readdirSync(root)) {
    const dir = join(root, workspace, sessionId)
    const file = join(dir, 'session.v4.jsonl.zstd')
    try {
      if (statSync(file).isFile()) return file
    } catch {
      continue
    }
  }
  throw new Error(`no session log for "${sessionId}" under ${root}`)
}

/** @returns the parsed event stream. */
function readEvents(path) {
  const events = []
  for (const line of decodeFrames(readFileSync(path)).split('\n')) {
    if (line === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Trailing partial line while a live session is being appended.
    }
  }
  return events
}

/**
 * Describe one route as `provider/model`.
 * @param route - `{provider, model, reasoningEffort?}` or nullish.
 * @returns compact label.
 */
function routeLabel(route) {
  if (route === undefined || route === null) return '(none)'
  return `${route.provider}/${route.model}`
}

const sessionId = process.argv[2]
if (sessionId === undefined) {
  console.error('usage: node tools/route-report.mjs <sessionId> [--expect provider/model]')
  process.exit(2)
}
const expectFlag = process.argv.indexOf('--expect')
const expect = expectFlag >= 0 ? process.argv[expectFlag + 1] : undefined

const logPath = findLog(sessionId)
const events = readEvents(logPath)

const meta = events.find((event) => event.type === 'session')
console.log(`session   ${meta?.id ?? sessionId}`)
console.log(`origin    ${meta?.origin ?? 'root'}   parent ${meta?.parentSession ?? '-'}   depth ${meta?.delegationDepth ?? 0}`)
console.log(`log       ${logPath}`)

/* Every model request appends one header; the sequence is the real route history. */
const headers = events.filter((event) => event.type === 'request/header')
console.log(`\nrequest/header (${headers.length}):`)
let previous
for (const event of headers) {
  const config = event.data?.header?.config ?? {}
  const label = routeLabel(config)
  const changed = previous !== undefined && previous !== label ? '  <== CHANGED' : ''
  const effort = config.reasoningEffort === undefined ? '' : `  effort=${config.reasoningEffort}`
  console.log(`  seq ${String(event.seq).padStart(6)}  ${String(event.data?.reason ?? '-').padEnd(8)} ${label}${effort}${changed}`)
  previous = label
}

/* A fabricated switch notice would show up here; the plugin must never append one. */
const selections = events.filter((event) => event.type === 'model/selection')
console.log(`\nmodel/selection events: ${selections.length}`)
for (const event of selections) console.log(`  seq ${event.seq}  ${routeLabel(event.data)}`)

const last = headers.at(-1)
const lastRoute = routeLabel(last?.data?.header?.config)
console.log(`\nlast route: ${lastRoute}`)
if (expect !== undefined) {
  if (lastRoute === expect) {
    console.log(`RESULT: PASS (expected ${expect})`)
    process.exit(0)
  }
  console.log(`RESULT: FAIL (expected ${expect})`)
  process.exit(1)
}
