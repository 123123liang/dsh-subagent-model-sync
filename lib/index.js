/**
 * `dsh-subagent-model-sync` — Host half.
 *
 * Rewrites the route of delegated model requests so a subagent, an agent-team
 * teammate, or any nested child can run on a model the user chose, instead of
 * the route frozen into its creation descriptor.
 *
 * Design notes that the implementation must preserve:
 *
 * - **One hook, outermost.** `agent/request` is registered with `prepend`, so it
 *   runs before every other contributor. It awaits `next()` first and rewrites
 *   the finished configuration, which is what makes a user choice outrank the
 *   official selection chain, the delegating model's explicit `agentOptions`,
 *   and any third-party follower plugin.
 * - **Nothing is pushed.** The decision is recomputed per request, so turning
 *   the switch on or changing the parent's model needs no traversal of the
 *   child tree, and a child that is asleep or resumed later still follows.
 * - **Picks are retired on effect, not on toggle.** Ticking the switch writes a
 *   boolean and nothing else; only a request the switch actually re-points
 *   drops that child's explicit pick. Toggling on and off with no traffic is
 *   therefore a no-op, and a child never resurrects an old pick afterwards.
 * - **Never writes Session history.** No `model/selection` event is fabricated;
 *   the resulting route is recorded by the official `request/header`, so the
 *   log stays truthful and uninstalling the plugin changes nothing.
 * - **Inert by default.** With no preferences stored the resolver returns
 *   `undefined` for every Agent and the request passes through untouched.
 *
 * @module dsh-subagent-model-sync
 */
import { PrefsStore } from './prefs.js'
import { applyRoute, resolveRouteWithSource, shouldRetirePin } from './resolver.js'

/** Plugin identity used by the Loader and by diagnostics. */
export const name = 'subagent-model-sync'

/** Services the Host half needs before it can install its hook. */
export const inject = ['agents', 'sessionProjections']

/**
 * Configurable surface.
 *
 * The Loader validates config through a schema's standard-schema interface, so
 * exporting a plain object throws (`Cannot read properties of undefined
 * (reading 'validate')`). This plugin takes no options, so the schema is written
 * inline rather than importing schemastery: a hand-written `~standard`
 * validator keeps the package dependency-free, which matters because a linked
 * profile resolves this file by its real path and cannot see the profile's
 * `node_modules`.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-subagent-model-sync',
    /**
     * Accept an omitted or empty config; reject unknown keys so a typo in
     * `cordis.patch.yml` fails loudly instead of being ignored.
     * @param value - raw config from the Loader.
     * @returns validated config, or issues.
     */
    validate(value) {
      if (value === undefined || value === null) return { value: {} }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'config must be an object' }] }
      }
      const unknown = Object.keys(value).filter((key) => key !== '')
      if (unknown.length > 0) return { issues: [{ message: `unknown config key: ${unknown[0]}` }] }
      return { value: {} }
    },
  },
}

/** Bridge prefix; the browser half mirrors this constant. */
const BRIDGE_PREFIX = '/api/subagent-model-sync'
/** How often a stale preference is swept. Hourly: cheap and soon enough. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

/**
 * Install the request hook and the Web bridge.
 *
 * @param ctx - Host plugin context.
 * @returns resolution once the hook is installed and preferences are loaded.
 */
export function apply(ctx) {
  const prefs = new PrefsStore({ logger: ctx.logger })
  const ready = prefs.load()

  // `prepend` is load-bearing: the outermost listener sees the fully rewritten
  // configuration from every other contributor and gets the final say.
  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    try {
      await ready
      const { route, source } = resolveRouteWithSource({
        agent: payload.agent,
        agents: ctx.agents,
        projections: ctx.sessionProjections,
        prefs,
      })
      if (route === undefined) return config
      // The pick is retired when the switch actually re-points a request, not
      // when the switch is ticked. Toggling alone therefore changes nothing,
      // and a child that never ran under the switch keeps its pick.
      const agentId = payload.agent?.id
      if (agentId !== undefined && shouldRetirePin(prefs.manualOf(agentId), source)) {
        prefs.setManual(agentId, undefined)
      }
      return applyRoute(config, route)
    } catch (error) {
      // A preference read must never break a model request: pass it through.
      ctx.logger.warn(`subagent-model-sync: route resolution failed, request left untouched: ${String(error)}`)
      return config
    }
  }, { prepend: true })

  // Diagnostics only: confirm the hook is actually live in this Host.
  ctx.logger.info('subagent-model-sync: request hook installed (route rewrite is inert until a preference is set)')

  registerBridge(ctx, prefs, ready)
  schedulePrune(ctx, prefs, ready)
}

/**
 * Retire preferences for Sessions that no longer exist, without being asked.
 *
 * Preferences are keyed by Session id, so a deleted Session leaves an entry
 * nothing will read again — harmless for routing, but it keeps the file from
 * describing reality, and a leftover pick still counts toward the UI warning.
 * A startup sweep plus an hourly one keeps the file aligned.
 *
 * Two safeguards, because a wrong prune destroys user configuration:
 *
 * 1. **An empty list means "not ready", never "nothing exists".** The query
 *    service can answer before the Session store has loaded; pruning against
 *    that answer would wipe every preference.
 * 2. **A missing service is a no-op**, matching the optional-`sessionQuery`
 *    stance the bridge already takes.
 *
 * @param ctx - Host plugin context.
 * @param prefs - preference store.
 * @param ready - first-load gate.
 */
