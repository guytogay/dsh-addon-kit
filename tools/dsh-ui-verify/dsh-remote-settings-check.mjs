/**
 * dsh-remote-settings-check — prove the settings pages work from a NON-loopback address.
 *
 * Why this exists (2026-10-02): DSH decides settings persistence from the browser's address
 * bar (`client/connection` → `isLoopback` → `ui-settings` picks 'host' vs 'memory'). On a
 * plain 0.2.0-rc.2 only `localhost` / `127.x` / `[::1]` pass, so every LAN, tailnet or
 * MagicDNS page shows "settings are unavailable in this browser" on Settings → Models —
 * which is every phone. `patch-remote-settings.mjs` widens that expression; this script is
 * the gate that proves the widening actually reaches a real browser.
 *
 * Why it has assertions instead of just looking for the error string: the first two versions
 * of this check reported "no error" on BOTH paths and were simply wrong — the click never
 * reached the settings page (an onboarding dialog covered it) and the pass condition was a
 * loose regex. A check that cannot fail is not a check, so this one reports INCONCLUSIVE
 * when it cannot prove it reached the page, rather than reporting success.
 *
 * Usage: node ~/.dsh/bin/dsh-remote-settings-check.mjs
 * Exit:  0 = every non-loopback path reached the models page, 1 = at least one failed,
 *        2 = inconclusive (page never reached).
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

// The checkout that provides playwright and the client bundles. Override with
// DSH_CHECKOUT; the default mirrors this machine's layout without naming a user.
const CHECKOUT = process.env.DSH_CHECKOUT ?? join(homedir(), 'Developer', 'deepseek-harness')
const DSH_URL = join(homedir(), '.dsh', 'bin', 'dsh-url')

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
  console.error('dsh-remote-settings-check: playwright not resolvable from the checkout')
  process.exit(2)
}

const ERROR_RE = /加载提供商目录失败|settings are unavailable/i
const CONTENT_RE = /提供商|Provider/
const SETTINGS_NAV_RE = /通用设置|General/
// Only non-loopback paths are interesting: loopback always worked, so testing it would be
// a check that cannot fail.
const MODES = ['lan', 'tailnet', 'https'].filter(mode => {
  try { return execFileSync(DSH_URL, [mode], { encoding: 'utf8' }).trim() !== '' } catch { return false }
})

const browser = await chromium.launch({ channel: 'chrome' })
let failures = 0
let inconclusive = 0

for (const mode of MODES) {
  const url = execFileSync(DSH_URL, [mode], { encoding: 'utf8' }).trim()
  const context = await browser.newContext({
    // Deliberately a DESKTOP viewport, not a phone one. This check is about whether the
    // settings surface is permitted for a non-loopback address, not about the phone layout:
    // at 393px the settings entry sits behind the sidebar drawer, so an earlier version of
    // this script reported INCONCLUSIVE on every path. The mobile layout has its own check
    // (dsh-mobile-audit.mjs).
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120)) })

  let reachedModels = false
  let errorSeen = false
  let contentSeen = false
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    await page.waitForTimeout(6000)
    for (const label of ['继续', 'Continue']) {
      const button = page.getByRole('button', { name: label, exact: false }).first()
      if (await button.count() > 0 && await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 4000 }).catch(() => {})
        await page.waitForTimeout(2000)
        break
      }
    }
    const gear = page.locator('[aria-label="设置"], [aria-label="Settings"]').first()
    if (await gear.count() > 0) await gear.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(3000)
    const navReached = await page.evaluate(re => new RegExp(re).test(document.body.innerText), SETTINGS_NAV_RE.source)
    const models = page.locator('button:has-text("模型"), [role="tab"]:has-text("模型"), a:has-text("模型"), button:has-text("Models")').first()
    if (navReached && await models.count() > 0) {
      await models.click({ timeout: 5000 }).catch(() => {})
      reachedModels = true
      await page.waitForTimeout(4000)
    }
    const body = await page.evaluate(() => document.body.innerText)
    errorSeen = ERROR_RE.test(body)
    contentSeen = CONTENT_RE.test(body)
    if (errorSeen) {
      const snippet = (body.match(/.{0,40}(加载提供商目录失败|settings are unavailable).{0,60}/) ?? [''])[0]
      console.log(`  text: ${snippet.replace(/\s+/g, ' ')}`)
    }
  } catch (error) {
    console.log(`${mode.padEnd(14)} navigation failed: ${String(error).slice(0, 90)}`)
  }

  const verdict = !reachedModels || (!errorSeen && !contentSeen)
    ? 'INCONCLUSIVE'
    : errorSeen ? 'FAIL' : 'PASS'
  if (verdict === 'FAIL') failures += 1
  if (verdict === 'INCONCLUSIVE') inconclusive += 1
  console.log(`${mode.padEnd(14)} reached-models=${reachedModels} content=${contentSeen} error=${errorSeen} console-errors=${consoleErrors.length} → ${verdict}`)
  await context.close()
}

await browser.close()
if (failures > 0) {
  console.error(`\n${failures} path(s) still show the settings error: the remote-settings patch is missing or did not rebuild.`)
  process.exit(1)
}
if (inconclusive > 0) {
  console.error('\nINCONCLUSIVE: a path never reached the models page, so it proves nothing. Fix the harness before trusting a pass.')
  process.exit(2)
}
console.log('\nPASS: every non-loopback path renders the settings models page.')
process.exit(0)
