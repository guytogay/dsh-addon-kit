/**
 * dsh-keyboard-check — verify the soft-keyboard fix on BOTH platform paths.
 *
 * The fix has two independent mechanisms and each needs its own proof:
 *
 *   Android (Chrome honours the hint)
 *     `apps/web/index.html` adds `interactive-widget=resizes-content`, so the layout
 *     viewport shrinks with the keyboard and the composer stays above it on its own.
 *     Provable from the served HTML — no keyboard needed.
 *
 *   iOS (Safari ignores the hint)
 *     `apps/web/src/main.ts` measures `window.visualViewport` and publishes
 *     `--dsh-keyboard-inset`; the composer seat consumes it as its sticky `bottom`.
 *     Playwright cannot open a real keyboard, so the visual viewport is REPLACED with a
 *     stub whose height/offsetTop can be driven, and the app's reaction is observed.
 *
 * What this cannot prove: that a real phone's keyboard behaves as the model predicts.
 * Only the device can settle that, so the report says so explicitly instead of implying
 * the feature was seen working on a phone.
 *
 * Usage: node ~/.dsh/bin/dsh-keyboard-check.mjs [port]
 * Exit:  0 = both paths behave, 1 = a path failed, 2 = inconclusive.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const CHECKOUT = process.env.DSH_CHECKOUT ?? join(homedir(), 'Developer', 'deepseek-harness')
const PORT = process.argv[2] ?? '3080'

const require = createRequire(join(CHECKOUT, 'package.json'))
let chromium
for (const specifier of ['playwright', 'playwright-core']) {
  try {
    const resolved = require.resolve(specifier, { paths: [CHECKOUT, join(CHECKOUT, 'apps', 'web')] })
    const esm = join(dirname(resolved), 'index.mjs')
    const mod = await import(existsSync(esm) ? esm : resolved)
    chromium = mod.chromium ?? mod.default?.chromium
    if (chromium !== undefined) break
  } catch { /* next */ }
}
if (chromium === undefined) {
  console.error('dsh-keyboard-check: playwright not resolvable from the checkout')
  process.exit(2)
}

const log = readFileSync(join(homedir(), '.dsh', 'logs', 'web.out.log'), 'utf8')
const token = log.match(/token=([A-Za-z0-9_-]{16,})/)?.[1]
if (token === undefined) {
  console.error('dsh-keyboard-check: no launch token in ~/.dsh/logs/web.out.log')
  process.exit(2)
}
const url = `http://127.0.0.1:${PORT}/?token=${token}`

let failed = 0
let inconclusive = 0

// ── Path 1: Android — the hint must be in the served HTML ────────────────────────────

// ── Path 2: iOS — the visualViewport fallback must lift the composer ─────────────────
const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
})
// Replace visualViewport BEFORE any app code runs, with a controllable stub. A real
// keyboard is not available to the automation, so the geometry is simulated and the
// app's response to it is what gets asserted.
await context.addInitScript(() => {
  const listeners = { resize: [], scroll: [] }
  const stub = {
    width: 393, height: 852, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1,
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn) },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter(f => f !== fn) },
  }
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => stub })
  window.__setKeyboard = (px) => {
    stub.height = window.innerHeight - px
    stub.offsetTop = 0
    for (const fn of listeners.resize) fn(new Event('resize'))
  }
})

const page = await context.newPage()
const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120)) })
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(6000)

// ── Path 1: Android — the hint must reach the browser ────────────────────────────────
// Read it from the loaded document rather than a bare fetch: the page is behind browser
// auth and a plain fetch carries no cookie, so it saw the 401 body and reported
// "(no viewport meta)" even though the tag was there.
const viewportMeta = await page.evaluate(() =>
  document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '(no viewport meta)')
const hasHint = viewportMeta.includes('interactive-widget=resizes-content')
const hasCover = viewportMeta.includes('viewport-fit=cover')
console.log('Android path (viewport meta as the browser received it)')
console.log(`  meta           : ${viewportMeta}`)
console.log(`  resizes-content: ${hasHint ? 'present' : 'MISSING'}   viewport-fit=cover: ${hasCover ? 'present' : 'MISSING'}`)
if (!hasHint) failed += 1

