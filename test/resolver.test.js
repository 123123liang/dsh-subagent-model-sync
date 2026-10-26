/**
 * Offline unit tests for the route resolver and the preference store.
 *
 * Run with `node --test`. No Host, no network: every collaborator is a fake, so
 * the decision table can be checked exhaustively and quickly.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PrefsStore } from '../lib/prefs.js'
import { applyRoute, ownRoute, resolveRoute, resolveRouteWithSource, shouldRetirePin } from '../lib/resolver.js'

/**
 * Build one fake Agent.
 * @param id - Session id.
 * @param parent - direct parent id, or `undefined` for a root.
 * @returns agent-shaped object.
 */
function agent(id, parent) {
  return {
    id,
    session: { header: { id, origin: parent === undefined ? undefined : 'subagent', parentSession: parent } },
  }
}

/**
 * Build the minimum service fakes the resolver reads.
 * @param agents - agent list.
 * @param routes - sessionId -> own route.
 * @returns `{ agents, projections }`.
 */
function services(agents, routes = {}) {
  const byId = new Map(agents.map((item) => [item.id, item]))
  return {
    agents: { get: (id) => byId.get(id) },
    projections: {
      stateOf: (session) => {
        const route = routes[session.header.id]
        return { pending: route ?? null, lastUsed: null }
      },
    },
  }
}

/**
 * Build a preference store with the given maps, bypassing the file.
 * @param sync - lead ids with the switch on.
 * @param manual - child id -> route.
 * @returns store facade.
 */
function prefs(sync = [], manual = {}) {
  return {
    syncOf: (id) => sync.includes(id),
    manualOf: (id) => manual[id],
  }
}

const ROUTE_A = { provider: 'provider-b', model: 'model-x' }
const ROUTE_B = { provider: 'provider-c', model: 'model-y' }

test('a root Session is never rewritten', () => {
  const lead = agent('lead')
  const { agents, projections } = services([lead], { lead: ROUTE_A })
  assert.equal(resolveRoute({ agent: lead, agents, projections, prefs: prefs(['lead']) }), undefined)
})

test('sync off means the plugin is inert for children', () => {
  const lead = agent('lead')
  const child = agent('child', 'lead')
  const { agents, projections } = services([lead, child], { lead: ROUTE_A })
  assert.equal(resolveRoute({ agent: child, agents, projections, prefs: prefs() }), undefined)
})

test('a synced parent hands its current route to the child', () => {
  const lead = agent('lead')
  const child = agent('child', 'lead')
  const { agents, projections } = services([lead, child], { lead: ROUTE_B })
  assert.deepEqual(resolveRoute({ agent: child, agents, projections, prefs: prefs(['lead']) }), ROUTE_B)
})

// The switch is a mode, not a layer: while it is on, a pick made earlier is
// dormant. This is the behaviour that lets one action re-point a whole team.
test('a synced parent outranks a manual child route', () => {
  const lead = agent('lead')
  const child = agent('child', 'lead')
  const { agents, projections } = services([lead, child], { lead: ROUTE_B })
  const store = prefs(['lead'], { child: ROUTE_A })
  assert.deepEqual(resolveRoute({ agent: child, agents, projections, prefs: store }), ROUTE_B)
})

test('a manual child route applies again once sync is off', () => {
  const lead = agent('lead')
  const child = agent('child', 'lead')
  const { agents, projections } = services([lead, child], { lead: ROUTE_B })
  const store = prefs([], { child: ROUTE_A })
  assert.deepEqual(resolveRoute({ agent: child, agents, projections, prefs: store }), ROUTE_A)
})

test('a grandchild follows through the middle layer', () => {
  const lead = agent('lead')
  const child = agent('child', 'lead')
  const grand = agent('grand', 'child')
  const { agents, projections } = services([lead, child, grand], { lead: ROUTE_A })
  assert.deepEqual(resolveRoute({ agent: grand, agents, projections, prefs: prefs(['lead']) }), ROUTE_A)
})

// A single upward walk would let the middle layer's pick shadow the switch that
// governs it. Two passes are what make the mode reach the whole subtree.
test('a synced lead outranks a manual middle layer, even for a grandchild', () => {
  const lead = agent('lead')
  const child = agent('child', 'lead')
  const grand = agent('grand', 'child')
  const { agents, projections } = services([lead, child, grand], { lead: ROUTE_A })
  const store = prefs(['lead'], { child: ROUTE_B })
  assert.deepEqual(resolveRoute({ agent: grand, agents, projections, prefs: store }), ROUTE_A)
})

test('a manual middle layer pins its own subtree when sync is off', () => {
  const lead = agent('lead')
  const child = agent('child', 'lead')
  const grand = agent('grand', 'child')
  const { agents, projections } = services([lead, child, grand], { lead: ROUTE_A })
  const store = prefs([], { child: ROUTE_B })
  assert.deepEqual(resolveRoute({ agent: grand, agents, projections, prefs: store }), ROUTE_B)
})

test('an offline parent leaves the request untouched', () => {
  const child = agent('child', 'missing-lead')
  const { agents, projections } = services([child], {})
  assert.equal(resolveRoute({ agent: child, agents, projections, prefs: prefs(['missing-lead']) }), undefined)
})

test('a cyclic lineage terminates instead of looping', () => {
  const a = agent('a', 'b')
  const b = agent('b', 'a')
  const { agents, projections } = services([a, b], {})
  assert.equal(resolveRoute({ agent: a, agents, projections, prefs: prefs(['b']) }), undefined)
})

