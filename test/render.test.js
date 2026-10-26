/**
 * Real render test for the browser half.
 *
 * The fake-runtime test proves the module loads; this one proves it actually
 * RENDERS under React with the real `jsx-runtime`. Three defects slipped past
 * the fake test and cost a restart cycle each:
 *
 *   1. `jsx(type, props, key)` — children passed as the third argument render
 *      an empty element (key), not the children.
 *   2. `useSyncExternalStore` with a fresh `[]` snapshot throws every render.
 *   3. A prop the renderer never supplies (`useProjection`) threw on call.
 *
 * All three are caught here because this mounts into jsdom and asserts on the
 * resulting DOM.
 *
 *   node test/render.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'
import React from 'react'
import ReactDOMClient from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '..', 'lib', 'client.js')

/**
 * Mount the plugin's seat into a fresh jsdom document.
 * @param props - props the renderer would supply.
 * @param options - `fetch` override so a test can serve a catalog or preferences.
 * @returns mounted document + unmount function.
 */
async function mount(props, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { pretendToBeVisual: true })
  const { window } = dom
  // react-dom reads these off the global scope during commit. `navigator` is a
  // getter-only global on Node 22+, so it is defined rather than assigned.
  globalThis.window = window
  globalThis.document = window.document
  globalThis.MouseEvent = window.MouseEvent
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
  const code = await readFile(bundle, 'utf8')

  let record
  const fakeWindow = { __ModuleLoader__: { load: (value) => { record = value } } }
  new Function('window', 'document', 'fetch', code)(
    fakeWindow,
    window.document,
    options.fetch ?? (async () => ({ ok: false })),
  )

  const exports = record.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    if (specifier === 'react-dom') return ReactDOMClient
    // Absent on purpose: the seat must survive a missing primitive package.
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') throw new Error('missing primitives')
    throw new Error(`unexpected require: ${specifier}`)
  })

  let seat
  exports.apply({
    effect: (factory) => factory(),
    locale: { register: () => {}, getLocale: () => ({ active: 'zh' }) },
    slots: {
      inject: (_key, callback) => callback(),
      register: (_options, component) => {
        seat = component
        return () => {}
      },
    },
  })

  const root = ReactDOMClient.createRoot(window.document.getElementById('app'))
  root.render(React.createElement(seat, props))
  // Let effects, transitions and microtasks settle.
  await new Promise((resolve) => setTimeout(resolve, 120))
  return { document: window.document, unmount: () => root.unmount() }
}

/** Props for a root Session, matching what the renderer actually supplies. */
function rootProps() {
  return {
    sessionId: 'session-root',
    t: (key) => key,
    useSession: (select) => select({ subagent: null }),
    useSessions: (select) => select({ projectionsBySession: {} }),
  }
}

test('a root Session mounts a visible trigger', async () => {
  const { document, unmount } = await mount(rootProps())
  try {
    const seat = document.querySelector('[data-sms-seat]')
    assert.ok(seat, 'the seat wrapper must exist')
    assert.equal(seat.getAttribute('data-sms-seat'), 'root')
    const button = seat.querySelector('button')
    assert.ok(button, 'the trigger button must render')
    assert.ok(button.textContent.includes('同步子代理'), `unexpected label: ${button.textContent}`)
  } finally {
    unmount()
  }
})

test('a delegated Session mounts the child seat', async () => {
  const props = {
    sessionId: 'session-child',
    t: (key) => key,
    useSession: (select) => select({
      subagent: { address: { mode: 'continuable', parentSessionId: 'session-root', childSessionId: 'session-child' } },
    }),
    useSessions: (select) => select({ projectionsBySession: {} }),
  }
  const { document, unmount } = await mount(props)
  try {
    const seat = document.querySelector('[data-sms-seat]')
    assert.ok(seat, 'the seat wrapper must exist')
    assert.equal(seat.getAttribute('data-sms-seat'), 'child')
    const button = seat.querySelector('button')
    assert.ok(button, 'the child trigger must render')
  } finally {
    unmount()
  }
})

test('opening the panel renders inside the document, not the wrapper', async () => {
  const { document, unmount } = await mount(rootProps())
  try {
    const button = document.querySelector('[data-sms-seat] button')
    button.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 80))
    // The panel is portalled; look for its row anywhere in the document.
    const row = [...document.querySelectorAll('button')].find((node) => node.getAttribute('role') === 'menuitemcheckbox')
    assert.ok(row, 'the sync row must appear after opening')
  } finally {
    unmount()
  }
})