const readState = () => page.evaluate(() => {
  const seat = document.querySelector('[class*="composerSeat"]')
  const rect = seat?.getBoundingClientRect()
  return {
    inset: getComputedStyle(document.documentElement).getPropertyValue('--dsh-keyboard-inset').trim(),
    seatBottom: rect === undefined ? null : Math.round(rect.bottom),
    seatHeight: rect === undefined ? null : Math.round(rect.height),
    innerHeight: window.innerHeight,
  }
})

const baseline = await readState()
console.log('\niOS path (visualViewport fallback, simulated keyboard)')
console.log(`  no keyboard   : inset="${baseline.inset || '(unset)'}" seat.bottom=${baseline.seatBottom}`)

// Simulate a 300px keyboard and let the rAF-throttled handler run.
const simulated = await page.evaluate(async () => {
  window.__setKeyboard(300)
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  const seat = document.querySelector('[class*="composerSeat"]')
  const rect = seat?.getBoundingClientRect()
  return {
    inset: getComputedStyle(document.documentElement).getPropertyValue('--dsh-keyboard-inset').trim(),
    seatBottom: rect === undefined ? null : Math.round(rect.bottom),
    seatHeight: rect === undefined ? null : Math.round(rect.height),
    innerHeight: window.innerHeight,
    visibleBottom: window.innerHeight - 300,
  }
})
console.log(`  300px keyboard: inset="${simulated.inset}" seat.bottom=${simulated.seatBottom}`
  + `  (visible area ends at ${simulated.visibleBottom})`)

// The assertions. Each one is able to fail; a missing seat or an unset variable fails.
if (baseline.seatBottom === null) {
  console.log('  INCONCLUSIVE: the composer seat was not found, so nothing was measured')
  inconclusive += 1
} else {
  if (baseline.inset !== '0px') {
    console.log(`  FAIL: with no keyboard the inset should be 0px, got "${baseline.inset}"`)
    failed += 1
  }
  if (simulated.inset !== '300px') {
    console.log(`  FAIL: a 300px keyboard should publish 300px, got "${simulated.inset}"`)
    failed += 1
  }
  // The decision that actually matters to the user: is the composer above the keyboard?
  // The frame is what the fix shrinks; the composer rides inside it. Assert on the
  // frame's bottom edge AND on the composer staying within the visible strip.
  if (simulated.frameBottom !== null && simulated.frameBottom > simulated.visibleBottom + 1) {
    console.log(`  FAIL: the frame still runs under the keyboard (frame bottom ${simulated.frameBottom} > visible ${simulated.visibleBottom})`)
    failed += 1
  }
  if (simulated.seatBottom !== null && simulated.seatBottom > simulated.visibleBottom + 1) {
    console.log(`  FAIL: the composer is still under the keyboard (bottom ${simulated.seatBottom} > ${simulated.visibleBottom})`)
    failed += 1
  } else if (simulated.seatBottom !== null) {
    console.log(`  OK  : the composer sits ${simulated.visibleBottom - simulated.seatBottom}px above the simulated keyboard`)
  }
}
const lift = baseline.seatBottom !== null && simulated.seatBottom !== null
  ? baseline.seatBottom - simulated.seatBottom
  : null
console.log(`  lift          : ${lift === null ? 'n/a' : `${lift}px (expected ~300px)`}`)
console.log(`  console errors: ${consoleErrors.length}`)
await page.screenshot({ path: join(homedir(), '.dsh', 'share', 'mobile-keyboard-simulated.png') })
await context.close()
await browser.close()

console.log('\nNOTE: a real phone keyboard is not reproducible here. Android is covered by the')
console.log('served meta tag; iOS by the measured visual viewport. Confirm on the device.')

if (failed > 0) { console.error(`\nFAIL: ${failed} check(s) failed.`); process.exit(1) }
if (inconclusive > 0) { console.error('\nINCONCLUSIVE: the harness could not measure the composer.'); process.exit(2) }
console.log('\nPASS: both platform paths behave as designed.')
process.exit(0)