function schedulePrune(ctx, prefs, ready) {
  const sweep = async () => {
    const query = ctx.get('sessionQuery')
    if (query?.listSessions === undefined) return
    try {
      const sessions = await query.listSessions()
      if (sessions.length === 0) return
      const known = new Set(sessions.map((record) => record.header.id))
      prefs.prune((id) => known.has(id))
    } catch (error) {
      // Cleanup is a courtesy: it must never surface as a failure.
      ctx.logger.debug?.(`subagent-model-sync: prune skipped: ${String(error)}`)
    }
  }

  void ready.then(() => sweep()).catch(() => {})

  const interval = setInterval(() => { void sweep() }, PRUNE_INTERVAL_MS)
  // An unref'd timer never keeps the Host alive on its own.
  interval.unref?.()
  ctx.effect(() => () => clearInterval(interval), 'subagent-model-sync: prune sweep')
}

/**
 * Publish the small HTTP surface the browser half calls.
 *
 * The Web GUI and the Host share an origin, so a same-origin POST is the
 * simplest carrier that needs no Remote schema registration. Only loopback
 * callers are served, matching the plugin's local-only scope.
 *
 * @param ctx - Host plugin context.
 * @param prefs - preference store instance.
 * @param ready - first-load gate.
 */
function registerBridge(ctx, prefs, ready) {
  // `sessionQuery` is optional: only the `prune` operation needs it. Injecting
  // it here would silently drop the whole bridge on a deployment that omits it,
  // including the read/write operations that do not depend on it at all.
  ctx.inject(['webServer'], (scope) => {
    const route = `${BRIDGE_PREFIX}/prefs`
    const dispose = scope.webServer.register({
      kind: 'exact',
      path: route,
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          writeJson(res, 403, { ok: false, error: 'loopback requests only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method ?? ''}` })
          return
        }
        let body
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          writeJson(res, 400, { ok: false, error: 'body must be JSON' })
          return
        }
        await ready
        try {
          writeJson(res, 200, await handle(ctx, prefs, body))
        } catch (error) {
          writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
    scope.effect(() => () => dispose(), 'subagent-model-sync: preferences bridge')
  })
}

/**
 * Serve one bridge operation.
 * @param ctx - Host plugin context (reads `sessionQuery` lazily for `prune`).
 * @param prefs - preference store.
 * @param body - parsed request body.
 * @returns JSON-serializable value.
 */
async function handle(ctx, prefs, body) {
  switch (body?.op) {
    case 'read':
      // `sessionId` is optional: the sync switch asks for its own count, while
      // a child seat only needs the raw maps.
      return { ok: true, value: prefs.view(body.sessionId) }
    case 'catalog': {
      // The browser's own model directory hides itself for delegated Sessions,
      // so the pickable catalog is served from here instead.
      const llm = ctx.get('llm')
      if (llm === undefined) throw new Error('this deployment mounts no llm service')
      const groups = []
      const failures = []
      for (const provider of llm.listProviders()) {
        try {
          const models = await llm.listModels(provider.id)
          const entries = []
          for (const model of models) {
            let reasoning
            try {
              const info = await llm.resolveModelInfo(provider.id, model.id)
              if (info?.reasoning !== undefined) {
                reasoning = {
                  ...info.reasoning.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort },
                  efforts: (info.reasoning.efforts ?? []).map((effort) => ({ id: effort.id, name: effort.name })),
                }
              }
            } catch {
              reasoning = undefined
            }
            entries.push({
              id: model.id,
              name: model.name ?? model.id,
              ...reasoning === undefined ? {} : { reasoning },
            })
          }
          if (entries.length > 0) groups.push({ id: provider.id, name: provider.name ?? provider.id, models: entries })
        } catch (error) {
          failures.push({ id: provider.id, message: String(error?.message ?? error) })
        }
      }
      return { ok: true, value: { groups, failures } }
    }
    case 'setSync': {
      if (typeof body.sessionId !== 'string' || body.sessionId === '') throw new Error('sessionId is required')
      prefs.setSync(body.sessionId, body.enabled === true)
      // `view` rather than `snapshot`: the panel re-renders from this response,
      // and the warning it shows depends on the count for this Session.
      return { ok: true, value: prefs.view(body.sessionId) }
    }
    case 'setManual': {
      if (typeof body.sessionId !== 'string' || body.sessionId === '') throw new Error('sessionId is required')
      if (body.route === null) prefs.setManual(body.sessionId, undefined)
      else {
        if (typeof body.route?.provider !== 'string' || body.route.provider === '') throw new Error('route.provider is required')
        if (typeof body.route?.model !== 'string' || body.route.model === '') throw new Error('route.model is required')
        prefs.setManual(body.sessionId, {
          provider: body.route.provider,
          model: body.route.model,
          ...typeof body.route.reasoningEffort === 'string' && body.route.reasoningEffort !== ''
            ? { reasoningEffort: body.route.reasoningEffort }
            : {},
          // The owning lead Session, so a dormant pick can be attributed to the
          // switch that suspends it and counted before the user toggles.
          ...typeof body.route.parent === 'string' && body.route.parent !== ''
            ? { parent: body.route.parent }
            : {},
        })
      }
      return { ok: true, value: prefs.view(body.sessionId) }
    }
    case 'prune': {
      const query = ctx.get('sessionQuery')
      if (query?.listSessions === undefined) throw new Error('prune needs a deployment with sessionQuery mounted')
      const sessions = await query.listSessions()
      const known = new Set(sessions.map((record) => record.header.id))
      prefs.prune((id) => known.has(id))
      return { ok: true, value: prefs.snapshot() }
    }
    default:
      throw new Error(`unknown op: ${String(body?.op)}`)
  }
}

/** @returns whether the request originates from this machine. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Read a bounded JSON body.
 * @param req - incoming request.
 * @returns body text.
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Write one JSON response.
 * @param res - outgoing response.
 * @param status - HTTP status.
 * @param value - serializable payload.
 */
function writeJson(res, status, value) {
  const text = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}
