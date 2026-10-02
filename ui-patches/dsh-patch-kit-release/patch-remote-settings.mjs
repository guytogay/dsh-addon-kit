#!/usr/bin/env node
/**
 * patch-remote-settings.mjs — let a remotely-connected browser use the settings pages.
 *
 * The problem it solves (measured 2026-10-02): DSH decides whether a page may persist
 * settings purely from the browser's address bar. `client/connection` computes
 *
 *   isLoopback: transport?.ownsHost === true || pageLocation === undefined
 *               || isLoopbackHostname(pageLocation.hostname)
 *
 * and `isLoopbackHostname` accepts only `localhost`, `[::1]` and 127/8. `ui-settings`
 * then picks its persistence mode from that flag (`host` vs `memory`), and in `memory`
 * the describe mirror starts at `status: 'unavailable'` and never loads — so
 * Settings → Models shows "settings are unavailable in this browser" for every
 * LAN / tailnet / MagicDNS address, i.e. on every phone.
 *
 * This appends the configured hostnames to that one expression, so a browser reaching
 * the host over the tailnet counts as local for the settings surface.
 *
 * Why a runtime-argument script rather than a static .patch file: the LAN address of a
 * laptop changes with the network, so the hosts must not be frozen into a patch library.
 * Pass them per machine; anything already present is skipped, so re-running is safe.
 *
 * Why the SOURCE file rather than the built `lib/client.js`: a build artifact patch is
 * erased by the next `pnpm run build`, which this machine runs on every upgrade. Patching
 * source keeps the change inside the existing reapply-local-patches + dsh-upgrade gate.
 *
 * Deliberately NOT patching `isLoopbackHostname` itself: that predicate is shared with the
 * `/api` Host fence (`api-request-trust.ts`), and widening it there would enlarge the fence
 * for every caller. Only the settings-relevant derived flag is widened.
 *
 * Usage:
 *   node patch-remote-settings.mjs <checkout-root> <host> [more hosts...]
 *   node patch-remote-settings.mjs --check <checkout-root> [host...]   # report only
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MARKER = 'dsh-remote-settings'
const TARGET = 'packages/client/connection/src/client/index.ts'

const argv = process.argv.slice(2)
const checkOnly = argv[0] === '--check'
const [root, ...hosts] = checkOnly ? argv.slice(1) : argv

if (root === undefined || hosts.length === 0) {
  console.error(`usage: ${MARKER} ${checkOnly ? '--check ' : ''}<checkout-root> <host> [more hosts...]`)
  process.exit(2)
}

const target = join(root, TARGET)
let source
try {
  source = readFileSync(target, 'utf8')
} catch (error) {
  console.error(`ABORT: cannot read ${target}: ${error.message}`)
  process.exit(1)
}

const lines = source.split('\n')
const index = lines.findIndex(line => line.includes('isLoopback:') && line.includes('pageLocation'))
if (index === -1) {
  console.error(`ABORT: no isLoopback/pageLocation line in ${TARGET}; upstream changed shape.`)
  console.error('  Find the current expression before widening it.')
  process.exit(1)
}

const original = lines[index]
let updated = original
const added = []
for (const host of hosts) {
  if (updated.includes(`'${host}'`) || updated.includes(`"${host}"`)) continue
  if (!updated.trimEnd().endsWith(',')) {
    console.error('ABORT: the isLoopback line no longer ends with a comma; refusing to guess.')
    process.exit(1)
  }
  // Append before the object literal's trailing comma so the expression stays valid.
  updated = `${updated.trimEnd().slice(0, -1)} || pageLocation.hostname === ${JSON.stringify(host)},`
  added.push(host)
}

if (added.length === 0) {
  console.log(`already applied (${MARKER}): ${hosts.length} host(s) present`)
  process.exit(0)
}

if (checkOnly) {
  console.log(`would add: ${added.join(', ')}`)
  process.exit(0)
}

lines[index] = updated
// Leave a marker line above so the change is greppable and attributable.
if (!source.includes(MARKER)) {
  const indent = (original.match(/^\s*/) ?? [''])[0]
  lines.splice(index, 0, `${indent}// ${MARKER}: hosts below are treated as local for settings persistence only.`)
}
writeFileSync(target, lines.join('\n'))
console.log(`patched OK (${MARKER}): added ${added.join(', ')}`)