test('resolveRouteWithSource names where the route came from', () => {
  const lead = agent('lead')
  const child = agent('child', 'lead')
  const { agents, projections } = services([lead, child], { lead: ROUTE_B })

  // A synced ancestor supplied the route.
  assert.equal(
    resolveRouteWithSource({ agent: child, agents, projections, prefs: prefs(['lead']) }).source,
    'sync',
  )
  // A stored pick supplied it.
  assert.equal(
    resolveRouteWithSource({ agent: child, agents, projections, prefs: prefs([], { child: ROUTE_A }) }).source,
    'manual',
  )
  // Nothing applied.
  assert.equal(
    resolveRouteWithSource({ agent: child, agents, projections, prefs: prefs() }).source,
    'none',
  )
})

test('a pick is retired only when the switch re-pointed the request', () => {
  // Retired: the switch governed this request, so the pick has been superseded.
  assert.equal(shouldRetirePin(ROUTE_A, 'sync'), true)
  // Kept: the pick itself governed the request.
  assert.equal(shouldRetirePin(ROUTE_A, 'manual'), false)
  // Kept: nothing applied, so nothing was consumed.
  assert.equal(shouldRetirePin(ROUTE_A, 'none'), false)
  // Nothing to retire.
  assert.equal(shouldRetirePin(undefined, 'sync'), false)
})

test('ownRoute prefers a pending selection over the logged header', () => {
  const session = { header: { id: 'lead' }, requestHeader: () => ({ config: { provider: 'old', model: 'old-1' } }) }
  const projections = { stateOf: () => ({ pending: ROUTE_A, lastUsed: { provider: 'old', model: 'old-1' } }) }
  assert.deepEqual(ownRoute(projections, session), ROUTE_A)
})

test('ownRoute falls back to the request header when no selection is stored', () => {
  const session = { header: { id: 'lead' }, requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }) }
  const projections = { stateOf: () => ({ pending: null, lastUsed: null }) }
  assert.deepEqual(ownRoute(projections, session), { provider: 'p', model: 'm', reasoningEffort: 'high' })
})

test('applyRoute drops the inherited effort when the route changes', () => {
  const config = { provider: 'old', model: 'old-1', reasoningEffort: 'max', maxTokens: 4096 }
  assert.deepEqual(applyRoute(config, ROUTE_A), { provider: 'provider-b', model: 'model-x', maxTokens: 4096 })
})

test('applyRoute keeps the effort when the route is unchanged', () => {
  const config = { provider: 'provider-b', model: 'model-x', reasoningEffort: 'max' }
  assert.deepEqual(applyRoute(config, ROUTE_A), config)
})

test('preferences round-trip through the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sms-prefs-'))
  try {
    const path = join(dir, 'prefs.json')
    const first = new PrefsStore({ path })
    await first.load()
    first.setSync('lead-1', true)
    first.setManual('child-1', ROUTE_B)
    await first.flushNow()

    const second = new PrefsStore({ path })
    await second.load()
    assert.equal(second.syncOf('lead-1'), true)
    assert.deepEqual(second.manualOf('child-1'), ROUTE_B)
    assert.equal(second.syncOf('lead-2'), false)
    assert.equal(second.manualOf('child-2'), undefined)

    const text = await readFile(path, 'utf8')
    assert.equal(JSON.parse(text).version, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a pick keeps its owning Session through a reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sms-prefs-'))
  try {
    const path = join(dir, 'prefs.json')
    const first = new PrefsStore({ path })
    await first.load()
    first.setManual('child-1', { ...ROUTE_B, parent: 'lead-1' })
    first.setManual('child-2', { ...ROUTE_A, parent: 'lead-1' })
    first.setManual('child-3', ROUTE_A)
    assert.equal(first.pinnedCount('lead-1'), 2)
    await first.flushNow()

    const second = new PrefsStore({ path })
    await second.load()
    assert.equal(second.manualOf('child-1')?.parent, 'lead-1')
    // An entry written before `parent` existed stays valid but is unowned.
    assert.equal(second.manualOf('child-3')?.parent, undefined)
    assert.equal(second.pinnedCount('lead-1'), 2)
    assert.equal(second.pinnedCount('lead-2'), 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('toggling the switch never removes a pick', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sms-prefs-'))
  try {
    const path = join(dir, 'prefs.json')
    const store = new PrefsStore({ path })
    await store.load()
    store.setManual('child-1', { ...ROUTE_B, parent: 'lead-1' })
    store.setSync('lead-1', true)
    store.setSync('lead-1', false)
    store.setSync('lead-1', true)
    store.setSync('lead-1', false)
    await store.flushNow()

    const reopened = new PrefsStore({ path })
    await reopened.load()
    assert.equal(reopened.syncOf('lead-1'), false)
    assert.deepEqual(reopened.manualOf('child-1'), { ...ROUTE_B, parent: 'lead-1' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a corrupt preference file degrades to inert', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sms-prefs-'))
  try {
    const path = join(dir, 'prefs.json')
    const store = new PrefsStore({ path })
    await store.load()
    store.setSync('lead', true)
    await store.flushNow()

    const broken = new PrefsStore({ path: `${path}.missing` })
    await broken.load()
    assert.equal(broken.syncOf('lead'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
