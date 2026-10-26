/**
 * Runtime self-check for the composer seat — paste into the DevTools console.
 *
 * The jsdom tests in `test/render.test.js` prove the component's logic. They
 * cannot prove what the shell actually mounted, because the real renderer
 * supplies its own props and its own primitives. This snippet closes that gap
 * by reading the live DOM and reporting the facts a reviewer would otherwise
 * have to eyeball.
 *
 * It never writes preferences and never changes the route: the panel it opens
 * is closed again before returning.
 *
 * Usage:
 *   1. open the Session you want to inspect (main, or a subagent)
 *   2. DevTools → Console → paste this whole file
 *   3. read the returned object
 *
 * How to judge the result:
 *
 *   kind        "root"  = main Session switch
 *               "child" = delegated Session seat
 *               null-ish + ok:false = the seat never mounted
 *
 *   shown       the route the trigger names. On a **child** with sync on this
 *               MUST equal the parent's current route. If it equals the model
 *               you pinned earlier, the dormant-pick display bug is back.
 *
 *   locked      true when the parent has sync on. In that state every control
 *               must be inert: `allDisabled` must be true.
 *
 *   lockNotice  the explanation shown instead of the source hint. Must be
 *               non-null while `locked` is true.
 *
 *   warn        only on a root Session: how many picks the switch would
 *               suspend. Must survive toggling the switch.
 *
 * @returns a plain object, printed by the console.
 */
(() => {
  const seat = document.querySelector('[data-sms-seat]')
  if (seat === null) {
    return { ok: false, reason: 'seat not found — plugin may not be loaded in this shell' }
  }

  const kind = seat.dataset.smsSeat
  const trigger = seat.querySelector('button')
  const shownBeforeOpen = trigger === null ? null : trigger.textContent.trim()

  // The panel is portalled to <body>, so it is looked up globally. Remember
  // whether we opened it so the check leaves no visible change behind.
  const alreadyOpen = document.querySelector('.sms-menu') !== null
  if (!alreadyOpen && trigger !== null) trigger.click()

  const menu = document.querySelector('.sms-menu')
  const options = [...document.querySelectorAll('.sms-opt')]
  const result = {
    ok: true,
    kind,
    shown: shownBeforeOpen,
    panelRendered: menu !== null,
    locked: menu === null ? null : menu.dataset.locked === 'true',
    lockNotice: document.querySelector('.sms-locked')?.textContent?.trim() ?? null,
    warn: document.querySelector('.sms-warn')?.textContent?.trim() ?? null,
    modelOptions: options.length,
    allDisabled: options.length > 0 ? options.every((node) => node.disabled) : null,
    effortDisabled: (() => {
      const button = document.querySelector('.sms-foot button')
      return button === null ? null : button.disabled
    })(),
    searchDisabled: (() => {
      const input = document.querySelector('.sms-search')
      return input === null ? null : input.disabled
    })(),
  }

  // Undo the open so the check is side-effect free: the panel closes on an
  // outside click, which is exactly what the component listens for.
  if (!alreadyOpen) {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  }

  return result
})()
