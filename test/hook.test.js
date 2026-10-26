/**
 * Hook-level test for the "retired on effect" rule.
 *
 * `resolver.test.js` proves the decision and `shouldRetirePin` in isolation.
 * This one runs the real `apply()` and invokes the registered `agent/request`
 * listener, so the wiring between them is covered too: the part that was wrong
 * before — a pick surviving a switch that had already overridden it.
 *
 * The Host is faked down to the four services the hook touches; preferences are
 * pointed at a temporary home through `DSH_HOME`, so the real store and its
 * debounced write are exercised rather than stubbed.
 *
 *   node test/hook.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PARENT = 'lead-1'
const CHILD = 'child-1'
const PARENT_ROUTE = { provider: 'provider-b', model: 'parent-model' }
const PIN = { provider: 'provider-a', model: 'pinned-model', parent: PARENT }

/**
 * Boot the plugin against a temporary home holding `document`.
 * @param document - preference document to seed.
 * @param options - `sessionQuery` override for the prune sweep.
 * @returns `{ call, home }`, where `call` invokes the request hook.
 */
async function boot(document, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'sms-hook-'))
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'subagent-model-sync.json'), JSON.stringify(document), 'utf8')
  process.env.DSH_HOME = home

  const { apply } = await import('../lib/index.js')

  let listener
  const parent = {
    id: PARENT,
    session: {
      header: { id: PARENT, origin: undefined },
      requestHeader: () => ({ config: PARENT_ROUTE }),
    },
  }
  const child = {
    id: CHILD,
    session: { header: { id: CHILD, origin: 'subagent', parentSession: PARENT } },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    on: (name, handler) => {
      if (name === 'agent/request') listener = handler
    },
    agents: { get: (id) => (id === PARENT ? parent : undefined) },
    sessionProjections: {
      // No pending pick: the parent's route comes from its recorded header.
      stateOf: () => ({ pending: null, lastUsed: null }),
    },
    // Absent by default so the sweep is exercised as a no-op as well as live.
    get: (service) => (service === 'sessionQuery' ? options.sessionQuery : undefined),
    inject: () => {},
    effect: (factory) => {
      factory()
      return () => {}
    },
  }
  apply(ctx)
  assert.equal(typeof listener, 'function', 'the hook must be registered')

  /**
   * Invoke the hook for the child.
   * @returns the configuration the hook returned.
   */
  const call = () => listener({ agent: child }, () => Promise.resolve({ provider: 'native', model: 'native-model' }))

  return { call, home }
}

/** @returns the current preference document on disk. */
async function readPrefs(home) {
  const text = await readFile(join(home, 'storages', 'subagent-model-sync.json'), 'utf8')
  return JSON.parse(text)
}

test('a switch-driven request rewrites the route and retires the pick', async () => {
  const { call, home } = await boot({ version: 1, sync: { [PARENT]: true }, manual: { [CHILD]: PIN } })
  try {
    const config = await call()
    assert.equal(config.provider, PARENT_ROUTE.provider, 'the request must follow the parent')
    assert.equal(config.model, PARENT_ROUTE.model)

    // The write is debounced; give it time to land.
    await new Promise((resolve) => setTimeout(resolve, 250))
    const prefs = await readPrefs(home)
    assert.deepEqual(prefs.manual[CHILD], undefined, 'the superseded pick must be retired')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a pick survives while the switch is off', async () => {
  const { call, home } = await boot({ version: 1, sync: {}, manual: { [CHILD]: PIN } })
  try {
    const config = await call()
    assert.equal(config.provider, PIN.provider, 'the pick must govern the request')

    await new Promise((resolve) => setTimeout(resolve, 250))
    const prefs = await readPrefs(home)
    assert.deepEqual(prefs.manual[CHILD], PIN, 'the pick must not be touched')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an inactive switch leaves an unpinned child on the official chain', async () => {
  const { call, home } = await boot({ version: 1, sync: {}, manual: {} })
  try {
    const config = await call()
    assert.equal(config.provider, 'native', 'nothing configured means nothing rewritten')
    assert.equal(config.model, 'native-model')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a pick for a deleted Session is swept at startup', async () => {
  const sessionQuery = { listSessions: async () => [{ header: { id: PARENT } }] }
  const { home } = await boot({ version: 1, sync: { [PARENT]: true }, manual: { [CHILD]: PIN } }, { sessionQuery })
  try {
    await new Promise((resolve) => setTimeout(resolve, 300))
    const prefs = await readPrefs(home)
    assert.deepEqual(prefs.manual[CHILD], undefined, 'a Session that is gone must not keep a pick')
    assert.equal(prefs.sync[PARENT], true, 'a live Session keeps its switch')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an empty Session list never wipes preferences', async () => {
  // The store can answer before it has loaded anything. Pruning against that
  // answer would delete every pick the user ever made, so it is skipped.
  const sessionQuery = { listSessions: async () => [] }
  const { home } = await boot({ version: 1, sync: {}, manual: { [CHILD]: PIN } }, { sessionQuery })
  try {
    await new Promise((resolve) => setTimeout(resolve, 300))
    const prefs = await readPrefs(home)
    assert.deepEqual(prefs.manual[CHILD], PIN, 'an empty list must be treated as "not ready"')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
