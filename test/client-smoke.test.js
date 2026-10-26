/**
 * Offline smoke test for the browser half.
 *
 * Executes the bundle the way the client module loader does — capture the
 * `__ModuleLoader__.load` call, then invoke the factory with a fake `require` —
 * so a top-level crash (a missing primitive, a bad reference, an unguarded
 * import) fails here instead of silently taking the composer seat down.
 *
 * Rendering is not exercised: no DOM, no React. This covers the layer that has
 * actually broken twice (module load and first-render setup).
 *
 *   node test/client-smoke.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '..', 'lib', 'client.js')

/**
 * Run one bundle with a fake module loader.
 * @param requireImpl - the fake `require` handed to the factory.
 * @returns the plugin exports.
 */
async function load(requireImpl) {
  const code = await readFile(bundle, 'utf8')
  let captured
  const window = { __ModuleLoader__: { load: (record) => { captured = record } } }
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, set textContent(_) {} }),
    head: { appendChild: () => {} },
    body: {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  new Function('window', 'document', 'fetch', code)(window, document, async () => ({ ok: false }))
  assert.equal(captured?.id, 'dsh-subagent-model-sync')
  return captured.factory(requireImpl)
}

/** React stand-in: enough surface for the module body and one hook pass. */
const reactStub = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}

/** jsx runtime stand-in: describe elements as plain objects. */
const jsxStub = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: 'Fragment',
}

/**
 * Build a `require` that resolves the modules the bundle asks for.
 * @param options - `primitives` throws when false, to prove the fallback.
 * @returns fake require.
 */
function requireFor(options = {}) {
  return (specifier) => {
    if (specifier === 'react') return reactStub
    if (specifier === 'react/jsx-runtime') return jsxStub
    if (specifier === 'react-dom') return { createPortal: (node) => node }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      if (options.primitives === false) throw new Error('missing primitives')
      return { MenuSurface: 'MenuSurface' }
    }
    throw new Error(`unexpected require: ${specifier}`)
  }
}

test('the browser half loads and exports the plugin contract', async () => {
  const exports = await load(requireFor())
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'sessions'])
})

test('a missing ui-primitives package degrades instead of crashing', async () => {
  const exports = await load(requireFor({ primitives: false }))
  assert.equal(typeof exports.apply, 'function')
})

test('apply() registers one composer seat without throwing', async () => {
  const exports = await load(requireFor())
  const registered = []
  const ctx = {
    effect: (factory) => factory(),
    locale: { register: () => {}, getLocale: () => ({ active: 'zh' }) },
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'conversation.input.right')
  assert.equal(registered[0].options.id, 'subagent-model-sync')
})

/**
 * Props the renderer actually hands a session-scoped seat. Only names proven
 * present on a composer seat are listed; `useProjection` is deliberately absent
 * because it does not exist, and reading it retired the seat for good.
 * @param options - `subagent` snapshot override.
 * @returns a props object.
 */
function seatProps(options = {}) {
  const subagent = options.subagent === undefined ? null : options.subagent
  return {
    sessionId: 'session-1',
    t: (key) => key,
    useSession: (select) => select({ subagent }),
    useSessions: (select) => select({ projectionsBySession: {} }),
  }
}

/**
 * Register the seat and hand back its component.
 * @returns the registered slot component.
 */
async function seatOf() {
  const exports = await load(requireFor())
  let seat
  const ctx = {
    effect: (factory) => factory(),
    locale: { register: () => {}, getLocale: () => ({ active: 'zh' }) },
    slots: { inject: (_k, cb) => cb(), register: (_o, component) => { seat = component; return () => {} } },
  }
  exports.apply(ctx)
  return seat
}

test('the seat renders on a root Session without throwing', async () => {
  const seat = await seatOf()
  const element = seat(seatProps())
  const tree = element.type(element.props)
  // A root Session gets the SyncSwitch branch; the assertion that matters is
  // that selecting and branching threw nothing.
  assert.notEqual(tree, null)
  assert.equal(tree.props['data-sms-seat'], 'root')
})

test('the seat renders on a delegated Session without throwing', async () => {
  const seat = await seatOf()
  const element = seat(seatProps({
    subagent: { address: { mode: 'continuable', parentSessionId: 'parent-1', childSessionId: 'session-1' } },
  }))
  const tree = element.type(element.props)
  assert.notEqual(tree, null)
  assert.equal(tree.props['data-sms-seat'], 'child')
})

test('a seat without useSession renders nothing instead of crashing', async () => {
  const seat = await seatOf()
  const element = seat({ sessionId: 's', t: (k) => k })
  // The wrapper always yields the Seat element; `Seat` is what guards.
  assert.equal(element.type(element.props), null)
})