/**
 * Serve a Host bridge that knows one provider with two models: the second
 * advertises thinking levels. Preference writes are recorded so a test can
 * assert what the UI actually sent.
 * @param calls - array collecting every bridge body.
 * @returns a `fetch` stand-in.
 */
function catalogFetch(calls) {
  return async (_url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    if (body.op === 'catalog') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          value: {
            groups: [{
              id: 'provider-a',
              name: 'provider-a',
              models: [
                { id: 'plain-model', name: 'Plain' },
                {
                  id: 'think-model',
                  name: 'Thinker',
                  reasoning: {
                    defaultEffort: 'medium',
                    efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'max', name: 'Max' }],
                  },
                },
              ],
            }],
            failures: [],
          },
        }),
      }
    }
    if (body.op === 'read') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          value: { sync: {}, manual: { 'session-child': { provider: 'provider-a', model: 'think-model' } } },
        }),
      }
    }
    return { ok: true, json: async () => ({ ok: true, value: { sync: {}, manual: {} } }) }
  }
}

/** Props for a delegated Session already pinned to the thinking model. */
function childProps() {
  return {
    sessionId: 'session-child',
    t: (key) => key,
    useSession: (select) => select({
      subagent: { address: { mode: 'continuable', parentSessionId: 'session-root', childSessionId: 'session-child' } },
    }),
    useSessions: (select) => select({ projectionsBySession: {} }),
  }
}

test('the effort block sits in the panel footer, above the scrolling list', async () => {
  const calls = []
  const { document, unmount } = await mount(childProps(), { fetch: catalogFetch(calls) })
  try {
    const trigger = document.querySelector('[data-sms-seat] button')
    trigger.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 120))

    const footer = document.querySelector('.sms-foot')
    assert.ok(footer, 'the fixed footer must render')
    const list = document.querySelector('.sms-list')
    assert.ok(list, 'the model list must render')
    // The footer must come after the list: the list is the scroll region above.
    assert.ok(list.compareDocumentPosition(footer) & 4, 'the footer must follow the list')

    const effortButton = footer.querySelector('button')
    assert.ok(effortButton, 'the effort control must render inside the footer')
    assert.equal(effortButton.disabled, false, 'a model with levels must stay enabled')
  } finally {
    unmount()
  }
})

test('picking a thinking level sends that level with the pinned route', async () => {
  const calls = []
  const { document, unmount } = await mount(childProps(), { fetch: catalogFetch(calls) })
  try {
    document.querySelector('[data-sms-seat] button')
      .dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 120))

    const effortButton = document.querySelector('.sms-foot button')
    effortButton.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 80))

    const level = [...document.querySelectorAll('.sms-effortOpt')].find((node) => node.textContent.includes('Max'))
    assert.ok(level, 'the advertised levels must be listed')
    level.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 80))

    const write = calls.filter((call) => call.op === 'setManual').at(-1)
    assert.ok(write, 'picking a level must reach the bridge')
    // `parent` rides along so a dormant pick can be attributed to the switch
    // that would suspend it, and counted before the user toggles.
    assert.deepEqual(write.route, {
      provider: 'provider-a',
      model: 'think-model',
      reasoningEffort: 'max',
      parent: 'session-root',
    })
  } finally {
    unmount()
  }
})

test('a model without thinking levels disables the effort control', async () => {
  const calls = []
  const fetchImpl = catalogFetch(calls)
  const { document, unmount } = await mount({
    ...childProps(),
    useSessions: (select) => select({ projectionsBySession: {} }),
  }, {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      if (body.op === 'read') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            value: { sync: {}, manual: { 'session-child': { provider: 'provider-a', model: 'plain-model' } } },
          }),
        }
      }
      return fetchImpl(url, init)
    },
  })
  try {
    document.querySelector('[data-sms-seat] button')
      .dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 120))
    const effortButton = document.querySelector('.sms-foot button')
    assert.ok(effortButton, 'the effort control renders even when unavailable')
    assert.equal(effortButton.disabled, true, 'a model without levels must disable it')
  } finally {
    unmount()
  }
})

/**
 * Serve preferences with a given sync state while reusing the catalog.
 * @param calls - array collecting every bridge body.
 * @param value - preference payload the `read` op returns.
 * @returns a `fetch` stand-in.
 */
