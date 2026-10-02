/**
 * dsh-mobile-audit — render the Web GUI at a phone viewport and MEASURE what is wrong.
 *
 * Why measure instead of eyeballing a screenshot: "looks unoptimized" is not actionable.
 * The numbers below turn it into a defect list — horizontal overflow, which panes stay
 * visible, whether the composer sits inside the visual viewport, and how many tap targets
 * are below the 44px touch minimum. Screenshots are attached for the human, but the
 * verdict comes from the numbers.
 *
 * Playwright is resolved from the checkout (pnpm dependency), never hard-coded.
 *
 * Usage: node ~/.dsh/bin/dsh-mobile-audit.mjs [port]
 *        writes $HOME/.dsh/share/mobile-<port>-<viewport>.png and prints a report
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

// The checkout that provides playwright and the client bundles. Override with
// DSH_CHECKOUT; the default mirrors this machine's layout without naming a user.
const CHECKOUT = process.env.DSH_CHECKOUT ?? join(homedir(), 'Developer', 'deepseek-harness')
const PORT = process.argv[2] ?? '3080'
const OUT_DIR = join(homedir(), '.dsh', 'share')
mkdirSync(OUT_DIR, { recursive: true })

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
  console.error('dsh-mobile-audit: playwright not resolvable from the checkout; run pnpm install there')
  process.exit(1)
}

// Token from the live host log: it is the only way in, and it is per-process.
const log = readFileSync(join(homedir(), '.dsh', 'logs', 'web.out.log'), 'utf8')
const match = log.match(/token=([A-Za-z0-9_-]{16,})/)
if (match === null) {
  console.error('dsh-mobile-audit: no launch token in ~/.dsh/logs/web.out.log (host not up, or started outside dsh-web-run)')
  process.exit(1)
}
const url = `http://127.0.0.1:${PORT}/?token=${match[1]}`

// A representative modern phone. Kept in the script so runs are comparable.
const PHONE = {
  name: 'iPhone-14-Pro',
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
}

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({
  viewport: PHONE.viewport,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: PHONE.isMobile,
  hasTouch: PHONE.hasTouch,
  userAgent: PHONE.userAgent,
})
const page = await context.newPage()
const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })
page.on('pageerror', e => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`))
page.on('requestfailed', r => consoleErrors.push(`requestfailed: ${r.url().slice(0, 120)}`))

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
// Let the boot kernel mount; the app is a client-plugin tree, not a single bundle.
await page.waitForTimeout(6000)

// Dismiss the preview/onboarding modal if present. Measuring the first screen only
// measures the modal; the real question is what the chat view looks like on a phone.
for (const label of ['继续', 'Continue', '知道了', '开始使用']) {
  const btn = page.getByRole('button', { name: label, exact: false }).first()
  if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
    await btn.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(1500)
    break
  }
}
// Close any right-hand panel the restored session state may have opened.
await page.keyboard.press('Escape').catch(() => {})
await page.waitForTimeout(1000)

const mounted = await page.evaluate(() => document.querySelector('#root')?.childElementCount > 0)
const report = await page.evaluate(() => {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const de = document.documentElement
  const all = [...document.querySelectorAll('*')]

  // Elements whose box extends past the right edge of the viewport.
  const overflowing = all
    .map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.right > vw + 1)
    .slice(0, 12)
    .map(({ el, r }) => ({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className ?? '').split(' ').filter(Boolean).slice(0, 2).join('.'),
      right: Math.round(r.right),
      width: Math.round(r.width),
    }))

  // Tap targets below the 44px minimum recommended by both Apple and Google.
  const smallTargets = all
    .filter(el => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'A')
    .map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44))
    .slice(0, 12)
    .map(({ el, r }) => ({
      label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24),
      w: Math.round(r.width), h: Math.round(r.height),
    }))

  // The composer is the one control a phone user cannot live without.
  const composer = document.querySelector('textarea, [contenteditable="true"]')
  const cr = composer?.getBoundingClientRect()

  // Panes: report each large block so it is obvious whether the desktop layout persisted.
  const panes = all
    .filter(el => ['ASIDE', 'NAV', 'MAIN', 'SECTION'].includes(el.tagName) || /sidebar|panel|frame/i.test(String(el.className ?? '')))
    .map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 80 && r.height > 80)
    .slice(0, 10)
    .map(({ el, r }) => ({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className ?? '').split(' ').filter(Boolean).slice(0, 2).join('.'),
      x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height),
    }))

  const px = v => `${Math.round(v)}px`
  const body = getComputedStyle(document.body)
  return {
    viewport: `${vw}x${vh}`,
    documentScrollWidth: de.scrollWidth,
    horizontalOverflow: de.scrollWidth > vw + 1,
    bodyFontSize: body.fontSize,
    mediaQueriesMatched: {
      maxWidth560: matchMedia('(max-width: 560px)').matches,
      maxWidth760: matchMedia('(max-width: 760px)').matches,
      pointerCoarse: matchMedia('(pointer: coarse)').matches,
    },
    composer: cr === undefined ? 'NOT FOUND' : { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height), bottom: Math.round(cr.bottom), insideViewport: cr.bottom <= vh + 1 },
    panes,
    overflowing,
    smallTargets,
  }
})

const shot = join(OUT_DIR, `mobile-${PORT}-${PHONE.name}.png`)
await page.screenshot({ path: shot, fullPage: false })

console.log(`mounted: ${mounted}`)
console.log(`console errors / failed requests: ${consoleErrors.length}`)
for (const e of consoleErrors.slice(0, 5)) console.log(`  - ${e}`)
console.log(JSON.stringify(report, null, 2))
console.log(`\nscreenshot: ${shot}`)

await browser.close()
process.exit(mounted && consoleErrors.length === 0 ? 0 : 1)
