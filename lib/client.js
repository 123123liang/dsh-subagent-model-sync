window.__ModuleLoader__.load({
  id: 'dsh-subagent-model-sync',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let react = require('react')
    let reactDom = require('react-dom')
    let jsxRuntime = require('react/jsx-runtime')
    const h = jsxRuntime.jsx
    const Fragment = jsxRuntime.Fragment

    // The official menu surface owns the opaque material, blur and elevation.
    // Rolling our own produced a translucent panel that let the conversation
    // show through. It is optional: a missing primitive must degrade to a plain
    // opaque panel, never take the whole seat down.
    let primitives
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = undefined
    }
    const MenuSurface = primitives?.MenuSurface ?? 'div'

    /* ------------------------------------------------------------------ *
     * Bridge
     * ------------------------------------------------------------------ */

    /** Same-origin preferences endpoint served by the Host half. */
    const BRIDGE = '/api/subagent-model-sync/prefs'

    /**
     * Call the Host bridge.
     * @param body - operation payload.
     * @returns bridge result, or undefined when unreachable.
     */
    async function callBridge(body) {
      try {
        const response = await fetch(BRIDGE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!response.ok) return undefined
        const payload = await response.json()
        return payload?.ok === true ? payload.value : undefined
      } catch {
        return undefined
      }
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const CSS = `
.sms-root{position:relative;display:inline-flex;align-items:center;min-width:0}
.sms-trigger{border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-caption);cursor:pointer;background:0 0;border:0;outline:none;align-items:center;gap:4px;padding:0 6px;font-size:12px;line-height:20px;display:inline-flex;transition:color .12s}
.sms-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sms-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.sms-trigger[data-on="true"]{color:var(--dsw-alias-state-business-primary)}
.sms-trigger[data-off="true"]{color:var(--dsw-alias-label-caption)}
.sms-trigger[aria-busy="true"]{opacity:.6;cursor:default}
.sms-dot{width:6px;height:6px;border-radius:50%;flex:none;background:currentColor;opacity:.35}
.sms-trigger[data-on="true"] .sms-dot{opacity:1}
.sms-menu{position:fixed;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(280px,100vw - 32px);max-width:min(400px,100vw - 32px);max-height:min(520px,100vh - 96px);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);flex-direction:column;padding:4px;display:flex;overflow:hidden}
.sms-row{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:var(--dsw-radius-md);cursor:pointer;border:0;background:0 0;text-align:left;color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px;width:100%}
.sms-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sms-check{flex:none;width:14px;height:17px;display:grid;place-items:center;color:var(--dsw-alias-label-primary)}
.sms-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.sms-title{font-weight:400}
.sms-desc{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
.sms-model{font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:4px;min-width:0}
.sms-modelText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sms-badge{flex:none;font-size:10px;color:var(--dsw-alias-label-caption)}
.sms-head{display:flex;flex-direction:column;gap:3px;padding:6px 8px 8px;flex:none}
.sms-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1);flex:none}
.sms-list{min-height:0;flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:1px}
.sms-group{color:var(--dsw-alias-label-tertiary);font-size:10px;letter-spacing:.04em;text-transform:uppercase;padding:6px 8px 2px}
.sms-opt{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:var(--dsw-radius-md);cursor:pointer;border:0;background:0 0;text-align:left;color:inherit;font-size:13px;line-height:18px;width:100%}
.sms-opt:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sms-opt[aria-selected="true"]{font-weight:600}
.sms-search{width:100%;box-sizing:border-box;border-radius:var(--dsw-radius-md);background:0 0;border:1px solid var(--dsw-alias-border-l1);color:inherit;font-size:12px;padding:5px 7px}
.sms-empty{color:var(--dsw-alias-label-tertiary);padding:8px;font-size:12px}
.sms-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;padding:2px 8px 6px}
.sms-warn{color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:15px;padding:2px 8px 6px}
.sms-locked{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;padding:6px 8px}
.sms-menu[data-locked="true"] .sms-opt{opacity:.45;cursor:default}
.sms-menu[data-locked="true"] .sms-opt:hover{background:0 0}
.sms-foot{flex:none;display:flex;flex-direction:column;gap:1px;margin-top:2px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:4px}
.sms-effortBtn{display:flex;align-items:center;gap:6px;width:100%;padding:5px 8px;border:0;background:0 0;border-radius:var(--dsw-radius-md);cursor:pointer;color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px;text-align:left}
.sms-effortBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sms-effortBtn:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.sms-effortLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sms-effortValue{flex:none;color:var(--dsw-alias-state-business-primary)}
.sms-chevron{flex:none;width:10px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:10px}
.sms-effortList{flex:none;display:flex;flex-direction:column;gap:1px;max-height:126px;overflow-y:auto}
.sms-effortOpt{display:flex;align-items:center;gap:6px;padding:4px 8px;border:0;background:0 0;border-radius:var(--dsw-radius-md);cursor:pointer;color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px;text-align:left;width:100%}
.sms-effortOpt:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sms-effortOpt[aria-selected="true"]{font-weight:600}
`

    const TAG = 'dsh-subagent-model-sync/styles'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${TAG}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-subagent-model-sync'
      tag.dataset.pluginCss = TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ------------------------------------------------------------------ *
     * Model catalog
     * ------------------------------------------------------------------ */

    /** Provider groups of the last successful read; `undefined` until loaded. */
    let catalogGroupsCache
    /** Pending read, so concurrent seats share one request. */
    let catalogInflight
    /** Subscribers notified when a read lands. */
    const catalogListeners = new Set()
    /** Stable empty value: a fresh `[]` per call breaks snapshot caching. */
    const EMPTY_GROUPS = Object.freeze([])
    /** Stable empty effort list for models that advertise no levels. */
    const EMPTY_EFFORTS = Object.freeze([])

    /**
     * Read the pickable catalog from the Host bridge, deduplicated per page.
     * The browser's own model directory refuses delegated Sessions, so this is
     * the only catalog a child seat can show.
     * @returns the current groups, or the shared empty value before the first read.
     */
    function readCatalog() {
      if (catalogGroupsCache !== undefined) return catalogGroupsCache
      if (catalogInflight === undefined) {
        catalogInflight = callBridge({ op: 'catalog' }).then((value) => {
          catalogInflight = undefined
          if (value?.groups === undefined) return
          catalogGroupsCache = value.groups
          for (const listener of catalogListeners) listener()
        })
      }
      return EMPTY_GROUPS
    }

    /**
     * Subscribe to catalog arrivals.
     * @param listener - re-render callback.
     * @returns unsubscribe function.
     */
    function onCatalog(listener) {
      catalogListeners.add(listener)
      return () => catalogListeners.delete(listener)
    }

    /* ------------------------------------------------------------------ *
     * Shared popover placement
     * ------------------------------------------------------------------ */

    /** Unplaced fallback popover: measured at the origin and invisible first. */
    const MEASURE_STYLE = { position: 'fixed', left: 0, top: 0, visibility: 'hidden' }

    /**
     * Wrap a popover for rendering.
     * The official `MenuSurface` positions itself, so it is portalled to the
     * document body. The fallback `div` is plain markup with a computed
     * position, so it renders in place — portalling it would depend on a
     * document global the plugin does not own.
     * @param node - popover element.
     * @param portalled - whether the primitive is available.
     * @returns the element to render.
     */
    function present(node, portalled) {
      return portalled && typeof document !== 'undefined' ? reactDom.createPortal(node, document.body) : node
    }

    /**
     * Keep a fixed-position menu inside the viewport, anchored above the trigger.
     * A portal renders on its first pass before layout, so the caller measures
     * through this function and re-renders with the returned style.
     * @param menu - menu element.
     * @param trigger - anchor element.
     * @returns absolute coordinates for the menu.
     */
    function measure(menu, trigger) {
      const rect = trigger.getBoundingClientRect()
      const width = menu.offsetWidth
      const height = menu.offsetHeight
      let left = rect.left
      if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8)
      let top = rect.top - height - 6
      if (top < 8) top = Math.min(window.innerHeight - height - 8, rect.bottom + 6)
      return { position: 'fixed', left: `${Math.round(left)}px`, top: `${Math.round(top)}px` }
    }

    /**
     * Close a popover on outside click or Escape.
     * @param menu - menu element.
     * @param trigger - anchor element.
     * @param close - close callback.
     * @returns disposer.
     */
    function dismissOn(menu, trigger, close) {
      const onDown = (event) => {
        if (menu.contains(event.target) || trigger.contains(event.target)) return
        close()
      }
      const onKey = (event) => {
        if (event.key === 'Escape') close()
      }
      document.addEventListener('mousedown', onDown, true)
      document.addEventListener('keydown', onKey, true)
      return () => {
        document.removeEventListener('mousedown', onDown, true)
        document.removeEventListener('keydown', onKey, true)
      }
    }

    /* ------------------------------------------------------------------ *
     * Main-session switch
     * ------------------------------------------------------------------ */

    /**
     * Small switch that makes every descendant Agent follow this Session.
     * Renders only on a root Session: children use {@link ChildModelSeat}.
     */
    function SyncSwitch({ sessionId, t }) {
      const [on, setOn] = react.useState(false)
      // How many children of this Session carry a pick the switch would suspend.
      // Read with the same call as the state so the two never disagree.
      const [pinned, setPinned] = react.useState(0)
      const [open, setOpen] = react.useState(false)
      const [menuStyle, setMenuStyle] = react.useState(MEASURE_STYLE)
      const triggerRef = react.useRef(null)
      const menuRef = react.useRef(null)

      react.useEffect(() => {
        let cancelled = false
        void callBridge({ op: 'read', sessionId }).then((value) => {
          if (cancelled || value === undefined) return
          setOn(value.sync?.[sessionId] === true)
          if (typeof value.pinnedCount === 'number') setPinned(value.pinnedCount)
        })
        return () => {
          cancelled = true
        }
      }, [sessionId])

      react.useEffect(() => {
        if (!open) {
          setMenuStyle(MEASURE_STYLE)
          return undefined
        }
        const menu = menuRef.current
        const trigger = triggerRef.current
        if (menu === null || trigger === null) return undefined
        setMenuStyle(measure(menu, trigger))
        return dismissOn(menu, trigger, () => setOpen(false))
      }, [open])

      // No readiness gate: the switch renders immediately in its default (off)
      // state and the bridge read only corrects it. Gating the whole control on
      // a fetch made the seat invisible wherever that read did not land — which
      // is exactly what happened on the desktop shell.

      const toggle = async () => {
        const next = !on
        setOn(next)
        const value = await callBridge({ op: 'setSync', sessionId, enabled: next })
        if (value !== undefined) {
          setOn(value.sync?.[sessionId] === true)
          if (typeof value.pinnedCount === 'number') setPinned(value.pinnedCount)
        }
      }

      return h('div', {
        className: 'sms-root',
        children: [
          h('button', {
            key: 'trigger',
            ref: triggerRef,
            type: 'button',
            className: 'sms-trigger',
            'data-on': on ? 'true' : 'false',
            'data-off': on ? 'false' : 'true',
            'aria-expanded': open,
            'aria-label': t('sync.aria'),
            title: t('sync.title'),
            onClick: () => setOpen((value) => !value),
            children: [
              h('span', { key: 'dot', className: 'sms-dot' }),
              h('span', { key: 'label', children: t('sync.label') }),
            ],
          }),
          open
            ? present(h(MenuSurface, {
              ref: menuRef,
              className: 'sms-menu',
              role: 'menu',
              style: menuStyle,
              children: [
                h('button', {
                  key: 'row',
                  type: 'button',
                  className: 'sms-row',
                  role: 'menuitemcheckbox',
                  'aria-checked': on,
                  onClick: toggle,
                  children: [
                    h('span', { key: 'c', className: 'sms-check', children: on ? '\u2713' : '' }),
                    h('span', {
                      key: 'b',
                      className: 'sms-body',
                      children: [
                        h('span', { key: 't', className: 'sms-title', children: t('sync.label') }),
                        h('span', { key: 'd', className: 'sms-desc', children: t('sync.desc') }),
                      ],
                    }),
                  ],
                }),
                // Stated before the user commits, not after: a pick is suspended,
                // never deleted, so this says so instead of warning about loss.
                pinned > 0
                  ? h('div', {
                    key: 'pinned',
                    className: 'sms-warn',
                    children: on
                      ? t('sync.pinnedOn').replace('{n}', String(pinned))
                      : t('sync.pinnedOff').replace('{n}', String(pinned)),
                  })
                  : null,
              ],
            }), primitives !== undefined)
            : null,
        ],
      })
    }

    /* ------------------------------------------------------------------ *
     * Child model seat
     * ------------------------------------------------------------------ */

    /**
     * Model control for one delegated Session. Shows the route actually in
     * force, lets the user pin an override, or clear it to follow the parent.
     */
    function ChildModelSeat({ sessionId, useSession, useSessions, t }) {
      const subagent = useSession((state) => state.subagent)
      // Composer seats expose `useSession` (this Session's snapshot) and
      // `useSessions` (the whole sessions slice). There is no `useProjection`
      // prop — reading it crashed the seat and retired the whole control row.
      const selection = useSessions((state) => state.projectionsBySession?.[sessionId]?.values?.modelSelection)
      // While the switch is on, this child runs on its parent's route — which is
      // the parent's projection, not this Session's own last request. Reading the
      // parent here is what keeps the seat from naming a model that is not in
      // force between "switch ticked" and "child ran once".
      const parentSelection = useSessions((state) => {
        const parentId = subagent?.address?.parentSessionId
        return parentId === undefined ? undefined : state.projectionsBySession?.[parentId]?.values?.modelSelection
      })
      const [prefs, setPrefs] = react.useState(undefined)
      const [open, setOpen] = react.useState(false)
      const [effortOpen, setEffortOpen] = react.useState(false)
      const [query, setQuery] = react.useState('')
      const [menuStyle, setMenuStyle] = react.useState(MEASURE_STYLE)
      const [catalog, setCatalog] = react.useState(readCatalog)
      const triggerRef = react.useRef(null)
      const menuRef = react.useRef(null)

      // Subscribing in an effect rather than through `useSyncExternalStore`
      // keeps a plain state value authoritative here: the store only ever
      // notifies, and a re-read never hands React a fresh array identity.
      react.useEffect(() => onCatalog(() => setCatalog(readCatalog())), [])

      react.useEffect(() => {
        void readCatalog()
      }, [])

      react.useEffect(() => {
        let cancelled = false
        void callBridge({ op: 'read' }).then((value) => {
          if (!cancelled) setPrefs(value)
        })
        return () => {
          cancelled = true
        }
      }, [sessionId])

      react.useEffect(() => {
        if (!open) {
          setMenuStyle(MEASURE_STYLE)
          return undefined
        }
        const menu = menuRef.current
        const trigger = triggerRef.current
        if (menu === null || trigger === null) return undefined
        setMenuStyle(measure(menu, trigger))
        return dismissOn(menu, trigger, () => setOpen(false))
      }, [open, query])

      if (subagent === null || subagent === undefined) return null

      const parentSessionId = subagent?.address?.parentSessionId
      const parentSynced = parentSessionId !== undefined && prefs?.sync?.[parentSessionId] === true
      const manual = prefs?.manual?.[sessionId]
      const inherited = selection?.next ?? selection?.lastUsed
      const parentRoute = parentSelection?.next ?? parentSelection?.lastUsed
      // A synced parent suspends per-child picks: the switch is a mode, not a
      // layer, so while it is on this seat must not offer a control whose value
      // would be ignored. Everything below stays rendered but inert.
      const locked = parentSynced
      // While locked the next request uses the parent's route, so that is what
      // must be named. `inherited` is only a fallback for a parent whose route
      // is not loaded yet, and the pick is never shown: it is not what runs.
      const shown = locked ? parentRoute ?? inherited : manual ?? inherited
      const label = shown === undefined
        ? t('child.unknown')
        : `${shown.provider} / ${shown.model}`
      // The badge describes the source that actually governs the next request,
      // which is why a dormant pick reads as "following" rather than "pinned".
      const source = locked ? 'follow' : manual !== undefined ? 'manual' : 'native'

      // The effort list belongs to the model that will actually serve the next
      // request, so it is looked up in the catalog rather than remembered from a
      // previous pick. `catalog` is still loading on first paint: no list yet.
      const shownModel = shown === undefined
        ? undefined
        : catalog
          .find((group) => group.id === shown.provider)
          ?.models.find((model) => model.id === shown.model)
      const efforts = shownModel?.reasoning?.efforts ?? EMPTY_EFFORTS
      const currentEffort = shown?.reasoningEffort
      const effortLabel = currentEffort === undefined
        ? efforts.find((effort) => effort.id === shownModel?.reasoning?.defaultEffort)?.name ?? t('child.effort.default')
        : efforts.find((effort) => effort.id === currentEffort)?.name ?? currentEffort
      const hasEfforts = efforts.length > 0

      // A pinned model keeps the effort the user chose with it; following or
      // native means the route comes from elsewhere, so the pick travels with
      // the route instead of being stored separately.
      const applyEffort = async (effortId) => {
        if (shown === undefined || locked) return
        const route = {
          provider: shown.provider,
          model: shown.model,
          ...effortId === undefined ? {} : { reasoningEffort: effortId },
          ...parentSessionId === undefined ? {} : { parent: parentSessionId },
        }
        const value = await callBridge({ op: 'setManual', sessionId, route })
        if (value !== undefined) setPrefs(value)
        setEffortOpen(false)
      }

      const groups = catalog
      const needle = query.trim().toLowerCase()
      const visible = groups
        .map((group) => ({
          ...group,
          models: needle === ''
            ? group.models
            : group.models.filter((model) => `${model.name ?? ''} ${model.id}`.toLowerCase().includes(needle)),
        }))
        .filter((group) => group.models.length > 0)

      const pick = async (provider, model, effort) => {
        if (locked) return
        // Switching models drops a picked effort unless the new model also
        // advertises it: effort ids are adapter-owned, so the old one may be
        // rejected. `effort` is the new model's own advertised default.
        const route = {
          provider,
          model,
          ...effort === undefined ? {} : { reasoningEffort: effort },
          ...parentSessionId === undefined ? {} : { parent: parentSessionId },
        }
        const value = await callBridge({ op: 'setManual', sessionId, route })
        if (value !== undefined) setPrefs(value)
        setOpen(false)
        setQuery('')
        setEffortOpen(false)
      }

      // Clearing the override is a step towards picking one, not a completion:
      // keep the panel open so the model list is immediately usable.
      const clearOverride = async () => {
        if (locked) return
        const value = await callBridge({ op: 'setManual', sessionId, route: null })
        if (value !== undefined) setPrefs(value)
      }

      return h('div', {
        className: 'sms-root',
        children: [
          h('button', {
            key: 'trigger',
            ref: triggerRef,
            type: 'button',
            className: 'sms-trigger',
            'aria-expanded': open,
            'aria-label': t('child.aria'),
            title: t('child.title'),
            onClick: () => setOpen((value) => !value),
            children: [
              h('span', { key: 'dot', className: 'sms-dot' }),
              h('span', { key: 'text', className: 'sms-modelText', children: label }),
            ],
          }),
          open
            ? present(h(MenuSurface, {
              ref: menuRef,
              className: 'sms-menu',
              role: 'menu',
              style: menuStyle,
              'data-locked': locked ? 'true' : 'false',
              children: [
                h('div', {
                  key: 'head',
                  className: 'sms-head',
                  children: [
                    h('div', {
                      key: 'm',
                      className: 'sms-model',
                      children: [
                        h('span', { key: 'v', className: 'sms-modelText', children: label }),
                        h('span', {
                          key: 's',
                          className: 'sms-badge',
                          children: source === 'manual'
                            ? t('child.source.manual')
                            : source === 'follow'
                              ? t('child.source.follow')
                              : t('child.source.native'),
                        }),
                      ],
                    }),
                    h('div', {
                      key: 'hint',
                      className: locked ? 'sms-locked' : 'sms-hint',
                      children: locked
                        ? t('child.locked')
                        : source === 'manual'
                          ? t('child.hint.manual')
                          : source === 'follow'
                            ? t('child.hint.follow')
                            : t('child.hint.native'),
                    }),
                  ],
                }),
                h('button', {
                  key: 'follow',
                  type: 'button',
                  className: 'sms-row',
                  role: 'menuitemradio',
                  'aria-checked': manual === undefined && parentSynced,
                  disabled: locked,
                  onClick: () => void clearOverride(),
                  children: [
                    h('span', { key: 'c', className: 'sms-check', children: manual === undefined ? '\u2713' : '' }),
                    h('span', {
                      key: 'b',
                      className: 'sms-body',
                      children: [
                        h('span', { key: 't', className: 'sms-title', children: t('child.follow') }),
                        h('span', { key: 'd', className: 'sms-desc', children: t('child.followDesc') }),
                      ],
                    }),
                  ],
                }),
                h('div', { key: 'sep', className: 'sms-sep' }),
                h('div', {
                  key: 'search',
                  className: 'sms-head',
                  children: h('input', {
                    className: 'sms-search',
                    type: 'search',
                    value: query,
                    disabled: locked,
                    placeholder: t('child.search'),
                    'aria-label': t('child.search'),
                    onChange: (event) => setQuery(event.target.value),
                  }),
                }),
                h('div', {
                  key: 'list',
                  className: 'sms-list',
                  children: visible.length === 0
                    ? [h('div', { key: 'none', className: 'sms-empty', children: t('child.noModels') })]
                    : visible.flatMap((group) => [
                      h('div', { key: `g:${group.id}`, className: 'sms-group', children: group.name ?? group.id }),
                      ...group.models.map((model) => {
                        const selected = shown !== undefined && shown.provider === group.id && shown.model === model.id
                        return h('button', {
                          key: `${group.id}:${model.id}`,
                          type: 'button',
                          className: 'sms-opt',
                          role: 'menuitemradio',
                          'aria-selected': selected,
                          disabled: locked,
                          onClick: () => void pick(group.id, model.id, model.reasoning?.defaultEffort),
                          children: [
                            h('span', { key: 'c', className: 'sms-check', children: selected ? '\u2713' : '' }),
                            h('span', { key: 'n', className: 'sms-modelText', children: model.name ?? model.id }),
                          ],
                        })
                      }),
                    ]),
                }),
                h('div', { key: 'sep2', className: 'sms-sep' }),
                // Fixed footer: the model list above scrolls, this block never
                // does. Effort is a property of the model, so it sits beside the
                // picker instead of behind a second-level panel.
                h('div', {
                  key: 'foot',
                  className: 'sms-foot',
                  children: [
                    h('button', {
                      key: 'effort',
                      type: 'button',
                      className: 'sms-effortBtn',
                      'aria-expanded': effortOpen,
                      'aria-label': t('child.effort.aria'),
                      disabled: !hasEfforts || locked,
                      onClick: () => setEffortOpen((value) => !value),
                      children: [
                        h('span', { key: 'k', className: 'sms-effortLabel', children: t('child.effort.label') }),
                        h('span', { key: 'v', className: 'sms-effortValue', children: hasEfforts ? effortLabel : t('child.effort.none') }),
                        hasEfforts ? h('span', { key: 'c', className: 'sms-chevron', children: effortOpen ? '\u25b4' : '\u25be' }) : null,
                      ],
                    }),
                    effortOpen && hasEfforts
                      ? h('div', {
                        key: 'efforts',
                        className: 'sms-effortList',
                        role: 'group',
                        children: efforts.map((effort) => h('button', {
                          key: `e:${effort.id}`,
                          type: 'button',
                          className: 'sms-effortOpt',
                          role: 'menuitemradio',
                          'aria-selected': effort.id === currentEffort,
                          onClick: () => void applyEffort(effort.id),
                          children: [
                            h('span', { key: 'c', className: 'sms-check', children: effort.id === currentEffort ? '\u2713' : '' }),
                            h('span', { key: 'n', className: 'sms-modelText', children: effort.name ?? effort.id }),
                          ],
                        })),
                      })
                      : null,
                  ],
                }),
                h('div', { key: 'notice', className: 'sms-hint', children: t('child.notice') }),
              ],
            }), primitives !== undefined)
            : null,
        ],
      })
    }

    /* ------------------------------------------------------------------ *
     * Dictionaries
     * ------------------------------------------------------------------ */

    const NS = 'subagentModelSync'

    const zh = {
      'sync.label': '同步子代理',
      'sync.title': '让子代理跟随主会话的模型',
      'sync.aria': '同步子代理模型',
      'sync.desc': '开启后，主会话切换模型时，所有子代理与团队队员都会跟着切换；关闭时不做任何改动。',
      'sync.pinnedOff': '有 {n} 个子代理使用单独模型。开启同步后，它们在下次请求时会被覆盖。',
      'sync.pinnedOn': '同步已开启，{n} 个子代理的单独指定将在下次请求后被覆盖。',
      'child.aria': '子代理模型',
      'child.title': '查看或指定这个子代理使用的模型',
      'child.unknown': '未记录模型',
      'child.follow': '跟随主会话',
      'child.followDesc': '清除手动指定，恢复为跟随上级。',
      'child.source.manual': '手动指定',
      'child.source.follow': '跟随中',
      'child.source.native': '原生',
      'child.hint.manual': '这个子代理固定使用你指定的模型；主会话切换不会影响它。',
      'child.hint.follow': '这个子代理跟随上级会话的模型。',
      'child.hint.native': '未做任何改动，使用官方原本的路由。',
      'child.locked': '主会话已开启同步子代理，当前不可单独指定；需先关闭同步。',
      'child.search': '搜索模型…',
      'child.noModels': '暂无可用模型',
      'child.effort.label': '思考强度',
      'child.effort.aria': '思考强度',
      'child.effort.default': '默认',
      'child.effort.none': '该模型不可调',
      'child.notice': '手动指定模型后，下一次请求生效；正在运行的步骤不会被打断。',
    }

    const en = {
      'sync.label': 'Sync subagents',
      'sync.title': 'Make subagents follow this session model',
      'sync.aria': 'Sync subagent model',
      'sync.desc': 'When on, every subagent and teammate follows this session when its model changes. When off, nothing is modified.',
      'sync.pinnedOff': '{n} subagent(s) use their own model. With sync on, they are overridden on their next request.',
      'sync.pinnedOn': 'Sync is on; {n} per-subagent choice(s) will be overridden on the next request.',
      'child.aria': 'Subagent model',
      'child.title': 'View or pin the model this subagent uses',
      'child.unknown': 'no model recorded',
      'child.follow': 'Follow parent session',
      'child.followDesc': 'Clear the override and follow the parent again.',
      'child.source.manual': 'pinned',
      'child.source.follow': 'following',
      'child.source.native': 'native',
      'child.hint.manual': 'This subagent always uses the model you pinned; parent switches do not affect it.',
      'child.hint.follow': 'This subagent follows the parent session model.',
      'child.hint.native': 'Untouched: the official route applies.',
      'child.locked': 'Sync is on for the parent session; a per-subagent model needs sync turned off first.',
      'child.search': 'Search models…',
      'child.noModels': 'No models available',
      'child.effort.label': 'Thinking effort',
      'child.effort.aria': 'Thinking effort',
      'child.effort.default': 'default',
      'child.effort.none': 'not adjustable',
      'child.notice': 'A pinned model applies to the next request; a running step is never interrupted.',
    }

    /**
     * Bind a namespace dictionary to the active locale.
     * @param ctx - client root.
     * @returns translator.
     */
    function translator(ctx) {
      const dict = () => (ctx.locale.getLocale().active === 'zh' ? zh : en)
      return (key) => dict()[key] ?? key
    }

    /* ------------------------------------------------------------------ *
     * Plugin body
     * ------------------------------------------------------------------ */

    const inject = ['slots', 'locale', 'sessions']

    /**
     * Slot entry. A root Session gets the sync switch; a delegated Session gets
     * its own model seat. The branch lives here so each child component keeps a
     * static hook order of its own.
     *
     * Everything is defensive on purpose: a slot entry that throws is retired
     * for good by the renderer, and this seat is the only member of the
     * composer's right-hand control row — one throw takes the whole row with it.
     * A missing hook prop therefore renders nothing instead of crashing.
     * @param props - slot standard props plus the bound translator.
     */
    function Seat(props) {
      const { t, useSession } = props
      if (typeof useSession !== 'function') return null
      const isChild = useSession((state) => state.subagent !== null && state.subagent !== undefined)
      // `jsx()`/`jsxs()` take (type, props, key) — children belong INSIDE props.
      // Passing them as a third argument renders an empty wrapper instead.
      return h('div', {
        'data-sms-seat': isChild ? 'child' : 'root',
        style: { display: 'contents' },
        children: isChild ? h(ChildModelSeat, { ...props, t }) : h(SyncSwitch, { ...props, t }),
      })
    }

    /**
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'subagent-model-sync: dictionaries')
      const t = translator(ctx)

      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'subagent-model-sync',
        order: 10,
        locale: NS,
      }, (props) => h(Seat, { ...props, t })))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
