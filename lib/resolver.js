/**
 * Route resolution for `dsh-subagent-model-sync`.
 *
 * The whole feature is one pure decision, evaluated once per model request:
 *
 *   sync(nearest synced ancestor)       // 1. a synced ancestor governs outright
 *   ?? manual(child)                    // 2. user picked a model for THIS child
 *   ?? manual(nearest manual ancestor)  // 3. a middle layer pins the subtree
 *   ?? undefined                        // 4. official behaviour, untouched
 *
 * Returning `undefined` is the important case: it means "do not touch this
 * request", so the plugin is inert whenever nothing is configured.
 *
 * The sync rule is a **mode, not a layer**: while a Session has its switch on,
 * every descendant runs on that Session's route and per-child picks are
 * dormant. That is what lets one action re-point a whole team, and it is why
 * the switch is checked in a separate pass — a single upward walk would let a
 * middle layer's pick shadow the switch that governs it.
 *
 * @module dsh-subagent-model-sync/resolver
 */

/** Hard stop for a corrupt or cyclic lineage; real delegation depth is small. */
const MAX_DEPTH = 32

/**
 * Read the route a Session itself would use next.
 *
 * The projection's `pending` is a selection the user made that no request has
 * consumed yet; `lastUsed` is the most recent recorded request. Preferring
 * `pending` is what lets a freshly switched model reach children before the
 * user sends anything.
 *
 * @param projections - Host `sessionProjections` service.
 * @param session - Session whose own route is read.
 * @returns detached route, or `undefined` when nothing is known yet.
 */
export function ownRoute(projections, session) {
  let state
  try {
    state = projections.stateOf(session, 'modelSelection')
  } catch {
    state = undefined
  }
  const picked = state?.pending ?? state?.lastUsed
  if (picked !== undefined && picked !== null && typeof picked.provider === 'string' && typeof picked.model === 'string') {
    return {
      provider: picked.provider,
      model: picked.model,
      ...picked.reasoningEffort === undefined || picked.reasoningEffort === null ? {} : { reasoningEffort: picked.reasoningEffort },
    }
  }
  let header
  try {
    header = session.requestHeader()?.config
  } catch {
    header = undefined
  }
  if (header === undefined || typeof header.provider !== 'string' || typeof header.model !== 'string') return undefined
  return {
    provider: header.provider,
    model: header.model,
    ...header.reasoningEffort === undefined ? {} : { reasoningEffort: header.reasoningEffort },
  }
}

/**
 * Walk the delegation chain from an Agent upwards, nearest ancestor first.
 *
 * A missing parent or a cycle ends the walk instead of extending it: a
 * half-known lineage must never invent a decision.
 *
 * @param agent - Agent whose ancestry is walked.
 * @param agents - Host `agents` service.
 * @returns ancestors in order, nearest first.
 */
function ancestorsOf(agent, agents) {
  const chain = []
  const visited = new Set([agent.id])
  let cursor = agent
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const parentId = cursor?.session?.header?.parentSession
    if (parentId === undefined || visited.has(parentId)) return chain
    visited.add(parentId)
    const parent = agents.get(parentId)
    if (parent === undefined) return chain
    chain.push(parent)
    cursor = parent
  }
  return chain
}

/**
 * Decide the route one request must use, together with where it came from.
 *
 * `source` is what lets the caller retire a pick the switch has just
 * superseded: `'sync'` means a synced ancestor supplied the route, `'manual'`
 * means a stored pick did, `'none'` means the request is left alone.
 *
 * @param context - resolution inputs.
 * @param context.agent - Agent issuing the request.
 * @param context.agents - Host `agents` service (parent lookup).
 * @param context.projections - Host `sessionProjections` service.
 * @param context.prefs - preference store.
 * @returns `{ route, source }`; `route` is undefined for official behaviour.
 */
export function resolveRouteWithSource({ agent, agents, projections, prefs }) {
  // Only delegated Sessions are ever rewritten. A root Session keeps its own
  // selection: the switch governs children, never the conversation itself.
  if (agent?.session?.header?.origin !== 'subagent') return { route: undefined, source: 'none' }

  const chain = ancestorsOf(agent, agents)

  // Pass 1: the switch wins outright. Checking it before any manual pick is
  // what makes "sync on" mean "the whole subtree is uniform" — including
  // descendants that were pinned before the switch was turned on.
  for (const parent of chain) {
    if (!prefs.syncOf(parent.id)) continue
    const route = ownRoute(projections, parent.session)
    // A synced parent with no recorded route yields to the official chain rather
    // than falling through to a pick the switch was meant to govern.
    return route === undefined ? { route: undefined, source: 'none' } : { route, source: 'sync' }
  }

  // Pass 2: an explicit pick. The child's own pick outranks an ancestor's.
  const own = prefs.manualOf(agent.id)
  if (own !== undefined) return { route: own, source: 'manual' }
  for (const parent of chain) {
    const manual = prefs.manualOf(parent.id)
    if (manual !== undefined) return { route: manual, source: 'manual' }
  }
  return { route: undefined, source: 'none' }
}

/**
 * Decide the route one request must use, or `undefined` to leave it alone.
 *
 * Thin wrapper for callers that do not care why the route was chosen.
 *
 * @param context - resolution inputs, as {@link resolveRouteWithSource}.
 * @returns detached route to force, or `undefined` for official behaviour.
 */
export function resolveRoute(context) {
  return resolveRouteWithSource(context).route
}

/**
 * Whether a switch-driven rewrite retires the child's own pick.
 *
 * This is the "consumed on effect, not on toggle" rule: ticking the switch
 * changes nothing, and only a request the switch actually re-pointed retires
 * the pick. Equal routes count too — the pick was superseded either way, and
 * the route that results is identical.
 *
 * @param pin - the child's stored pick, if any.
 * @param source - where the resolved route came from.
 * @returns whether the pick should be dropped.
 */
export function shouldRetirePin(pin, source) {
  return pin !== undefined && source === 'sync'
}

/**
 * Apply a resolved route to one frozen call configuration.
 *
 * The inherited reasoning effort is dropped when the route changes: effort ids
 * are adapter-owned, so an id valid for the previous model may be rejected by
 * the new one. An explicitly resolved effort wins again.
 *
 * @param config - configuration produced by the official chain.
 * @param route - route decided by {@link resolveRoute}.
 * @returns the rewritten configuration.
 */
export function applyRoute(config, route) {
  if (config.provider === route.provider && config.model === route.model) {
    return route.reasoningEffort === undefined ? config : { ...config, reasoningEffort: route.reasoningEffort }
  }
  const { reasoningEffort: _inheritedEffort, ...rest } = config
  return {
    ...rest,
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
  }
}
