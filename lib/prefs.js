/**
 * Durable preference store for `dsh-subagent-model-sync`.
 *
 * Two independent maps, both keyed by durable Session identity:
 *
 * - `sync[leadSessionId]`: the per-Session "sync subagents" switch. While it is
 *   on, every descendant Agent runs on this Session's route and per-child picks
 *   are dormant (see `resolver.js`). Turning it off restores those picks.
 * - `manual[childSessionId]`: an explicit user pick for one child Agent. It is
 *   a *dormant* preference, not permanent configuration: the switch suspends it
 *   without deleting it.
 *
 * Nothing here is ever destroyed by a mode change. A preference is written when
 * the user picks, and removed only when the user clears it or the Session is
 * gone — turning the switch on and back off therefore leaves no trace.
 *
 * Writes are debounced and atomic (temp file + rename) so a crash cannot leave a
 * half-written document. The store never throws into a model request: a failed
 * load degrades to empty preferences, which is exactly the unmodified Host
 * behaviour.
 *
 * @module dsh-subagent-model-sync/prefs
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Bumped when the document shape changes incompatibly. */
const VERSION = 1
/** Coalesce bursts of toggles; the UI saves one field at a time. */
const WRITE_DELAY_MS = 120

/**
 * Resolve the Harness home without importing a peer package: `DSH_HOME` wins,
 * otherwise the documented default `~/.dsh`.
 * @returns absolute home directory.
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/** @returns whether `value` is a usable exact route. */
function isRoute(value) {
  return typeof value === 'object' && value !== null
    && typeof value.provider === 'string' && value.provider !== ''
    && typeof value.model === 'string' && value.model !== ''
    && (value.reasoningEffort === undefined || (typeof value.reasoningEffort === 'string' && value.reasoningEffort !== ''))
}

/** Copy one route into a detached, JSON-safe value with a stable key order. */
function cloneRoute(route) {
  return {
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
    // Kept last and optional: it exists only so the UI can tell whose pick a
    // dormant entry is, and so a future cleanup can be scoped. Older files
    // without it stay valid and are treated as unowned.
    ...typeof route.parent === 'string' && route.parent !== '' ? { parent: route.parent } : {},
  }
}

/** Preference owner shared by the request hook and the HTTP bridge. */
export class PrefsStore {
  /** @type {Map<string, boolean>} leadSessionId -> sync enabled */
  #sync = new Map()
  /** @type {Map<string, {provider: string, model: string, reasoningEffort?: string}>} */
  #manual = new Map()
  /** @type {NodeJS.Timeout | undefined} */
  #timer
  #writing = Promise.resolve()
  #loaded = false

  /**
   * @param options - optional home/logger overrides used by tests.
   */
  constructor(options = {}) {
    this.path = options.path ?? join(dshHome(), 'storages', 'subagent-model-sync.json')
    this.logger = options.logger
  }

  /**
   * Read the document once. A missing or corrupt file is not an error: the
   * store simply stays empty, which disables every rewrite.
   * @returns resolution after the first load attempt.
   */
  async load() {
    if (this.#loaded) return
    this.#loaded = true
    let text
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#warn(`preferences could not be read: ${String(error)}`)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.#warn(`preferences are not valid JSON and were ignored: ${String(error)}`)
      return
    }
    if (parsed?.version !== VERSION) return
    if (parsed.sync !== null && typeof parsed.sync === 'object') {
      for (const [id, enabled] of Object.entries(parsed.sync)) if (enabled === true) this.#sync.set(id, true)
    }
    if (parsed.manual !== null && typeof parsed.manual === 'object') {
      for (const [id, route] of Object.entries(parsed.manual)) if (isRoute(route)) this.#manual.set(id, cloneRoute(route))
    }
  }

  /** @param sessionId - lead Session whose switch is read. @returns whether sync is on. */
  syncOf(sessionId) {
    return this.#sync.get(sessionId) === true
  }

  /** @param childId - child Session. @returns the explicit route, if any. */
  manualOf(childId) {
    return this.#manual.get(childId)
  }

  /**
   * Count the picks that a switch on `parentId` would suspend.
   *
   * The UI states the number before the user commits to a mode change, so the
   * count must be exact rather than "there is at least one". Entries written
   * before `parent` existed are unowned and therefore not counted: guessing
   * would be worse than under-reporting.
   *
   * @param parentId - lead Session whose dormant picks are counted.
   * @returns how many children carry an explicit pick.
   */
  pinnedCount(parentId) {
    let count = 0
    for (const route of this.#manual.values()) if (route.parent === parentId) count += 1
    return count
  }

  /**
   * @param sessionId - lead Session to toggle.
   * @param enabled - desired state.
   * @returns resolution after the debounced save is scheduled.
   */
  setSync(sessionId, enabled) {
    if (enabled) this.#sync.set(sessionId, true)
    else this.#sync.delete(sessionId)
    this.#schedule()
  }

  /**
   * @param childId - child Session to override.
   * @param route - explicit route, or `undefined` to clear it.
   * @returns resolution after the debounced save is scheduled.
   */
  setManual(childId, route) {
    if (route === undefined) this.#manual.delete(childId)
    else this.#manual.set(childId, cloneRoute(route))
    this.#schedule()
  }

  /** @returns a detached snapshot for the HTTP bridge. */
  snapshot() {
    return {
      sync: Object.fromEntries(this.#sync),
      manual: Object.fromEntries([...this.#manual].map(([id, route]) => [id, cloneRoute(route)])),
    }
  }

  /**
   * Read the document and describe it for the browser half in one shot.
   *
   * `pinnedCount` is per requesting Session, because the switch lives on the
   * Session and its warning must talk about *its own* children only.
   *
   * @param sessionId - Session the caller is displaying, if any.
   * @returns snapshot plus the count that applies to `sessionId`.
   */
  view(sessionId) {
    return {
      ...this.snapshot(),
      ...typeof sessionId === 'string' && sessionId !== ''
        ? { pinnedCount: this.pinnedCount(sessionId) }
        : {},
    }
  }

  /**
   * Drop preferences for Sessions that no longer exist. Called opportunistically
   * from the bridge so a deleted Session never keeps a stale override alive.
   * @param known - predicate over a durable Session id.
   */
  prune(known) {
    let changed = false
    for (const id of [...this.#sync.keys()]) if (!known(id)) { this.#sync.delete(id); changed = true }
    for (const id of [...this.#manual.keys()]) if (!known(id)) { this.#manual.delete(id); changed = true }
    if (changed) this.#schedule()
  }

  /**
   * Flush any pending write and wait for it. Used by tests and by plugin
   * disposal; the debounced timer normally owns the write.
   * @returns resolution once the document is on disk.
   */
  async flushNow() {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#writing = this.#writing.then(() => this.#flush())
    await this.#writing
  }

  #schedule() {
    if (this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#writing = this.#writing.then(() => this.#flush()).catch((error) => {
        this.#warn(`preferences could not be saved: ${String(error)}`)
      })
    }, WRITE_DELAY_MS)
    this.#timer.unref?.()
  }

  async #flush() {
    const document = JSON.stringify({ version: VERSION, ...this.snapshot() }, null, 2)
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp`
    await writeFile(temp, document, 'utf8')
    await rename(temp, this.path)
  }

  #warn(message) {
    this.logger?.warn(`subagent-model-sync: ${message}`)
  }
}