function prefsFetch(calls, value) {
  const catalog = catalogFetch(calls)
  return async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.op === 'read' || body.op === 'setSync') {
      calls.push(body)
      return { ok: true, json: async () => ({ ok: true, value }) }
    }
    return catalog(url, init)
  }
}

test('a synced parent locks every control and explains why', async () => {
  const calls = []
  const value = { sync: { 'session-root': true }, manual: { 'session-child': { provider: 'provider-a', model: 'think-model', parent: 'session-root' } }, pinnedCount: 1 }
  const { document, unmount } = await mount(childProps(), { fetch: prefsFetch(calls, value) })
  try {
    document.querySelector('[data-sms-seat] button')
      .dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 140))

    const menu = document.querySelector('.sms-menu')
    assert.ok(menu, 'the panel must render')
    assert.equal(menu.getAttribute('data-locked'), 'true', 'the panel must mark itself locked')

    // The explanation is shown where the source hint would otherwise be.
    const locked = [...document.querySelectorAll('.sms-locked')]
    assert.equal(locked.length, 1, 'exactly one lock notice')
    assert.ok(locked[0].textContent.includes('已开启同步子代理'), `unexpected notice: ${locked[0].textContent}`)

    // A pick must not be offered while its value would be ignored.
    const options = [...document.querySelectorAll('.sms-opt')]
    assert.ok(options.length > 0, 'the catalog still lists models')
    for (const option of options) assert.equal(option.disabled, true, 'model options must be disabled')

    const search = document.querySelector('.sms-search')
    assert.equal(search.disabled, true, 'the search box must be disabled')
  } finally {
    unmount()
  }
})

test('the sync panel states how many picks turning it on would override', async () => {
  const calls = []
  const value = { sync: {}, manual: {}, pinnedCount: 2 }
  const { document, unmount } = await mount(rootProps(), { fetch: prefsFetch(calls, value) })
  try {
    document.querySelector('[data-sms-seat] button')
      .dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 140))
    const warn = document.querySelector('.sms-warn')
    assert.ok(warn, 'the warning must appear when picks exist')
    assert.ok(warn.textContent.includes('2'), `the count must be stated: ${warn.textContent}`)
    // A pick is retired when the switch actually re-points a request, so the
    // wording must not promise "restored later" — it is overridden.
    assert.ok(warn.textContent.includes('覆盖'), `the wording must say overridden: ${warn.textContent}`)
    assert.ok(warn.textContent.includes('下次请求'), `the wording must say when: ${warn.textContent}`)
  } finally {
    unmount()
  }
})

test('no warning appears when the Session has no pinned children', async () => {
  const calls = []
  const value = { sync: {}, manual: {}, pinnedCount: 0 }
  const { document, unmount } = await mount(rootProps(), { fetch: prefsFetch(calls, value) })
  try {
    document.querySelector('[data-sms-seat] button')
      .dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 140))
    assert.equal(document.querySelector('.sms-warn'), null, 'an empty count must stay silent')
  } finally {
    unmount()
  }
})

test('a locked seat names the parent route, not the dormant pick or stale own record', async () => {
  const calls = []
  // Three different values on purpose, so the assertion says exactly which one
  // the seat reads: the pick is think-model, this Session's own last request is
  // stale-model, and the parent — which actually governs the request — is
  // live-model. Only live-model may appear.
  const value = {
    sync: { 'session-root': true },
    manual: { 'session-child': { provider: 'provider-a', model: 'think-model', parent: 'session-root' } },
    pinnedCount: 1,
  }
  const props = {
    ...childProps(),
    useSessions: (select) => select({
      projectionsBySession: {
        'session-child': { values: { modelSelection: { next: null, lastUsed: { provider: 'provider-a', model: 'stale-model' } } } },
        'session-root': { values: { modelSelection: { next: null, lastUsed: { provider: 'provider-b', model: 'live-model' } } } },
      },
    }),
  }
  const { document, unmount } = await mount(props, { fetch: prefsFetch(calls, value) })
  try {
    document.querySelector('[data-sms-seat] button')
      .dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 140))
    const menu = document.querySelector('.sms-menu')
    assert.ok(menu, 'the panel must render')
    assert.ok(menu.textContent.includes('live-model'), 'the parent route must be named')
    assert.ok(!menu.textContent.includes('think-model'), 'a dormant pick must not be presented as current')
    assert.ok(!menu.textContent.includes('stale-model'), 'a stale own record must not be presented as current')
  } finally {
    unmount()
  }
})
