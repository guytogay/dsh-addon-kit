/**
 * Computer use through the in-process Cua Driver native SDK and its own tools.
 * @module @deepseek-ai/dsh-experimental-computer-use-cua-driver-native
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { z } from 'zod'
import type { CuaDriver as NativeDriver } from '@trycua/cua-driver'
import { acquireLease, releaseLease } from './lease.ts'
import { analysisLuma, settleSignature } from './png.ts'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis plugin identity for the native Cua Driver provider. */
export const name = 'experimental-computer-use-cua-driver-native'

/** Services required before the native runtime can publish tools. */
export const inject = ['computerUse', 'tools', 'systemPrompt']

/** The native provider uses the installed SDK's same-process defaults. */
export const Config = Schema.object({})

const ToolCatalog = z.object({
  tools: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.unknown().optional(),
  })),
})

/** DeepSeek's function-name alphabet and maximum length are protocol constants. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u

const GUIDANCE = `Cua Driver native computer-use tools operate the host desktop. Discover the exact app and window, then get a fresh window snapshot before acting. Use element_token from that snapshot, or coordinates from its screenshot. A new snapshot of that window invalidates its earlier element tokens. Select either target or the legacy pid/window_id fields; do not combine them.

Prefer background delivery. A refusal does not authorize a foreground retry. Verify the requested outcome from fresh state after an action; a delivered click alone does not prove the outcome. After cancellation, inspect current state before retrying because completed input is not rolled back. Other sessions and applications may change the same desktop.

On macOS, cursor-overlay operations may return facility_unavailable even when screenshots and input work.`

/** Cap on element-token pairs listed when no derivable pattern exists. */
const MAX_LISTED_TOKENS = 8

/** One decoded native result or nested driver record. */
type DriverRecord = Record<string, unknown>

function asRecord(value: unknown): DriverRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as DriverRecord
    : undefined
}

/** Element handles are `element_token`, minted per observation as `<snapshot_id>:<element_index>`. */
function elementTokenLines(structured: DriverRecord): string[] {
  const elements = structured['elements']
  if (!Array.isArray(elements) || elements.length === 0) return []
  const pairs: Array<{ index: string; token: string }> = []
  for (const entry of elements) {
    const row = asRecord(entry)
    const token = row?.['element_token']
    if (typeof token !== 'string' || token.length === 0) continue
    const index = row?.['element_index']
    pairs.push({
      index: typeof index === 'number' || typeof index === 'string' ? String(index) : '',
      token,
    })
  }
  if (pairs.length === 0) {
    return ['element_token: none in this observation — act by screenshot coordinates from this snapshot']
  }
  const snapshot = pairs[0]!.token.split(':')[0] ?? ''
  const derivable = snapshot.length > 0
    && pairs.every(pair => pair.index.length > 0 && pair.token === `${snapshot}:${pair.index}`)
  if (derivable && pairs.length === elements.length) {
    return [`element_token = "<snapshot_id>:<element_index>" for this snapshot, e.g. ${pairs[0]!.token}; a fresh observation mints a new snapshot id`]
  }
  const listed = pairs.slice(0, MAX_LISTED_TOKENS).map(pair => `${pair.index}=${pair.token}`).join(' ')
  const remaining = pairs.length > MAX_LISTED_TOKENS ? ` (+${pairs.length - MAX_LISTED_TOKENS} more)` : ''
  const pattern = derivable ? '' : ' (no derivable pattern)'
  return [`element_token: ${pairs.length}/${elements.length} elements carry one${pattern}; ${listed}${remaining}`]
}

/** A partial tree is a limit the model must see, not a silent truncation. */
function elementCountLines(structured: DriverRecord): string[] {
  const total = structured['element_count']
  const complete = structured['elements_complete']
  if (typeof total !== 'number' && typeof complete !== 'boolean') return []
  const line = [
    typeof total === 'number' ? `elements=${total}` : undefined,
    typeof complete === 'boolean' ? `complete=${complete}` : undefined,
  ].filter((part): part is string => part !== undefined).join(' ')
  return [complete === false
    ? `${line} — the tree is partial; re-observe, page with the continuation, or narrow with query`
    : line]
}

/** Predicate checks report why they could not decide; a bare `unknown` hides that. */
function predicateLines(structured: DriverRecord): string[] {
  const status = structured['status']
  const predicates = structured['predicates']
  if (typeof status !== 'string' || !Array.isArray(predicates)) return []
  const reasons = new Set<string>()
  let matches: number | undefined
  for (const entry of predicates) {
    const row = asRecord(entry)
    const reason = row?.['unknown_reason']
    if (typeof reason === 'string') reasons.add(reason)
    const observed = row?.['observed_json']
    if (typeof observed === 'string' && matches === undefined) {
      try {
        const parsed = asRecord(JSON.parse(observed))
        if (typeof parsed?.['matches'] === 'number') matches = parsed['matches']
      } catch {
        // An unparseable observation carries no extra fact for the model.
      }
    }
  }
  const detail = [
    `status=${status}`,
    reasons.size > 0 ? `reason=${[...reasons].join(',')}` : undefined,
    matches !== undefined ? `matches=${matches}` : undefined,
  ].filter((part): part is string => part !== undefined).join(' ')
  return [status === 'unknown'
    ? `${detail} — unknown is not success; only trusted native elements can satisfy a predicate`
    : detail]
}

/** Delivery routes, degradation, and driver advice decide what the caller may attempt next. */
function capabilityLines(structured: DriverRecord): string[] {
  const lines: string[] = []
  const routes = asRecord(structured['background_input'])?.['routes']
  if (Array.isArray(routes)) {
    const rendered = routes.flatMap((entry) => {
      const row = asRecord(entry)
      const route = row?.['route']
      const status = row?.['status']
      return typeof route === 'string' && typeof status === 'string' ? [`${route}=${status}`] : []
    })
    if (rendered.length > 0) lines.push(`routes: ${rendered.join(' ')}`)
  }
  if (structured['degraded'] === true || typeof structured['degraded_reason'] === 'string') {
    const reason = structured['degraded_reason']
    lines.push(`degraded=${String(structured['degraded'])}${typeof reason === 'string' ? ` reason=${reason}` : ''}`)
  }
  const escalation = structured['escalation']
  if (escalation !== undefined && escalation !== null) {
    // Observed 2026-10-17: the driver emits this on calls whose input did land, so it is a
    // route hint, not failure evidence. Calling it a failure invites duplicate input.
    lines.push(`hint (not failure evidence; verify the observed state before retrying)=${JSON.stringify(escalation).slice(0, 240)}`)
  }
  const note = structured['_note']
  if (typeof note === 'string' && note.length > 0) lines.push(`note=${note.slice(0, 240)}`)
  return lines
}

/** One retained observation of a window: used for diffing and coordinate binding. */
export interface WindowObservation {
  token: string
  revision: string
  markdown: string
  elements: DriverRecord[]
  frame?: { x: number; y: number; width: number; height: number }
}

/** A window-local rectangle in points. */
export interface WindowRect { x: number; y: number; width: number; height: number }

/** Line-level change between two rendered trees. */
export function diffTreeLines(previous: string, next: string): { added: string[]; removed: string[] } {
  const count = (lines: string[]): Map<string, number> => {
    const map = new Map<string, number>()
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1)
    return map
  }
  const before = count(previous.split('\n'))
  const after = count(next.split('\n'))
  const added: string[] = []
  for (const line of next.split('\n')) {
    const left = before.get(line) ?? 0
    if (left > 0) before.set(line, left - 1)
    else added.push(line)
  }
  const removed: string[] = []
  for (const line of previous.split('\n')) {
    const left = after.get(line) ?? 0
    if (left > 0) after.set(line, left - 1)
    else removed.push(line)
  }
  return { added, removed }
}

/** Outcome of waiting for a window to stop changing. */
export interface StabilityOutcome {
  stable: boolean
  samples: number
  waitedMs: number
  lastChangeAgoMs: number
  /** True when the wait stopped because the caller aborted; the outcome is then unknown. */
  aborted?: boolean
}

/**
 * Wait until a window's rendered tree stops changing, using measured inactivity instead of a fixed
 * sleep. The observer returns whether that sample differed from the previous one.
 * @param observe - takes one sample; resolves with `{ changed }`.
 * @param options - stable window, overall timeout, sampling interval, and a clock.
 * @returns the verdict plus how many samples it took.
 */
export async function waitForStable(
  observe: (sample: number) => Promise<{ changed: boolean }>,
  options: { stableMs?: number; timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<StabilityOutcome> {
  const stableMs = Math.max(0, options.stableMs ?? 400)
  const timeoutMs = Math.max(0, options.timeoutMs ?? 5000)
  const intervalMs = Math.max(1, options.intervalMs ?? 120)
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const signal = options.signal
  const started = now()
  let samples = 0
  let lastChange = started
  for (;;) {
    // An abort ends the wait immediately: continuing to poll would keep the caller blocked on a
    // window it no longer cares about, and the honest outcome is "unknown", not "timed out".
    if (signal?.aborted === true) {
      return { stable: false, samples, waitedMs: now() - started, lastChangeAgoMs: now() - lastChange, aborted: true }
    }
    const sample = await observe(samples)
    samples += 1
    if (sample.changed) lastChange = now()
    // Two samples are the floor: one slow observation must not look like a quiet window.
    if (samples >= 2 && now() - lastChange >= stableMs) {
      return { stable: true, samples, waitedMs: now() - started, lastChangeAgoMs: 0 }
    }
    if (now() - started >= timeoutMs) {
      return { stable: false, samples, waitedMs: now() - started, lastChangeAgoMs: now() - lastChange }
    }
    await sleep(intervalMs)
  }
}

/**
 * Revision of a whole observation: element fingerprints plus the rendered tree.
 * The structured element list omits non-actionable rows, so a value that only appears in the tree
 * (a calculator display, a status line) would otherwise look like "nothing changed" — observed
 * 2026-10-17 on the Calculator.
 * @param elements - structured elements of the observation.
 * @param markdown - rendered tree of the same observation.
 * @returns a revision string that changes when either part changes.
 */
export function stateRevision(elements: readonly DriverRecord[], markdown: string): string {
  let hash = 2166136261
  for (const character of markdown) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return `${revisionOf(elements)}-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * Convert a window-local point into the pixel space the click tools expect.
 * Element frames are reported in screen POINTS, but clicking takes window-local screenshot PIXELS;
 * on a Retina display the two differ by the backing scale, and a point passed straight to a click
 * lands half as far as intended (measured 2026-10-17: point (34,265) moved nothing, pixel (68,422)
 * pressed the "7" key).
 * @param point - window-local point.
 * @param scale - pixels per point.
 * @returns window-local pixels, rounded.
 */
export function toPixels(point: { x: number; y: number }, scale: number): { x: number; y: number } {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1
  return { x: Math.round(point.x * factor), y: Math.round(point.y * factor) }
}

/**
 * Render the window list the model actually needs.
 * The driver answers `list_windows` with a count in its text block and the records only in
 * structuredContent, which leaves a caller unable to name a window at all. This projection keeps
 * the id, the owning pid and a short title on one line per window.
 * @param content - structuredContent of the driver's reply.
 * @returns lines suitable for the model, or an empty array when nothing could be read.
 */
export function windowListLines(content: DriverRecord | undefined): string[] {
  const records: DriverRecord[] = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (value === null || typeof value !== 'object') return
    const row = value as DriverRecord
    if (typeof row['pid'] === 'number' && typeof row['window_id'] === 'number') records.push(row)
    else Object.values(row).forEach(walk)
  }
  walk(content)
  return records.map((row) => {
    const title = typeof row['title'] === 'string' ? row['title'] : typeof row['name'] === 'string' ? row['name'] : ''
    const app = typeof row['app_name'] === 'string' ? row['app_name'] : typeof row['app'] === 'string' ? row['app'] : ''
    return `  pid=${String(row['pid'])} window_id=${String(row['window_id'])}${app === '' ? '' : ` app=${app}`}${title === '' ? '' : ` ${JSON.stringify(title.slice(0, 60))}`}`
  })
}

/**
 * Surface the target and tab identifiers a browser binding mints.
 * `get_browser_state` answers with text such as `bound target bt-… (exact) with 1 tab(s)` and keeps
 * the tab identifier only in structuredContent, so the typed browser tools — which all require a
 * tab id — cannot be aimed at all. The ids are read structurally instead of parsing that sentence,
 * because the sentence is presentation and may change.
 * @param content - structuredContent of the driver's reply.
 * @returns one line naming the binding, or an empty array when the reply carries no browser ids.
 */
export function browserBindingLines(content: DriverRecord | undefined): string[] {
  if (content === undefined) return []
  const found: { path: string; value: string }[] = []
  const walk = (value: unknown, path: string[]): void => {
    const key = (path[path.length - 1] ?? '').toLowerCase()
    if (Array.isArray(value)) {
      // A binding may also come back as `tabs: ["<id>", …]`; those entries are ids, not records.
      if (/(tab|target)/.test(key) && value.every(entry => typeof entry === 'string')) {
        value.forEach(entry => found.push({ path: path.join('.'), value: entry as string }))
        return
      }
      value.forEach((entry, index) => walk(entry, [...path, `[${index}]`]))
      return
    }
    if (value === null || typeof value !== 'object') {
      if (typeof value !== 'string') return
      const idLike = key === 'id' || key.endsWith('_id') || key === 'targetid' || key === 'tabid'
      if (idLike) found.push({ path: path.join('.'), value })
      return
    }
    for (const [childKey, child] of Object.entries(value as DriverRecord)) walk(child, [...path, childKey])
  }
  walk(content, [])
  const uniq = (values: string[]): string[] => [...new Set(values)]
  const targetIds = uniq(found.filter(entry => entry.path.toLowerCase().includes('target')).map(entry => entry.value))
  const tabIds = uniq(found.filter(entry => entry.path.toLowerCase().includes('tab')).map(entry => entry.value))
  const fallbackTarget = uniq(found.filter(entry => entry.value.startsWith('bt-')).map(entry => entry.value))
  const target = targetIds[0] ?? fallbackTarget[0]
  if (target === undefined && tabIds.length === 0) return []
  const parts = [
    target === undefined ? undefined : `target_id=${target}`,
    tabIds.length === 0 ? undefined : `tab_ids=${tabIds.join(',')}`,
  ].filter((part): part is string => part !== undefined)
  return [`browser: ${parts.join(' ')} (pass these as target_id / tab_id to the typed browser tools)`]
}

/**
 * Surface the action refs a browser snapshot mints.
 * A snapshot answers "snapshot p1 … 1 action ref(s)" and keeps every ref in structuredContent, so
 * browser_click / browser_type / browser_pointer — which are all ref-addressed — have nothing to
 * aim at. Refs are read structurally; the rows are capped so a large page cannot flood the model.
 * @param content - structuredContent of the driver's reply.
 * @returns one line per addressable ref, or an empty array when the reply carries none.
 */
export function browserRefLines(content: DriverRecord | undefined): string[] {
  if (content === undefined) return []
  const rows = new Map<string, string>()
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)
  const walk = (value: unknown, path: string[]): void => {
    if (Array.isArray(value)) {
      value.forEach(entry => walk(entry, path))
      return
    }
    if (value === null || typeof value !== 'object') {
      if (typeof value !== 'string') return
      const key = (path[path.length - 1] ?? '').toLowerCase()
      if (key === 'ref' || key === 'refs' || key === 'element_ref') {
        // Never let a bare `ref` string erase the detail row recorded for the same ref.
        if (!rows.has(value)) rows.set(value, '')
      }
      return
    }
    const row = value as DriverRecord
    const ref = text(row['ref']) ?? text(row['element_ref']) ?? text(row['page_ref'])
    if (ref !== undefined) {
      const role = text(row['role']) ?? text(row['role_kind']) ?? ''
      const name = text(row['name']) ?? text(row['label']) ?? text(row['text']) ?? ''
      const parts = [role === '' ? undefined : `role=${role}`, name === '' ? undefined : `name=${JSON.stringify(name.slice(0, 60))}`]
      rows.set(ref, parts.filter((part): part is string => part !== undefined).join(' '))
    }
    for (const [key, child] of Object.entries(row)) walk(child, [...path, key])
  }
  walk(content, [])
  if (rows.size === 0) return []
  const lines = [...rows.entries()].slice(0, 40).map(([ref, detail]) => `  ${ref}${detail === '' ? '' : ` ${detail}`}`)
  const more = rows.size > lines.length ? ` … ${rows.size - lines.length} more` : ''
  return [`browser refs:${more}\n${lines.join('\n')}`]
}

/**
 * Decide whether another writer touched the window between our decision and our action.
 * A second agent on the same machine does not take our leases, so the only defence is observation:
 * if the window already moved on since the revision this action was planned against, acting now
 * would fight the other writer and corrupt both.
 * @param plannedRevision - revision the action was planned against.
 * @param preActionRevision - revision observed immediately before delivering the action.
 * @param duringActionRevision - revision observed right after delivering it, when available.
 * @returns whether the window was contended, plus the reason.
 */
export function contendedVerdict(
  plannedRevision: string,
  preActionRevision: string,
  duringActionRevision?: string,
): { contended: boolean; reason: string } {
  if (preActionRevision !== plannedRevision) {
    return { contended: true, reason: 'the window changed after this action was planned, so another writer is active' }
  }
  if (duringActionRevision !== undefined && duringActionRevision !== preActionRevision) {
    return { contended: true, reason: 'the window changed while the action was being delivered' }
  }
  return { contended: false, reason: 'no foreign change observed' }
}

/**
 * Warn when a window is small enough that coordinate clicks proved unreliable.
 * Measured 2026-10-18: on a 115x204 point window neither the pixel space nor the point space pressed
 * the intended key, while the keyboard path worked on the same window. A caller that only gets
 * "not verified" cannot tell that from a wrong expectation, so say it up front.
 * @param frame - the window element's frame in screen points.
 * @returns a warning line, or undefined for a window large enough to trust coordinates.
 */
export function smallWindowHint(frame: { w?: number | undefined; h?: number | undefined } | undefined): string | undefined {
  const width = frame?.w
  const height = frame?.h
  if (typeof width !== 'number' || typeof height !== 'number') return undefined
  if (width >= 240 && height >= 240) return undefined
  return `note: this window is ${Math.round(width)}x${Math.round(height)} points; coordinate clicks did not land on small windows in testing (2026-10-18) — prefer type_text / press_key on this one`
}

/**
 * Recognise the driver's precondition refusal for menu invocation.
 * The driver only invokes a menu when it can confirm the window is stably key and frontmost, and it
 * says so in one specific way. Treating that message as "the menu does not exist" would send a caller
 * hunting for a wrong path, so it is classified separately.
 * @param message - the error text from the driver.
 * @returns true when the failure is a precondition, not a missing menu item.
 */
export function menuPreconditionFailure(message: string): boolean {
  return /did not become stably key and frontmost/i.test(message) || /stably key/i.test(message)
}

/** One acceptance condition on a window's visible text. */
export interface GoalCondition {
  /** Literal text that must be visible. */
  text?: string
  /** Literal text that must be absent. */
  absent?: string
}

/**
 * Judge whether a stated end condition holds, without ever guessing.
 * `met` requires every condition to hold on a real observation; a violation is `not-met`; an
 * observation that could not be read is `unknown`, because an unmeasured screen proves nothing and
 * a task must not be reported done on it.
 * @param conditions - conditions the caller declared as "the task is done".
 * @param visible - text seen on the window (elements plus rendered tree), if it was read at all.
 * @param degraded - whether the observation was degraded or empty.
 * @returns the verdict plus a per-condition reason.
 */
export function goalVerdict(
  conditions: readonly GoalCondition[],
  visible: string | undefined,
  degraded: boolean,
): { verdict: 'met' | 'not-met' | 'unknown'; reasons: string[] } {
  if (degraded || visible === undefined) {
    return { verdict: 'unknown', reasons: ['the window could not be observed, so nothing was verified'] }
  }
  if (conditions.length === 0) {
    return { verdict: 'unknown', reasons: ['no conditions were declared, so there is nothing to verify'] }
  }
  const reasons: string[] = []
  let violated = false
  for (const condition of conditions) {
    if (condition.text !== undefined && condition.text.length > 0) {
      const seen = visible.includes(condition.text)
      if (!seen) violated = true
      // A match without its context cannot be judged: a string that appears in the caller's own
      // request (a chat transcript on screen) matches itself. Report the line it matched on.
      const line = seen ? visible.split('\n').find(entry => entry.includes(condition.text!)) ?? '' : ''
      const excerpt = line.trim().slice(0, 80)
      reasons.push(`${JSON.stringify(condition.text)} ${seen ? `present in: ${JSON.stringify(excerpt)}` : 'missing'}`)
    }
    if (condition.absent !== undefined && condition.absent.length > 0) {
      const seen = visible.includes(condition.absent)
      if (seen) violated = true
      reasons.push(`${JSON.stringify(condition.absent)} ${seen ? 'still present' : 'absent'}`)
    }
  }
  if (reasons.length === 0) return { verdict: 'unknown', reasons: ['every condition was empty'] }
  return { verdict: violated ? 'not-met' : 'met', reasons }
}

/** One sample of a window's two independent signals. */
export interface SettleSample {
  /** Rendered tree text; changes when the accessibility surface changes. */
  tree: string
  /** Pixel signature for this sample; compared by equality like the tree. */
  pixels: string
  /**
   * True when this frame is itself in motion. Equality is not enough for a moving scene: a spinner
   * yields the same "moving" label on every sample, so two equal labels would read as "unchanged".
   */
  moving?: boolean
}

/** Outcome of waiting for a window to settle on both signals. */
export interface SettleOutcome {
  settled: boolean
  samples: number
  waitedMs: number
  treeChanged: boolean
  pixelsChanged: boolean
  /** True when the wait stopped because the caller aborted; the outcome is then unknown. */
  aborted?: boolean
}

/**
 * Wait until a window stops changing on BOTH its tree and its pixels.
 * A spinner or a progressing animation keeps repainting while the accessibility tree stands still,
 * so a tree-only check calls such a window settled and the next action lands mid-animation. Two
 * independent signals make that case visible, and the outcome reports which one was still moving.
 * @param observe - takes one sample of both signals.
 * @param options - stable window, timeout, sampling interval, clock and sleep.
 * @returns the verdict plus which signal moved last.
 */
export async function waitForSettled(
  observe: (index: number) => Promise<SettleSample>,
  options: { stableMs?: number; timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<SettleOutcome> {
  const stableMs = Math.max(0, options.stableMs ?? 400)
  const timeoutMs = Math.max(0, options.timeoutMs ?? 5000)
  const intervalMs = Math.max(1, options.intervalMs ?? 120)
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const signal = options.signal
  const started = now()
  let samples = 0
  let lastChange = started
  let previous: SettleSample | undefined
  let treeChanged = false
  let pixelsChanged = false
  for (;;) {
    if (signal?.aborted === true) {
      return { settled: false, samples, waitedMs: now() - started, treeChanged, pixelsChanged, aborted: true }
    }
    const sample = await observe(samples)
    samples += 1
    const sampleMoving = sample.moving === true
    if (previous !== undefined) {
      treeChanged = sample.tree !== previous.tree
      pixelsChanged = sample.pixels !== previous.pixels || sampleMoving
      if (treeChanged || pixelsChanged || sampleMoving) lastChange = now()
    } else if (sampleMoving) {
      lastChange = now()
    }
    previous = sample
    if (samples >= 2 && now() - lastChange >= stableMs) {
      return { settled: true, samples, waitedMs: now() - started, treeChanged, pixelsChanged }
    }
    if (now() - started >= timeoutMs) {
      return { settled: false, samples, waitedMs: now() - started, treeChanged, pixelsChanged }
    }
    await sleep(intervalMs)
  }
}

/** One remembered action outcome, keyed by the action's identity. */
export interface LedgerEntry {
  key: string
  at: number
  outcome: 'verified' | 'unverified'
}

/**
 * Decide whether repeating an action is safe.
 * A retry loop is the normal way a caller reacts to "unverified", and it is exactly how an input
 * gets duplicated: the first attempt may have landed. So the same action is never repeated blindly —
 * a verified attempt is treated as already done, an unverified one needs an explicit override.
 * @param entries - outcomes recorded so far.
 * @param key - identity of the action about to run.
 * @param now - current time.
 * @param windowMs - how long an outcome counts as "just now"; default 10 s.
 * @returns the decision plus the reason.
 */
export function duplicateCheck(
  entries: ReadonlyMap<string, LedgerEntry>,
  key: string,
  now: number,
  windowMs = 10_000,
): { action: 'proceed' | 'already-done' | 'needs-approval'; reason: string } {
  const entry = entries.get(key)
  if (entry === undefined) return { action: 'proceed', reason: 'first time for this action' }
  const age = now - entry.at
  if (age > windowMs) return { action: 'proceed', reason: `last attempt was ${Math.round(age / 1000)} s ago, outside the retry window` }
  if (entry.outcome === 'verified') {
    return { action: 'already-done', reason: `this exact action was verified ${Math.round(age / 1000)} s ago; repeating would duplicate it` }
  }
  return { action: 'needs-approval', reason: `this exact action was attempted ${Math.round(age / 1000)} s ago and never verified; repeating may duplicate it (pass allow_repeat to override)` }
}

/** Verdict for one action whose effect was checked against a declared expectation. */
export interface ActionVerdict {
  verified: boolean
  changed: boolean
  expectation: 'text-appeared' | 'any-change' | 'no-expectation'
  detail: string
}

/**
 * Decide whether an action actually did what the caller said it would.
 * A verdict is only `verified` when a declared expectation held: a click that changed nothing is not
 * a success, and an action with no expectation cannot be verified at all (it stays unverifiable
 * rather than being assumed good).
 * @param input - pre/post revisions, whether the expected text appeared, and the declared expectation.
 * @returns the verdict plus the reason, in the caller's own terms.
 */
export function actionVerdict(input: {
  beforeRevision: string
  afterRevision: string
  textAppeared?: boolean
  textPresentBefore?: boolean
  expectText?: string
}): ActionVerdict {
  const changed = input.beforeRevision !== input.afterRevision
  if (input.expectText !== undefined && input.expectText.length > 0) {
    const appeared = input.textAppeared === true
    const alreadyThere = input.textPresentBefore === true
    // A string that was already on screen before the click cannot be evidence for it: the calculator
    // key labelled "7" is present whether or not the display changed (observed 2026-10-17).
    const fresh = appeared && !alreadyThere
    return {
      verified: fresh,
      changed,
      expectation: 'text-appeared',
      detail: alreadyThere
        ? `expected ${JSON.stringify(input.expectText.slice(0, 60))} was already present before the click, so this click did not produce it; revision ${input.beforeRevision}→${input.afterRevision}`
        : `expected ${JSON.stringify(input.expectText.slice(0, 60))} ${appeared ? 'appeared' : 'did not appear'}; revision ${input.beforeRevision}→${input.afterRevision}`,
    }
  }
  return {
    verified: false,
    changed,
    expectation: 'any-change',
    detail: `no expectation was declared, so the change (revision ${input.beforeRevision}→${input.afterRevision}) is reported but not verified`,
  }
}

/** How a selection is produced from the caret. */
export type SelectionMode = 'all' | 'line' | 'chars'

/**
 * Plan the step sequence that produces a text selection.
 * This driver responds to keyboard selection but NOT to shift-click or drag (measured 2026-10-17:
 * shift-click left the clipboard unchanged while caret + shift+Right selected "alpha "). The plan is
 * spelled out so the ordering and the modifiers stay testable without a window.
 * @param mode - whole document, to end of line, or a fixed character count.
 * @param count - characters to extend for `chars`.
 * @returns ordered steps for the driver.
 */
export function selectionPlan(mode: SelectionMode, count = 6): Array<{ kind: 'hotkey'; keys: string[] } | { kind: 'key'; key: string; modifiers: string[] }> {
  if (mode === 'all') return [{ kind: 'hotkey', keys: ['cmd', 'a'] }]
  if (mode === 'line') return [{ kind: 'hotkey', keys: ['cmd', 'shift', 'right'] }]
  const steps: Array<{ kind: 'hotkey'; keys: string[] } | { kind: 'key'; key: string; modifiers: string[] }> = []
  for (let index = 0; index < Math.max(1, Math.min(500, count)); index += 1) {
    steps.push({ kind: 'key', key: 'right', modifiers: ['shift'] })
  }
  return steps
}

/** Capability flags inferred from an app bundle's own contents. */
export interface AppProfile {
  bundleId?: string
  bundlePath?: string
  isElectron: boolean
  hasCef: boolean
  hasChromiumInputSurface: boolean
  evidence: string[]
}

/**
 * Classify how an app's UI is built, from evidence it carries itself.
 * Electron and CEF apps answer accessibility and synthetic input differently from native ones, so a
 * caller needs to know before choosing a delivery route. Nothing is guessed from the app's name
 * alone: the flags come from frameworks the bundle actually contains, and a Chromium-family bundle
 * id is reported as its own piece of evidence.
 * @param input - bundle id, bundle path, and the framework names found next to the executable.
 * @returns the flags plus the evidence behind each one.
 */
export function appProfile(input: { bundleId?: string; bundlePath?: string; frameworkNames?: readonly string[] }): AppProfile {
  const names = input.frameworkNames ?? []
  const evidence: string[] = []
  const isElectron = names.some(name => /electron framework/i.test(name))
  if (isElectron) evidence.push('bundle ships Electron Framework')
  const hasCef = names.some(name => /chromium embedded framework/i.test(name))
  if (hasCef) evidence.push('bundle ships Chromium Embedded Framework')
  const idMatch = typeof input.bundleId === 'string' && /(chrome|chromium|edge|brave|opera)/i.test(input.bundleId)
  if (idMatch) evidence.push(`bundle id ${input.bundleId} is Chromium family`)
  if (names.length === 0) evidence.push('no frameworks were listed')
  return {
    ...input.bundleId === undefined ? {} : { bundleId: input.bundleId },
    ...input.bundlePath === undefined ? {} : { bundlePath: input.bundlePath },
    isElectron,
    hasCef,
    hasChromiumInputSurface: isElectron || hasCef || idMatch,
    evidence,
  }
}

/**
 * Resolve an app bundle from a running pid so classification can use the bundle's own evidence.
 * @param pid - running process id.
 * @returns bundle path/id and framework names; absent fields mean the bundle could not be resolved.
 */
export async function resolveAppBundle(pid: number): Promise<{ bundlePath?: string; bundleId?: string; frameworkNames: string[] }> {
  const { execFileSync } = await import('node:child_process')
  const { readdir } = await import('node:fs/promises')
  let executable = ''
  try { executable = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim() } catch { executable = '' }
  const bundlePath = /^(.*?\.app)\//.exec(executable)?.[1]
  let bundleId: string | undefined
  if (bundlePath !== undefined) {
    try { bundleId = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', `${bundlePath}/Contents/Info.plist`], { encoding: 'utf8' }).trim() } catch { bundleId = undefined }
  }
  let frameworkNames: string[] = []
  if (bundlePath !== undefined) {
    try { frameworkNames = await readdir(`${bundlePath}/Contents/Frameworks`) } catch { frameworkNames = [] }
  }
  return {
    ...bundlePath === undefined ? {} : { bundlePath },
    ...bundleId === undefined ? {} : { bundleId },
    frameworkNames,
  }
}

/** A route recommendation for an app this session has never driven. */
export interface RouteVerdict {
  route: 'ax-pixels' | 'cdp' | 'keyboard' | 'vision' | 'unknown'
  confidence: 'high' | 'low'
  reason: string
  next: string
}

/**
 * Choose an input route from three cheap probes plus the app's own bundle evidence.
 * The order matters: a readable tree plus a click that moves content is the happy path; a readable
 * tree whose click does nothing is either a Chromium surface (CDP) or a text view (keyboard).
 * @param input - probe results; `null`/absent means "not attempted".
 * @returns the route, its confidence, why, and the next action to take.
 */
export function routeVerdict(input: {
  treeReadable?: boolean | null
  clickChanged?: boolean | null
  keyLanded?: boolean | null
  chromium?: boolean
  electron?: boolean
} = {}): RouteVerdict {
  const treeReadable = input.treeReadable === true
  const clickChanged = typeof input.clickChanged === 'boolean' ? input.clickChanged : null
  const keyLanded = typeof input.keyLanded === 'boolean' ? input.keyLanded : null
  const chromium = input.chromium === true
  if (!treeReadable && chromium) {
    return { route: 'cdp', confidence: 'high', reason: 'no accessibility tree, but the app is Chromium: drive the renderer over CDP', next: 'bind a CDP target and act by selector/ref' }
  }
  if (!treeReadable && !chromium && keyLanded === true) {
    return { route: 'keyboard', confidence: 'low', reason: 'no tree, but a keystroke landed: the app accepts input without an AX surface', next: 'drive it by keyboard and verify each step by reading text or pixels' }
  }
  if (!treeReadable) {
    return { route: 'vision', confidence: 'low', reason: 'no tree and no input evidence: only pixels are left', next: 'capture, read coordinates off the image, click, and verify by pixel diff plus a text read' }
  }
  if (clickChanged === true) {
    return { route: 'ax-pixels', confidence: 'high', reason: 'tree is readable and a click moved the content: AX plus window-local pixel coordinates', next: 'act by element token where possible, by pixel otherwise, and verify an incremental expectation' }
  }
  if (clickChanged === false && chromium) {
    return { route: 'cdp', confidence: 'high', reason: 'tree is readable but a click moved nothing on a Chromium surface: an AX press is not a real mouse event', next: 'drive the renderer over CDP and verify by DOM text' }
  }
  if (clickChanged === false) {
    return { route: 'keyboard', confidence: 'low', reason: 'tree is readable but the click was inert: this control likely wants keyboard or selection input', next: 'use keyboard / select-text instead of coordinate clicks, and verify by reading back' }
  }
  return { route: 'unknown', confidence: 'low', reason: 'the click probe has not run yet, so the route cannot be chosen', next: 'click one element you chose and compare the content revision and the tree' }
}

/** One permission line as reported to the model. */
export interface PermissionFinding {  name: string
  state: 'granted' | 'denied' | 'unprobed'
  evidence: string
}

/**
 * Build a permission report from independent probes.
 * A probe that throws is reported as unprobed rather than granted: a failed measurement never
 * proves a permission exists, and claiming otherwise sends callers hunting the wrong cause.
 * @param probes - named probes returning a verdict plus the evidence that produced it.
 * @returns one finding per probe, in input order.
 */
export async function permissionReport(
  probes: ReadonlyArray<{ name: string; probe: () => Promise<{ granted: boolean; evidence: string }> }>,
): Promise<PermissionFinding[]> {
  const findings: PermissionFinding[] = []
  for (const entry of probes) {
    try {
      const result = await entry.probe()
      findings.push({ name: entry.name, state: result.granted ? 'granted' : 'denied', evidence: result.evidence })
    } catch (error) {
      findings.push({ name: entry.name, state: 'unprobed', evidence: error instanceof Error ? error.message : String(error) })
    }
  }
  return findings
}

/** Content identity of one captured screenshot. */
export interface ScreenshotBinding {
  id: string
  at: number
}

/**
 * Content identity of a screenshot, so coordinates can be bound to the exact image they were read
 * from. Two captures of the same pixels share an id; any repaint changes it.
 * @param bytes - encoded PNG bytes as returned by the driver.
 * @returns sixteen hexadecimal digits.
 */
export function screenshotId(bytes: Uint8Array): string {
  let first = 2166136261
  let second = 3735928559
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 16777619)
    second = Math.imul(second ^ byte, 2246822519)
  }
  return ((first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0'))
}

/**
 * Decide whether a supplied screenshot id still identifies the newest capture of that window.
 * A stale id means the pixels the caller measured are no longer the pixels on screen, so clicking
 * would be a guess.
 * @param binding - newest binding recorded for the window, if any.
 * @param supplied - id the caller passed in.
 * @param maxAgeMs - how long a binding stays usable; default 60 seconds.
 * @param now - current time, injectable for tests.
 * @returns `{ok:true}` or `{ok:false, reason}`.
 */
export function bindingMatches(
  binding: ScreenshotBinding | undefined,
  supplied: unknown,
  maxAgeMs = 60_000,
  now = Date.now(),
): { ok: boolean; reason?: string } {
  if (binding === undefined) return { ok: false, reason: 'no screenshot has been captured for this window' }
  if (typeof supplied !== 'string' || supplied.length === 0) return { ok: false, reason: 'screenshot_id is required' }
  if (supplied !== binding.id) return { ok: false, reason: `screenshot_id ${JSON.stringify(supplied)} is not the newest capture (newest is ${binding.id})` }
  const age = now - binding.at
  if (age > maxAgeMs) return { ok: false, reason: `the capture is ${Math.round(age / 1000)} s old; re-capture before clicking` }
  return { ok: true }
}

/** Coarse, stable role vocabulary: raw AX roles vary by app, kinds do not. */
const ROLE_KINDS: Record<string, string> = {
  AXWindow: 'window',
  AXSheet: 'window',
  AXDialog: 'window',
  AXButton: 'button',
  AXStaticText: 'text',
  AXHeading: 'text',
  AXTextField: 'text-input',
  AXTextArea: 'text-input',
  AXSearchField: 'text-input',
  AXComboBox: 'text-input',
  AXRow: 'row',
  AXCell: 'cell',
  AXOutline: 'outline',
  AXList: 'list',
  AXTable: 'table',
  AXImage: 'image',
  AXGroup: 'group',
  AXToolbar: 'toolbar',
  AXMenuBar: 'menu-bar',
  AXMenuBarItem: 'menu-bar-item',
  AXMenuItem: 'menu-item',
  AXMenu: 'menu',
  AXMenuButton: 'menu-button',
  AXPopUpButton: 'popup-button',
  AXRadioButton: 'radio',
  AXCheckBox: 'checkbox',
  AXSlider: 'slider',
  AXScrollArea: 'scroll-area',
  AXTabGroup: 'tab-group',
  AXLink: 'link',
  AXDisclosureTriangle: 'disclosure',
  AXWebArea: 'web',
  AXSplitter: 'splitter',
  AXProgressIndicator: 'progress',
}

/**
 * Coarse role kind for one raw accessibility role.
 * Apps spell roles inconsistently; matching on a small closed vocabulary keeps the same control
 * identifiable across observations and across tools, and unknown roles fall to `other` instead of
 * being guessed into a nearby kind.
 * @param role - raw role string.
 * @returns one of the vocabulary values, or `other`.
 */
export function roleKind(role: string): string {
  return ROLE_KINDS[role] ?? 'other'
}

/** Coarse value kind, so a caller can tell text from numbers and absence. */
export function valueKind(value: unknown): string {
  if (value === undefined || value === null) return 'none'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return value.length === 0 ? 'empty' : 'text'
  return 'other'
}

/**
 * Canonical one-line element description shared by every model-facing listing.
 * One spelling for region results, structural diffs and token projections means a control reads
 * the same wherever it appears.
 * @param row - one element from an observation.
 * @returns a stable single line.
 */
export function describeElement(row: DriverRecord): string {
  const role = typeof row['role'] === 'string' ? row['role'] : ''
  const label = typeof row['label'] === 'string' ? row['label'] : ''
  const value = typeof row['value'] === 'string' ? row['value'] : ''
  const text = label.length > 0 ? label : value
  const kind = roleKind(role)
  return `${kind}${kind === 'other' && role.length > 0 ? `(${role})` : ''}${text.length === 0 ? '' : ` ${JSON.stringify(text.slice(0, 40))}`}`
}

/** Stable fingerprint of one element: role, text and rounded frame. */
export function elementFingerprint(row: DriverRecord): string {
  const role = typeof row['role'] === 'string' ? row['role'] : ''
  const label = typeof row['label'] === 'string' ? row['label'] : ''
  const value = typeof row['value'] === 'string' ? row['value'] : ''
  const frame = asRecord(row['frame'])
  const coordinate = (key: string, alias: string): number => {
    const raw = frame?.[key] ?? frame?.[alias]
    return typeof raw === 'number' ? Math.round(raw) : -1
  }
  return `${role}|${label}|${value}|${coordinate('x', 'x')},${coordinate('y', 'y')},${coordinate('w', 'width')},${coordinate('h', 'height')}`
}

/**
 * Content revision of one observation: order-insensitive hash of its element fingerprints.
 * Two observations holding the same elements in a different order share a revision, while a moved
 * or relabelled element changes it — a distinction line-level text diffing cannot make.
 * @param elements - elements of one observation.
 * @returns eight hexadecimal digits.
 */
export function revisionOf(elements: readonly DriverRecord[]): string {
  const fingerprints = elements.map(elementFingerprint).sort()
  let hash = 2166136261
  for (const character of fingerprints.join('\n')) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Element-level change between two observations. */
export function diffElements(previous: readonly DriverRecord[], next: readonly DriverRecord[]): { added: DriverRecord[]; removed: DriverRecord[] } {
  const remaining = new Map<string, number>()
  const sample = new Map<string, DriverRecord>()
  for (const row of previous) {
    const key = elementFingerprint(row)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
    sample.set(key, row)
  }
  const added: DriverRecord[] = []
  for (const row of next) {
    const key = elementFingerprint(row)
    const left = remaining.get(key) ?? 0
    if (left > 0) remaining.set(key, left - 1)
    else added.push(row)
  }
  const seen = new Map<string, number>()
  for (const row of next) {
    const key = elementFingerprint(row)
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  const removed: DriverRecord[] = []
  for (const row of previous) {
    const key = elementFingerprint(row)
    const left = seen.get(key) ?? 0
    if (left > 0) seen.set(key, left - 1)
    else removed.push(row)
  }
  return { added, removed }
}

/**
 * Screen origin of the window an observation belongs to.
 * The driver reports element frames in screen points (observed 2026-10-17: menu-bar items sit at
 * y≈0 in a Finder window's tree), while `click` takes window-local points. The root AXWindow
 * element carries the window's screen rect, which makes the conversion exact.
 * @param elements - elements of one observation.
 * @returns the window's screen origin, or {x:0,y:0} when no AXWindow frame is present.
 */
export function windowOrigin(elements: readonly DriverRecord[]): { x: number; y: number } {
  for (const row of elements) {
    if (row['role'] !== 'AXWindow') continue
    const frame = asRecord(row['frame'])
    const x = frame?.['x']
    const y = frame?.['y']
    if (typeof x === 'number' && typeof y === 'number') return { x, y }
  }
  return { x: 0, y: 0 }
}

/**
 * Elements whose frame intersects a window-local rect.
 * @param elements - elements of one observation, with screen-point frames.
 * @param rect - window-local rectangle.
 * @param origin - the window's screen origin; defaults to {0,0}.
 * @returns elements intersecting the rect.
 */
export function elementsInRect(elements: readonly DriverRecord[], rect: WindowRect, origin: { x: number; y: number } = { x: 0, y: 0 }): DriverRecord[] {
  return elements.filter((row) => {
    const frame = asRecord(row['frame'])
    const rawX = frame?.['x']
    const rawY = frame?.['y']
    const w = frame?.['w'] ?? frame?.['width']
    const h = frame?.['h'] ?? frame?.['height']
    if (typeof rawX !== 'number' || typeof rawY !== 'number' || typeof w !== 'number' || typeof h !== 'number') return false
    const x = rawX - origin.x
    const y = rawY - origin.y
    return x < rect.x + rect.width && x + w > rect.x && y < rect.y + rect.height && y + h > rect.y
  })
}

/** Tools that deliver input, and therefore owe the model an explicit effect verdict. */
const ACTION_TOOLS = new Set([
  'click', 'type_text', 'paste', 'press_key', 'hotkey', 'scroll', 'drag', 'drag_paths',
  'set_value', 'perform_secondary_action', 'select_text', 'activate_window', 'launch_app',
  'invoke_menu', 'set_window_frame', 'kill_app', 'bring_to_front', 'end_session',
])

/**
 * State the effect verdict for one action result.
 * The driver reports that a call was accepted, not that its input was observed; until it attests
 * an effect, repeating the action can double-deliver. Results that do carry verification facts are
 * left alone.
 * @param toolName - driver tool name.
 * @param structured - decoded `structuredContent`.
 * @returns one diagnostic line, or undefined for non-actions and verified results.
 */
export function actionEffectLine(toolName: string, structured: DriverRecord): string | undefined {
  if (!ACTION_TOOLS.has(toolName)) return undefined
  if (structured['verified'] !== undefined || structured['verification'] !== undefined) return undefined
  return 'effect={"verified":false,"effect":"unverifiable","verification_required":true} — the driver does not attest this effect; re-observe before repeating the action'
}

/**
 * Project the driver's structured diagnostics into the model-visible text.
 * The MCP adapter renders `content` only, so element tokens, capability routes,
 * partial-tree flags, and predicate failure reasons would otherwise never leave the
 * native runtime. Results without those facts are returned unchanged.
 * @param result - decoded native tool result, or any other value.
 * @returns the result with one appended `[cua]` diagnostics block when there is something to say.
 */
export function withDriverDiagnostics(result: unknown, extra: readonly string[] = []): unknown {
  const record = asRecord(result)
  const content = record?.['content']
  if (record === undefined || !Array.isArray(content)) return result
  const structured = asRecord(record['structuredContent'])
  if (structured === undefined) return result
  const lines = [
    ...extra,
    ...elementTokenLines(structured),
    ...elementCountLines(structured),
    ...predicateLines(structured),
    ...capabilityLines(structured),
  ]
  if (lines.length === 0) return result
  return {
    ...record,
    content: [...content, { type: 'text', text: lines.map(line => `[cua] ${line}`).join('\n') }],
  }
}

/** One literal the assertion tool requires in a window observation. */
export interface WindowTextExpectation {
  text: string
  mode?: 'contains' | 'equals'
  role?: string
}

/** One element or tree line that satisfied an expectation. */
export interface WindowTextMatch {
  /** Where the literal was found: a structured element, or a line of the rendered tree. */
  source: 'element' | 'tree_markdown'
  element_index?: number
  element_token?: string
  role?: string
  value?: string
}

/** Per-expectation outcome over one observation. */
export interface WindowTextResult {
  text: string
  searched: number
  markdownLines: number
  matches: WindowTextMatch[]
}

/** Cap on retained matches per expectation; enough to act, not enough to flood context. */
const MAX_MATCHES = 3

/**
 * Match literals against one window observation.
 * Two sources are read, because the driver's own gates hide result values from a predicate
 * check: `verify_state` searches only elements that expose an accessibility action and refuses
 * web content as an untrusted source, and in this driver build the structured `elements` array
 * omits non-actionable rows entirely — a calculator display reading `5` appears only in
 * `tree_markdown`. Structured elements are searched first because they carry element tokens;
 * the rendered tree is searched only when they miss. `searched` and `markdownLines` report the
 * domain, so "no match" stays a statement about what was read instead of `unknown`.
 * @param structured - decoded `structuredContent` of a `get_window_state` result.
 * @param expectations - literals to require.
 * @returns one result per expectation, in input order.
 */
export function evaluateWindowText(structured: unknown, expectations: readonly WindowTextExpectation[]): WindowTextResult[] {
  const record = asRecord(structured)
  const elements = record?.['elements']
  const rows = Array.isArray(elements)
    ? elements.map(asRecord).filter((row): row is DriverRecord => row !== undefined)
    : []
  const markdown = record?.['tree_markdown']
  const lines = typeof markdown === 'string' && markdown.length > 0 ? markdown.split('\n') : []
  return expectations.map((expectation) => {
    const mode = expectation.mode ?? 'contains'
    const matches: WindowTextMatch[] = []
    for (const row of rows) {
      if (matches.length >= MAX_MATCHES) break
      if (expectation.role !== undefined && row['role'] !== expectation.role) continue
      const candidates = [row['value'], row['label']]
        .filter((candidate): candidate is string => typeof candidate === 'string')
      const hit = candidates.some(candidate => mode === 'equals'
        ? candidate === expectation.text
        : candidate.includes(expectation.text))
      if (!hit) continue
      const index = row['element_index']
      const token = row['element_token']
      const role = row['role']
      matches.push({
        source: 'element',
        ...typeof index === 'number' ? { element_index: index } : {},
        ...typeof token === 'string' ? { element_token: token } : {},
        ...typeof role === 'string' ? { role } : {},
        ...candidates.length > 0 ? { value: candidates[0]! } : {},
      })
    }
    if (matches.length === 0) {
      for (const line of lines) {
        if (matches.length >= MAX_MATCHES) break
        const hit = mode === 'equals' ? line.trim() === expectation.text : line.includes(expectation.text)
        if (hit) matches.push({ source: 'tree_markdown', value: line.trim() })
      }
    }
    return { text: expectation.text, searched: rows.length, markdownLines: lines.length, matches }
  })
}

/** One assertion outcome as the model sees it. */
export interface WindowTextAssertion {
  status: 'satisfied' | 'unsatisfied'
  searched: number
  summary: string
}

/**
 * Own one native runtime and expose its catalog through the MCP result adapter.
 * Startup failures roll back every registration. Unload removes tools, aborts
 * calls and image admission, awaits settlement and SDK shutdown, then releases computer use.
 * @param ctx - context providing the exclusive registration and tool services.
 * @returns after native import, runtime creation, and tool discovery complete.
 */
export async function apply(ctx: Context): Promise<void> {
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  let driver: NativeDriver | undefined
  // Cordis announces disposal before it awaits asynchronous plugin startup.
  ctx.on('internal/plugin', (fiber) => {
    if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort()
  }, { global: true })
  let ready: Promise<void> = Promise.resolve()
  const dispose = ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('cua-driver-native'))
    yield async () => {
      lifetime.abort()
      // apply() reports startup failure; teardown still owns its native handle.
      await ready.catch(() => {})
      await Promise.allSettled(pending)
      if (driver !== undefined) {
        await driver.shutdown()
        driver.uniffiDestroy()
      }
    }
    const child = ctx.plugin({
      name: 'computer-use-cua-driver-native-runtime',
      inject: ['tools', 'systemPrompt'],
      apply: mountRuntime,
    })
    yield child.dispose
    ready = Promise.resolve(child).then(() => {})
  }, 'computer-use-cua-driver-native.runtime')
  try {
    await ready
  } catch (error) {
    await dispose()
    throw error
  }

  /** The child owns tool registrations; the outer effect owns native teardown. */
  async function mountRuntime(inner: Context): Promise<void> {
    const { CuaDriver } = await import('@trycua/cua-driver')
    lifetime.signal.throwIfAborted()
    // The generated constructor returns its class with an owned binding handle,
    // but declares only CuaDriverLike, which omits uniffiDestroy().
    const activeDriver = driver = CuaDriver.create(undefined) as NativeDriver
    const catalog = ToolCatalog.parse(JSON.parse(await activeDriver.listToolsJson({ signal: lifetime.signal })))
    lifetime.signal.throwIfAborted()
    const names = new Set<string>()
    // One in-flight call per target keeps concurrent sessions from interleaving input on the same
    // window. Different targets stay independent: the driver itself has no such queue on this
    // surface (the Codex service does, per app instance), so the ordering guarantee lives here.
    const queues = new Map<string, Promise<unknown>>()
    const targetKey = (args: DriverRecord): string => {
      const pid = args['pid']
      const windowId = args['window_id']
      return typeof pid === 'number' && typeof windowId === 'number' ? `${pid}:${windowId}` : ''
    }
    const enqueue = <T>(key: string, run: () => Promise<T>): Promise<T> => {
      if (key.length === 0) return run()
      const previous = queues.get(key) ?? Promise.resolve()
      const next = previous.then(run, run)
      const settled: Promise<unknown> = next.then(() => undefined, () => undefined)
      queues.set(key, settled)
      void settled.then(() => {
        if (queues.get(key) === settled) queues.delete(key)
      })
      return next
    }
    // Last observation per target: powers the diff, region reads, and coordinate binding.
    const observations = new Map<string, WindowObservation>()
    let observationSeq = 0
    const recordObservation = (key: string, parsed: unknown): { previous: WindowObservation | undefined; current: WindowObservation } => {
      const structured = asRecord(asRecord(parsed)?.['structuredContent'])
      const rawElements = structured?.['elements']
      const elements = Array.isArray(rawElements)
        ? rawElements.map(asRecord).filter((row): row is DriverRecord => row !== undefined)
        : []
      const markdown = typeof structured?.['tree_markdown'] === 'string' ? structured['tree_markdown'] : ''
      const frameRaw = asRecord(structured?.['frame'])
      const frame = frameRaw !== undefined && ['x', 'y', 'w', 'h'].every(k => typeof frameRaw[k] === 'number')
        ? { x: frameRaw['x'] as number, y: frameRaw['y'] as number, width: frameRaw['w'] as number, height: frameRaw['h'] as number }
        : undefined
      observationSeq += 1
      const current: WindowObservation = { token: `obs:${observationSeq}`, revision: revisionOf(elements), markdown, elements, ...frame === undefined ? {} : { frame } }
      const previous = observations.get(key)
      observations.set(key, current)
      return { previous, current }
    }
    const invoke = async (name: string, args: DriverRecord, signal: AbortSignal): Promise<{
      rawJson: string
      diff?: { added: string[]; removed: string[] }
      structure?: { added: DriverRecord[]; removed: DriverRecord[]; revision: string; previousRevision: string }
      token?: string
    }> =>
      enqueue(targetKey(args), async () => {
        const raw = await activeDriver.callTool(name, JSON.stringify(args), { signal })
        if (name !== 'get_window_state') return { rawJson: raw.rawJson }
        const parsed = JSON.parse(raw.rawJson) as unknown
        const { previous, current } = recordObservation(targetKey(args), parsed)
        if (previous === undefined) return { rawJson: raw.rawJson, token: current.token }
        return {
          rawJson: raw.rawJson,
          token: current.token,
          diff: diffTreeLines(previous.markdown, current.markdown),
          structure: {
            ...diffElements(previous.elements, current.elements),
            revision: current.revision,
            previousRevision: previous.revision,
          },
        }
      })
    for (const tool of catalog.tools) {
      const publicName = `cua_driver_native__${tool.name}`
      if (!TOOL_NAME.test(publicName)) {
        throw new Error(`Cua Driver tool "${tool.name}" exceeds the supported function-name format`)
      }
      if (names.has(publicName)) throw new Error(`Cua Driver listed tool "${tool.name}" more than once`)
      names.add(publicName)
      const definition = createMcpToolDefinition(inner, {
        name: publicName,
        rawName: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        async call(args, execution) {
          const combined = AbortSignal.any([execution.signal, lifetime.signal])
          combined.throwIfAborted()
          let raw: {
            rawJson: string
            diff?: { added: string[]; removed: string[] }
            structure?: { added: DriverRecord[]; removed: DriverRecord[]; revision: string; previousRevision: string }
            token?: string
          }
          try {
            raw = await invoke(tool.name, args as DriverRecord, combined)
            combined.throwIfAborted()
          } catch (error) {
            // Cancellation stops waiting; it never rolls back input the driver already delivered.
            if (!combined.aborted) throw error
            throw new Error(`${error instanceof Error ? error.message : String(error)} — this call was aborted and its outcome is unknown; delivered input is not rolled back, so re-observe this window before retrying`)
          }
          const parsed = JSON.parse(raw.rawJson) as unknown
          const structured = asRecord(asRecord(parsed)?.['structuredContent']) ?? {}
          const extra: string[] = []
          if (raw.diff !== undefined) {
            const { added, removed } = raw.diff
            const sample = [
              ...added.slice(0, 3).map(line => `+ ${line.trim().slice(0, 100)}`),
              ...removed.slice(0, 3).map(line => `- ${line.trim().slice(0, 100)}`),
            ]
            extra.push(`diff since previous observation: +${added.length} -${removed.length} lines${sample.length === 0 ? ' (no visible change)' : `\n${sample.join('\n')}`}`)
          }
          {
            let windowRecords: string[] = []
            try {
              const parsedWindows = asRecord(JSON.parse(raw.rawJson) as unknown)
              windowRecords = windowListLines(asRecord(parsedWindows?.['structuredContent']) ?? undefined)
            } catch { windowRecords = [] }
            if (windowRecords.length > 0) extra.push(`windows:\n${windowRecords.join('\n')}`)
          }
          {
            const browserLines = browserBindingLines(structured)
            if (browserLines.length > 0) extra.push(browserLines.join('\n'))
            const refLines = browserRefLines(structured)
            if (refLines.length > 0) extra.push(refLines.join('\n'))
          }
          if (raw.structure !== undefined) {
            const { added, removed, revision, previousRevision } = raw.structure
            const describe = (row: DriverRecord, sign: string): string => `${sign} ${describeElement(row)}`
            const sample = [...added.slice(0, 2).map(row => describe(row, '+')), ...removed.slice(0, 2).map(row => describe(row, '-'))]
            extra.push(`structure: +${added.length} -${removed.length} elements; revision=${revision}${revision === previousRevision ? ' (unchanged)' : ` (was ${previousRevision})`}${sample.length === 0 ? '' : `\n${sample.join('\n')}`}`)
          }
          if (raw.token !== undefined) extra.push(`observation_token=${raw.token} (pass it to click_observed to bind coordinates to this observation)`)
          const effect = actionEffectLine(tool.name, structured)
          if (effect !== undefined) extra.push(effect)
          return withDriverDiagnostics(parsed, extra)
        },
      })
      inner.tools.register(definition)
    }
    inner.tools.register({
      name: 'cua_driver_native__assert_window_text',
      description: 'Assert that one exact window currently shows literal text, including non-actionable text the driver predicate check cannot reach. Observes the window fresh, matches each expectation against every returned element, and reports how many elements were searched, so an unsatisfied result describes a known domain instead of an unknown. Clicking, typing and focusing are never performed; pass a returned element_token to act on that element.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          expect: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            description: 'Literals required in the same sample.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Literal text to look for.' },
                mode: { type: 'string', enum: ['contains', 'equals'], description: 'Default contains.' },
                role: { type: 'string', description: 'Optional accessibility role filter, such as AXStaticText.' },
              },
              required: ['text'],
              additionalProperties: false,
            },
          },
          timeout_ms: { type: 'integer', description: 'Wait up to this many milliseconds for all expectations to hold; default 0 samples once.' },
          stable_samples: { type: 'integer', description: 'Consecutive satisfied samples required before success; default 1, maximum 5.' },
        },
        required: ['pid', 'window_id', 'expect'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['satisfied', 'unsatisfied'] },
            searched: { type: 'integer' },
            summary: { type: 'string' },
          },
          required: ['status', 'searched', 'summary'],
          additionalProperties: false,
        },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: (value as WindowTextAssertion).summary }],
      },
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<WindowTextAssertion> {
        const request = asRecord(args) ?? {}
        const expectations = (Array.isArray(request['expect']) ? request['expect'] : []).flatMap((entry) => {
          const row = asRecord(entry)
          const text = row?.['text']
          if (typeof text !== 'string' || text.length === 0) return []
          const mode = row?.['mode'] === 'equals' ? 'equals' as const : 'contains' as const
          const role = row?.['role']
          return [{ text, mode, ...typeof role === 'string' ? { role } : {} }]
        })
        if (expectations.length === 0) {
          throw new Error('assert_window_text requires at least one expectation with non-empty text')
        }
        const requestedTimeout = request['timeout_ms']
        const timeoutMs = typeof requestedTimeout === 'number' ? Math.max(0, requestedTimeout) : 0
        const requestedSamples = request['stable_samples']
        const stableSamples = typeof requestedSamples === 'number' ? Math.max(1, Math.min(5, requestedSamples)) : 1
        const deadline = Date.now() + timeoutMs
        let results = evaluateWindowText(undefined, expectations)
        let satisfied = 0
        for (;;) {
          execution.signal.throwIfAborted()
          const raw = await invoke('get_window_state', {
            pid: request['pid'],
            window_id: request['window_id'],
            include_screenshot: false,
          }, execution.signal)
          const observation = JSON.parse(raw.rawJson) as unknown
          results = evaluateWindowText(asRecord(observation)?.['structuredContent'], expectations)
          satisfied = results.every(result => result.matches.length > 0) ? satisfied + 1 : 0
          if (satisfied >= stableSamples || Date.now() >= deadline) break
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        const searched = results[0]?.searched ?? 0
        const markdownLines = results[0]?.markdownLines ?? 0
        if (satisfied >= stableSamples) {
          const found = results.flatMap(result => result.matches).slice(0, MAX_MATCHES)
            .map(match => match.source === 'tree_markdown'
              ? `tree line ${JSON.stringify(match.value ?? '')}`
              : `${match.role ?? '?'}=${JSON.stringify(match.value ?? '')}${match.element_token === undefined ? '' : ` token=${match.element_token}`}`)
          return {
            status: 'satisfied',
            searched,
            summary: `[cua] assert: satisfied in ${stableSamples} sample(s); read ${searched} elements and ${markdownLines} tree lines; matched ${found.join(', ')}`,
          }
        }
        const missing = results.filter(result => result.matches.length === 0).map(result => JSON.stringify(result.text))
        return {
          status: 'unsatisfied',
          searched,
          summary: `[cua] assert: unsatisfied after ${timeoutMs} ms; read ${searched} elements and ${markdownLines} tree lines; missing ${missing.join(', ')}`,
        }
      },
    })
    /**
     * Persist one captured image and return its durable reference. A model
     * request replays an image block only through `attachment`; a raw base64
     * block would make every later request for this session fail outright.
     */
    const admitCapture = async (data: string, mediaType: string, name: string): Promise<ImageAttachmentRef> => {
      const attachments = inner.get('attachments') as AttachmentStore | undefined
      if (attachments === undefined) throw new Error('the screenshot cannot enter the conversation: no attachment service is mounted')
      return attachments.saveImage({ data: Buffer.from(data, 'base64'), mediaType: mediaType as ImageMediaType, name })
    }
    const renderSummary = (_args: unknown, value: unknown): { type: 'text'; text: string }[] =>
      [{ type: 'text', text: (value as { summary: string }).summary }]
    const renderImageOrText = (_args: unknown, value: unknown): { type: 'text'; text: string }[] => {
      const record = value as { summary?: string; image?: { attachment: ImageAttachmentRef } }
      const blocks: Array<{ type: 'image'; attachment: ImageAttachmentRef } | { type: 'text'; text: string }> = []
      if (record.image !== undefined) blocks.push({ type: 'image', attachment: record.image.attachment })
      blocks.push({ type: 'text', text: record.summary ?? '' })
      return blocks as unknown as { type: 'text'; text: string }[]
    }
    const summarySchema: { type: 'object'; properties: { summary: { type: 'string' } }; required: string[] } = {
      type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'],
    }
    const summaryOutput = { schema: summarySchema, render: renderSummary }
    inner.tools.register({
      name: 'cua_driver_native__diff_window',
      description: 'Observe one exact window and report only what changed since the previous observation of that window, as a line-level diff of the rendered tree. Pass full=true for the whole tree. Reads only: never clicks, types or focuses.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          full: { type: 'boolean', description: 'Return the complete tree instead of only the diff.' },
        },
        required: ['pid', 'window_id'],
        additionalProperties: false,
      },
      output: summaryOutput,
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string }> {
        const request = asRecord(args) ?? {}
        const target = { pid: request['pid'], window_id: request['window_id'] } as DriverRecord
        const raw = await invoke('get_window_state', { ...target, include_screenshot: false }, execution.signal)
        const observation = observations.get(targetKey(target))
        const tree = observation?.markdown ?? ''
        if (raw.diff === undefined || request['full'] === true) {
          return { summary: `[cua] diff: no baseline for this window yet (full tree follows); token=${String(raw.token)}\n${tree.slice(0, 6000)}` }
        }
        const { added, removed } = raw.diff
        const lines = [
          ...added.slice(0, 40).map(line => `+ ${line.trim().slice(0, 160)}`),
          ...removed.slice(0, 40).map(line => `- ${line.trim().slice(0, 160)}`),
        ]
        const structure = raw.structure === undefined
          ? ''
          : `; structure +${raw.structure.added.length} -${raw.structure.removed.length} elements; revision=${raw.structure.revision}${raw.structure.revision === raw.structure.previousRevision ? ' (unchanged)' : ` (was ${raw.structure.previousRevision})`}`
        return { summary: `[cua] diff: +${added.length} -${removed.length} lines since the previous observation${structure}; token=${String(raw.token)}${lines.length === 0 ? ' (no visible change)' : `\n${lines.join('\n')}`}` }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__observe_region',
      description: 'Observe one exact window and return only the elements whose reported frame intersects a window-local rectangle, together with the observation token that a bound click needs. Reads only.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          rect: {
            type: 'object',
            description: 'Window-local rectangle in points (origin = window top-left). Element frames are reported in screen points and are converted with the window origin.',
            properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
            required: ['x', 'y', 'width', 'height'],
            additionalProperties: false,
          },
          limit: { type: 'integer', description: 'Maximum elements to list; default 40.' },
          include_image: { type: 'boolean', description: 'Also return a cropped image of the same window-local rect (same units as x/y/width/height), captured at native resolution.' },
        },
        required: ['pid', 'window_id', 'rect'],
        additionalProperties: false,
      },
      output: { schema: summarySchema, render: renderImageOrText },
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string; image?: { attachment: ImageAttachmentRef } }> {
        const request = asRecord(args) ?? {}
        const target = { pid: request['pid'], window_id: request['window_id'] } as DriverRecord
        const rawRect = asRecord(request['rect']) ?? {}
        const rect: WindowRect = {
          x: Number(rawRect['x']), y: Number(rawRect['y']),
          width: Number(rawRect['width']), height: Number(rawRect['height']),
        }
        const raw = await invoke('get_window_state', { ...target, include_screenshot: false }, execution.signal)
        const observation = observations.get(targetKey(target))
        const origin = windowOrigin(observation?.elements ?? [])
        // The caller works in screenshot pixels, like every other coordinate in this surface; element
        // frames are screen points, so the rect is converted before filtering.
        const rectScale = await pixelScale(execution.signal)
        const rectInPoints: WindowRect = {
          x: rect.x / rectScale, y: rect.y / rectScale,
          width: rect.width / rectScale, height: rect.height / rectScale,
        }
        const hits = elementsInRect(observation?.elements ?? [], rectInPoints, origin)
        const limit = typeof request['limit'] === 'number' ? Math.max(1, request['limit']) : 40
        const regionScale = rectScale
        const listed = hits.slice(0, limit).map((row) => {
          const index = typeof row['element_index'] === 'number' ? row['element_index'] : -1
          const frame = asRecord(row['frame'])
          const fx = frame?.['x']
          const fy = frame?.['y']
          const fw = frame?.['w'] ?? frame?.['width']
          const fh = frame?.['h'] ?? frame?.['height']
          const local = typeof fx === 'number' && typeof fy === 'number' && typeof fw === 'number' && typeof fh === 'number'
            ? (() => {
              const pixels = toPixels({ x: fx - origin.x + fw / 2, y: fy - origin.y + fh / 2 }, regionScale)
              return ` @local=px(${pixels.x},${pixels.y})`
            })()
            : ''
          return `  [${index}] ${describeElement(row)}${local}`
        })
        let image: { attachment: ImageAttachmentRef } | undefined
        let pixelNote = ''
        if (request['include_image'] === true) {
          const shot = await invoke('zoom', {
            ...target, x1: rect.x, y1: rect.y, x2: rect.x + rect.width, y2: rect.y + rect.height,
          }, execution.signal)
          const shotParsed = asRecord(JSON.parse(shot.rawJson) as unknown)
          const blocks = Array.isArray(shotParsed?.['content']) ? shotParsed['content'] : []
          const block = blocks.map(asRecord).find(row => row?.['type'] === 'image' && typeof row['data'] === 'string')
          const meta = asRecord(shotParsed?.['structuredContent']) ?? {}
          if (block === undefined) pixelNote = '; image unavailable'
          else {
            image = {
              attachment: await admitCapture(
                block['data'] as string,
                typeof block['mimeType'] === 'string' ? block['mimeType'] : 'image/jpeg',
                `cua-region-${String(target['window_id'] ?? 'window')}.png`,
              ),
            }
            pixelNote = `; image=${String(meta['width'] ?? '?')}x${String(meta['height'] ?? '?')}px ${String(meta['format'] ?? '?')} for ${rect.width}x${rect.height}pt`
          }
        }
        return {
          summary: `[cua] region: ${hits.length} of ${observation?.elements.length ?? 0} elements intersect window-local x=${rect.x} y=${rect.y} w=${rect.width} h=${rect.height} (window origin ${origin.x},${origin.y} in screen points)${pixelNote}; token=${String(raw.token)}${listed.length === 0 ? ' (none)' : `\n${listed.join('\n')}`}`,
          ...(image === undefined ? {} : { image }),
        }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__click_observed',
      description: 'Click at coordinates read from a specific observation. The supplied observation_token must still be the newest one for that window, so coordinates cannot outlive the frame they were measured against; the call refuses instead of clicking when it is stale. Never brings the window to the front.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          x: { type: 'number', description: 'Window-local x in screenshot pixels (points x backing scale).' },
          y: { type: 'number', description: 'Window-local y in screenshot pixels (points x backing scale).' },
          observation_token: { type: 'string', description: 'Token returned by the observation these coordinates were read from.' },
        },
        required: ['pid', 'window_id', 'x', 'y', 'observation_token'],
        additionalProperties: false,
      },
      output: summaryOutput,
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string }> {
        const request = asRecord(args) ?? {}
        const target = { pid: request['pid'], window_id: request['window_id'] } as DriverRecord
        const latest = observations.get(targetKey(target))
        const supplied = request['observation_token']
        if (latest === undefined) {
          throw new Error('click_observed needs an observation of this window first; call get_window_state, diff_window or observe_region')
        }
        if (supplied !== latest.token) {
          throw new Error(`observation_token ${JSON.stringify(supplied)} is not the newest for this window (newest is ${latest.token}); re-observe before clicking`)
        }
        const raw = await invoke('click', { ...target, x: request['x'], y: request['y'] }, execution.signal)
        const structured = asRecord(asRecord(JSON.parse(raw.rawJson) as unknown)?.['structuredContent']) ?? {}
        const effect = actionEffectLine('click', structured)
        return { summary: `[cua] click_observed: bound to ${latest.token}; input delivered\n${effect === undefined ? '[cua] effect={"verified":true}' : `[cua] ${effect}`}` }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__wait_stable',
      description: 'Observe one exact window repeatedly until its rendered tree stops changing for a requested interval, instead of sleeping a fixed time. Reports how many samples it took and how long it waited, so a caller can tell a settled UI from a busy one. Reads only: never clicks, types or focuses.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          stable_ms: { type: 'integer', description: 'Required unchanged interval in milliseconds; default 400.' },
          timeout_ms: { type: 'integer', description: 'Give up after this many milliseconds; default 5000.' },
          interval_ms: { type: 'integer', description: 'Delay between samples in milliseconds; default 120.' },
        },
        required: ['pid', 'window_id'],
        additionalProperties: false,
      },
      output: summaryOutput,
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string }> {
        const request = asRecord(args) ?? {}
        const target = { pid: request['pid'], window_id: request['window_id'] } as DriverRecord
        const stableMs = typeof request['stable_ms'] === 'number' ? Math.max(0, request['stable_ms']) : 400
        const timeoutMs = typeof request['timeout_ms'] === 'number' ? Math.max(0, request['timeout_ms']) : 5000
        const intervalMs = typeof request['interval_ms'] === 'number' ? Math.max(1, request['interval_ms']) : 120
        let token: string | undefined
        const outcome = await waitForStable(async () => {
          execution.signal.throwIfAborted()
          const raw = await invoke('get_window_state', { ...target, include_screenshot: false }, execution.signal)
          token = raw.token
          return { changed: raw.diff !== undefined && raw.diff.added.length + raw.diff.removed.length > 0 }
        }, { stableMs, timeoutMs, intervalMs, signal: execution.signal })
        return {
          summary: outcome.stable
            ? `[cua] stable: tree unchanged for ${stableMs} ms; samples=${outcome.samples} waited=${outcome.waitedMs} ms; token=${String(token)}`
            : `[cua] unstable: tree still changing after ${outcome.waitedMs} ms; samples=${outcome.samples}; last change ${outcome.lastChangeAgoMs} ms ago`,
        }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__type_text_verified',
      description: 'Type text into a window and report whether that text is actually present afterwards. Optionally clears the field first (select all + delete) and presses Return only after the readback confirmed the text, so a submit never sends unverified content. Types only; never brings the window forward.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          text: { type: 'string', description: 'Text to type.' },
          clear: { type: 'boolean', description: 'Select all and delete before typing.' },
          submit: { type: 'boolean', description: 'Press Return after a verified readback.' },
        },
        required: ['pid', 'window_id', 'text'],
        additionalProperties: false,
      },
      output: summaryOutput,
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string }> {
        const request = asRecord(args) ?? {}
        const target = { pid: request['pid'], window_id: request['window_id'] } as DriverRecord
        const text = typeof request['text'] === 'string' ? request['text'] : ''
        const notes: string[] = []
        if (request['clear'] === true) {
          await invoke('hotkey', { ...target, keys: ['cmd', 'a'] }, execution.signal)
          await invoke('press_key', { ...target, key: 'delete' }, execution.signal)
          notes.push('cleared')
        }
        const leaseDir = process.env['DSH_CUA_LEASE_DIR']
        const leaseOwner = String((execution as unknown as { agent?: { session?: { id?: string } } }).agent?.session?.id ?? process.pid)
        const leaseKey = `win:${String(request['pid'])}:${String(request['window_id'])}`
        const leaseOptions = leaseDir === undefined ? {} : { dir: leaseDir }
        const held = await acquireLease(leaseKey, leaseOwner, leaseOptions)
        if (!held.ok) {
          return { summary: `[cua] type_text_verified: busy — ${held.reason}; another agent holds this window, so nothing was typed` }
        }
        try {
          await invoke('type_text', { ...target, text }, execution.signal)
        } finally {
          await releaseLease(leaseKey, leaseOwner, leaseDir)
        }
        notes.push(`typed ${text.length} chars`)
        const observed = await invoke('get_window_state', { ...target, include_screenshot: false }, execution.signal)
        const structured = asRecord(asRecord(JSON.parse(observed.rawJson) as unknown)?.['structuredContent']) ?? {}
        // Literal matching first; a selection the caret consumed can swallow surrounding whitespace,
        // so fall back to the trimmed form and say which one matched instead of reporting a false negative.
        let matched = text.length > 0
          && (evaluateWindowText(structured, [{ text, mode: 'contains' }])[0]?.matches.length ?? 0) > 0
        let normalized = false
        const trimmed = text.trim()
        if (!matched && trimmed.length > 0 && trimmed !== text) {
          matched = (evaluateWindowText(structured, [{ text: trimmed, mode: 'contains' }])[0]?.matches.length ?? 0) > 0
          normalized = matched
        }
        let submitted = false
        if (request['submit'] === true && matched) {
          await invoke('press_key', { ...target, key: 'return' }, execution.signal)
          submitted = true
        }
        const tail = request['submit'] === true && !matched
          ? '; submit skipped because the readback did not confirm the text'
          : submitted ? '; submitted' : ''
        return {
          summary: `[cua] type_text_verified: ${notes.join(', ')}; readback: ${matched ? `verified${normalized ? ' (whitespace-normalized match)' : ''}` : 'not verified'}${matched ? '' : ' — verification_required, do not report this as typed'}${tail}`,
        }
      },
    })
    const screenshots = new Map<string, ScreenshotBinding>()
    const ledger = new Map<string, LedgerEntry>()
    let backingScale: number | undefined
    const pixelScale = async (signal: AbortSignal): Promise<number> => {
      if (backingScale !== undefined) return backingScale
      try {
        const raw = await invoke('get_screen_size', {}, signal)
        const sc = asRecord(asRecord(JSON.parse(raw.rawJson) as unknown)?.['structuredContent']) ?? {}
        backingScale = typeof sc['scale_factor'] === 'number' ? sc['scale_factor'] : 1
      } catch { backingScale = 1 }
      return backingScale
    }
    inner.tools.register({
      name: 'cua_driver_native__probe_app',
      description: 'First contact with an app this session has never driven: is the accessibility tree readable, does a click move the content, does a keystroke land — then recommend a route (ax-pixels / cdp / keyboard / vision) with the evidence. Read-only unless confirm:true, because an unknown app can have destructive controls.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          confirm: { type: 'boolean', description: 'Required to actually click or type. Without it the probe only reads.' },
          click_element: { type: 'integer', description: 'Index into the observed elements to click as the click probe. Pick one whose effect you are willing to cause.' },
          key: { type: 'string', description: 'Single character typed into the first text field as the keyboard probe; the probe undoes it afterwards.' },
        },
        required: ['pid', 'window_id'],
        additionalProperties: false,
      },
      output: summaryOutput,
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string }> {
        const request = asRecord(args) ?? {}
        const pid = Number(request['pid'])
        const windowId = Number(request['window_id'])
        if (!Number.isFinite(pid) || !Number.isFinite(windowId)) return { summary: '[cua] probe_app: pid and window_id are required' }
        const confirm = request['confirm'] === true
        const observe = async (): Promise<{ elements: DriverRecord[]; tree: string }> => {
          const raw = await invoke('get_window_state', { pid, window_id: windowId, include_screenshot: false }, execution.signal)
          const structured = asRecord(asRecord(JSON.parse(raw.rawJson) as unknown)?.['structuredContent']) ?? {}
          return {
            elements: Array.isArray(structured['elements']) ? (structured['elements'] as DriverRecord[]) : [],
            tree: String(structured['tree_markdown'] ?? ''),
          }
        }
        const initial = await observe()
        const treeReadable = initial.elements.length > 0
        const bundle = await resolveAppBundle(pid)
        const profile = appProfile({
          ...bundle.bundleId === undefined ? {} : { bundleId: bundle.bundleId },
          ...bundle.bundlePath === undefined ? {} : { bundlePath: bundle.bundlePath },
          frameworkNames: bundle.frameworkNames,
        })

        let clickChanged: boolean | null = null
        let clickNote = 'not attempted (pass confirm:true and click_element)'
        const clickIndex = typeof request['click_element'] === 'number' ? request['click_element'] : undefined
        if (confirm && clickIndex !== undefined) {
          const element = initial.elements[clickIndex]
          const frame = asRecord(element?.['frame'])
          if (frame === undefined) {
            clickNote = `element ${String(clickIndex)} has no frame`
          } else {
            const origin = windowOrigin(initial.elements)
            const scale = await pixelScale(execution.signal)
            const x = Math.round((Number(frame['x']) + Number(frame['w']) / 2 - origin.x) * scale)
            const y = Math.round((Number(frame['y']) + Number(frame['h']) / 2 - origin.y) * scale)
            await invoke('click', { pid, window_id: windowId, x, y }, execution.signal)
            const after = await observe()
            const revisionMoved = revisionOf(after.elements) !== revisionOf(initial.elements)
            const treeMoved = after.tree !== initial.tree
            clickChanged = revisionMoved || treeMoved
            clickNote = `clicked element ${String(clickIndex)} at px(${String(x)},${String(y)}); revision ${revisionMoved ? 'moved' : 'unchanged'}, tree ${treeMoved ? 'changed' : 'unchanged'}`
          }
        }

        let keyLanded: boolean | null = null
        let keyNote = 'not attempted (pass confirm:true and key)'
        const keyChar = typeof request['key'] === 'string' ? request['key'] : undefined
        if (confirm && keyChar !== undefined) {
          const field = initial.elements.find(entry => /text|textarea/i.test(String(entry['role'] ?? '')))
          const token = typeof field?.['element_token'] === 'string' ? String(field['element_token']) : undefined
          if (token === undefined) {
            keyNote = 'no text field in the tree, so a keystroke has nothing observable to land in'
          } else {
            const marker = keyChar.toLowerCase()
            await invoke('click', { pid, window_id: windowId, element_token: token }, execution.signal).catch(() => undefined)
            const valueOf = (tree: string): string => /AXTextArea = "([^"]*)"/.exec(tree)?.[1] ?? /AXTextField = "([^"]*)"/.exec(tree)?.[1] ?? ''
            const beforeValue = valueOf(initial.tree)
            // A real key event, not an AX write: AX writes bypass the undo stack, so the probe could
            // not restore what it typed (measured 2026-10-19: cmd+z left the character behind).
            await invoke('press_key', { pid, window_id: windowId, key: marker, delivery_mode: 'foreground' }, execution.signal).catch(() => undefined)
            const after = await observe()
            const afterValue = valueOf(after.tree)
            keyLanded = afterValue !== beforeValue && afterValue.includes(marker)
            keyNote = `typed ${JSON.stringify(marker)}; value ${JSON.stringify(beforeValue.slice(0, 40))} → ${JSON.stringify(afterValue.slice(0, 40))}`
            await invoke('hotkey', { pid, window_id: windowId, keys: ['cmd', 'z'], delivery_mode: 'foreground' }, execution.signal).catch(() => undefined)
            const restoredValue = valueOf((await observe()).tree)
            if (restoredValue !== beforeValue) keyNote += `; WARNING undo left the document as ${JSON.stringify(restoredValue.slice(0, 40))} — restore it yourself`
          }
        }

        const verdict = routeVerdict({
          treeReadable,
          clickChanged,
          keyLanded,
          chromium: profile.hasChromiumInputSurface,
          electron: profile.isElectron,
        })
        return {
          summary: `[cua] probe_app: pid=${String(pid)} window=${String(windowId)} bundle=${bundle.bundleId ?? '(unknown)'}\n  class: electron=${String(profile.isElectron)} cef=${String(profile.hasCef)} chromium=${String(profile.hasChromiumInputSurface)}\n  tree: readable=${String(treeReadable)} elements=${String(initial.elements.length)}\n  click: changed=${String(clickChanged)} — ${clickNote}\n  keyboard: landed=${String(keyLanded)} — ${keyNote}\n  route: ${verdict.route} (${verdict.confidence}) — ${verdict.reason}\n  next: ${verdict.next}`,
        }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__capture_window',
      description: 'Capture one window screenshot and report its content id. Coordinates read from that image can only be clicked by passing the same id to click_screenshot, so a click can never be aimed at pixels that were replaced. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          include_image: { type: 'boolean', description: 'Return the image itself; default true.' },
        },
        required: ['pid', 'window_id'],
        additionalProperties: false,
      },
      output: {
        schema: summarySchema,
        render: renderImageOrText,
      },
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string; image?: { attachment: ImageAttachmentRef } }> {
        const request = asRecord(args) ?? {}
        const target = { pid: request['pid'], window_id: request['window_id'] } as DriverRecord
        const raw = await invoke('get_window_state', {
          ...target, include_screenshot: true, include_accessibility_tree: false,
        }, execution.signal)
        const parsed = asRecord(JSON.parse(raw.rawJson) as unknown)
        const content = Array.isArray(parsed?.['content']) ? parsed['content'] : []
        const image = content.map(asRecord).find(block => block?.['type'] === 'image' && typeof block['data'] === 'string')
        if (image === undefined) throw new Error('this window produced no image; capture is unavailable for it')
        const data = image['data'] as string
        const mimeType = typeof image['mimeType'] === 'string' ? image['mimeType'] : 'image/png'
        const bytes = Buffer.from(data, 'base64')
        const id = screenshotId(bytes)
        screenshots.set(targetKey(target), { id, at: Date.now() })
        const attachment = request['include_image'] === false
          ? undefined
          : await admitCapture(data, mimeType, `cua-capture-${String(target['window_id'] ?? 'window')}.png`)
        return {
          summary: `[cua] capture: screenshot_id=${id} bytes=${bytes.length} type=${mimeType}; click only with this id`,
          ...(attachment === undefined ? {} : { image: { attachment } }),
        }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__click_screenshot',
      description: 'Click at window-local coordinates read from a specific capture, identified by its screenshot_id. Refuses when that capture is not the newest one for the window or is older than 60 seconds, because the pixels the caller measured may have been replaced. Never brings the window forward.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          x: { type: 'number', description: 'Window-local x in screenshot pixels (points x backing scale).' },
          y: { type: 'number', description: 'Window-local y in screenshot pixels (points x backing scale).' },
          screenshot_id: { type: 'string', description: 'Id returned by capture_window for the image these coordinates were read from.' },
        },
        required: ['pid', 'window_id', 'x', 'y', 'screenshot_id'],
        additionalProperties: false,
      },
      output: summaryOutput,
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string }> {
        const request = asRecord(args) ?? {}
        const target = { pid: request['pid'], window_id: request['window_id'] } as DriverRecord
        const verdict = bindingMatches(screenshots.get(targetKey(target)), request['screenshot_id'])
        if (!verdict.ok) throw new Error(`click_screenshot refused: ${verdict.reason}`)
        const raw = await invoke('click', { ...target, x: request['x'], y: request['y'] }, execution.signal)
        const structured = asRecord(asRecord(JSON.parse(raw.rawJson) as unknown)?.['structuredContent']) ?? {}
        const effect = actionEffectLine('click', structured)
        return { summary: `[cua] click_screenshot: bound to ${String(request['screenshot_id'])}; input delivered\n${effect === undefined ? '[cua] effect={"verified":true}' : `[cua] ${effect}`}` }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__permissions_report',
      description: 'Report the permissions this runtime can actually measure, one line each, with granted/denied/unprobed and the evidence. Never prompts and never treats an unmeasured permission as granted.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: summaryOutput,
      async execute(): Promise<{ summary: string }> {
        const driverReport = await invoke('check_permissions', {}, lifetime.signal).catch(() => undefined)
        const structured = driverReport === undefined ? {} : asRecord(asRecord(JSON.parse(driverReport.rawJson) as unknown)?.['structuredContent']) ?? {}
        const findings = await permissionReport([
          {
            name: 'accessibility',
            probe: async () => typeof structured['accessibility'] === 'boolean'
              ? { granted: structured['accessibility'] as boolean, evidence: `check_permissions reports accessibility=${String(structured['accessibility'])}` }
              : Promise.reject(new Error('check_permissions returned no accessibility field')),
          },
          {
            name: 'screen-recording',
            probe: async () => typeof structured['screen_recording'] === 'boolean'
              ? { granted: structured['screen_recording'] as boolean, evidence: `check_permissions reports screen_recording=${String(structured['screen_recording'])}` }
              : Promise.reject(new Error('check_permissions returned no screen_recording field')),
          },
          {
            name: 'full-disk-access',
            probe: async () => {
              const { open } = await import('node:fs/promises')
              const handle = await open('/Library/Application Support/com.apple.TCC/TCC.db', 'r')
              try { await handle.read(Buffer.alloc(16), 0, 16, 0) } finally { await handle.close() }
              return { granted: true, evidence: 'the TCC database header is readable' }
            },
          },
          {
            name: 'apple-events',
            probe: async () => { throw new Error('no non-prompting probe exists for AppleEvents automation consent') },
          },
        ])
        const lines = findings.map(finding => `  ${finding.name}: ${finding.state} — ${finding.evidence.slice(0, 140)}`)
        return { summary: `[cua] permissions (${findings.filter(f => f.state === 'granted').length} granted / ${findings.length} checked)\n${lines.join('\n')}` }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__app_profile',
      description: 'Report how an app\'s UI is built (Electron, CEF, Chromium-family, or plain native) from frameworks the bundle actually contains, so a caller can pick a delivery route instead of guessing. Reads only.',
      parameters: {
        type: 'object',
        properties: { pid: { type: 'integer', description: 'Running process id to classify.' } },
        required: ['pid'],
        additionalProperties: false,
      },
      output: summaryOutput,
      async execute(args: unknown): Promise<{ summary: string }> {
        const request = asRecord(args) ?? {}
        const pid = request['pid']
        const { execFileSync } = await import('node:child_process')
        const { readdir } = await import('node:fs/promises')
        let executable = ''
        try { executable = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim() } catch { executable = '' }
        const match = /^(.*?\.app)\//.exec(executable)
        const bundlePath = match?.[1]
        let bundleId: string | undefined
        if (bundlePath !== undefined) {
          try {
            bundleId = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', `${bundlePath}/Contents/Info.plist`], { encoding: 'utf8' }).trim()
          } catch { bundleId = undefined }
        }
        let frameworkNames: string[] = []
        if (bundlePath !== undefined) {
          try { frameworkNames = await readdir(`${bundlePath}/Contents/Frameworks`) } catch { frameworkNames = [] }
        }
        const profile = appProfile({ ...bundleId === undefined ? {} : { bundleId }, ...bundlePath === undefined ? {} : { bundlePath }, frameworkNames })
        const route = profile.hasChromiumInputSurface
          ? 'prefer the accessibility route and expect synthetic input to need a Chromium-aware path'
          : 'native: accessibility route covers most controls'
        return {
          summary: `[cua] app_profile: electron=${profile.isElectron} cef=${profile.hasCef} chromium-input=${profile.hasChromiumInputSurface}\n  pid=${String(pid)} bundle=${profile.bundleId ?? '(unknown)'} path=${profile.bundlePath ?? '(unknown)'}\n  evidence=${profile.evidence.join('; ') || '(none)'}\n  hint=${route}`,
        }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__select_text',
      description: 'Select text and report what was actually selected. Modes: all (whole document), line (caret to end of line), chars (caret plus N characters). Puts the caret at at_x/at_y first when given, then extends with shift+arrow, copies, and reads the selection back from the clipboard, so an empty selection is visible instead of silently succeeding.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          mode: { type: 'string', enum: ['all', 'line', 'chars'], description: 'How to select; default chars.' },
          count: { type: 'integer', description: 'Characters to extend for mode=chars; default 6.' },
          at_x: { type: 'number', description: 'Window-local x in screenshot pixels to place the caret before extending.' },
          at_y: { type: 'number', description: 'Window-local y in screenshot pixels to place the caret before extending.' },
        },
        required: ['pid', 'window_id'],
        additionalProperties: false,
      },
      output: summaryOutput,
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string }> {
        const request = asRecord(args) ?? {}
        const target = { pid: request['pid'], window_id: request['window_id'] } as DriverRecord
        const mode = request['mode'] === 'all' || request['mode'] === 'line' ? request['mode'] : 'chars'
        const count = typeof request['count'] === 'number' ? request['count'] : 6
        const notes: string[] = []
        if (typeof request['at_x'] === 'number' && typeof request['at_y'] === 'number') {
          await invoke('click', { ...target, x: request['at_x'], y: request['at_y'] }, execution.signal)
          notes.push(`caret at (${String(request['at_x'])},${String(request['at_y'])})`)
        }
        for (const step of selectionPlan(mode, count)) {
          if (step.kind === 'hotkey') await invoke('hotkey', { ...target, keys: step.keys }, execution.signal)
          else await invoke('press_key', { ...target, key: step.key, modifiers: step.modifiers }, execution.signal)
        }
        notes.push(mode === 'all' ? 'selected all' : mode === 'line' ? 'extended to line end' : `extended by ${String(count)} chars`)
        await invoke('hotkey', { ...target, keys: ['cmd', 'c'] }, execution.signal)
        let selected = ''
        try {
          const { execFileSync } = await import('node:child_process')
          selected = execFileSync('pbpaste', { encoding: 'utf8' }).slice(0, 200)
        } catch { selected = '' }
        return {
          summary: selected.length === 0
            ? `[cua] select_text: ${notes.join(', ')}; copied; selection looks empty (clipboard unchanged or nothing selected); verification_required`
            : `[cua] select_text: ${notes.join(', ')}; copied; selected=${JSON.stringify(selected)}`,
        }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__click_verified',
      description: 'Click at coordinates and then check whether the declared effect actually happened: it captures the content revision before, clicks, waits for the window to settle, re-observes, and reports whether the expected text appeared (or what changed). A click that changed nothing is reported as not verified, never as success. Use this after reading a target off a screenshot.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          x: { type: 'number', description: 'Window-local x in screenshot pixels (points x backing scale).' },
          y: { type: 'number', description: 'Window-local y in screenshot pixels (points x backing scale).' },
          expect_text: { type: 'string', description: 'Text that must appear after the click for the action to count as verified.' },
          screenshot_id: { type: 'string', description: 'Capture id these coordinates were read from, when they came from an image.' },
          stable_ms: { type: 'integer', description: 'Settle window in milliseconds; default 400.' },
          timeout_ms: { type: 'integer', description: 'Give up settling after this long; default 3000.' },
          allow_repeat: { type: 'boolean', description: 'Repeat even though the same action was already attempted recently.' },
        },
        required: ['pid', 'window_id', 'x', 'y'],
        additionalProperties: false,
      },
      output: summaryOutput,
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string }> {
        const request = asRecord(args) ?? {}
        const target = { pid: request['pid'], window_id: request['window_id'] } as DriverRecord
        const actionKey = `click_verified:${String(request['pid'])}:${String(request['window_id'])}:${String(request['x'])},${String(request['y'])}:${String(request['expect_text'] ?? '')}`
        if (request['allow_repeat'] !== true) {
          const decision = duplicateCheck(ledger, actionKey, Date.now())
          if (decision.action !== 'proceed') {
            return { summary: `[cua] click_verified: skipped — ${decision.reason}` }
          }
        }
        if (request['screenshot_id'] !== undefined) {
          const verdict = bindingMatches(screenshots.get(targetKey(target)), request['screenshot_id'])
          if (!verdict.ok) throw new Error(`click_verified refused: ${verdict.reason}`)
        }
        const before = await invoke('get_window_state', { ...target, include_screenshot: false }, execution.signal)
        const beforeParsed = asRecord(JSON.parse(before.rawJson) as unknown)
        const beforeState = asRecord(beforeParsed?.['structuredContent']) ?? {}
        const beforeRevision = stateRevision(
          Array.isArray(beforeState['elements']) ? beforeState['elements'] as DriverRecord[] : [],
          typeof beforeState['tree_markdown'] === 'string' ? beforeState['tree_markdown'] : '',
        )

        // A second agent on this machine shares the window, the clipboard and the foreground. The
        // lease makes our own agents polite to each other; a foreign agent never takes it, so the
        // revision comparison further down is what protects us from that one.
        const leaseDir = process.env['DSH_CUA_LEASE_DIR']
        const leaseOwner = String((execution as unknown as { agent?: { session?: { id?: string } } }).agent?.session?.id ?? process.pid)
        const leaseKey = `win:${String(request['pid'])}:${String(request['window_id'])}`
        const leaseOptions = leaseDir === undefined ? {} : { dir: leaseDir }
        const held = await acquireLease(leaseKey, leaseOwner, leaseOptions)
        if (!held.ok) {
          return { summary: `[cua] click_verified: busy — ${held.reason}; another agent holds this window, so nothing was clicked` }
        }
        try {
          await invoke('click', { ...target, x: request['x'], y: request['y'] }, execution.signal)
        } finally {
          await releaseLease(leaseKey, leaseOwner, leaseDir)
        }

        const stableMs = typeof request['stable_ms'] === 'number' ? request['stable_ms'] : 400
        const timeoutMs = typeof request['timeout_ms'] === 'number' ? request['timeout_ms'] : 3000
        let afterState: DriverRecord = {}
        await waitForStable(async () => {
          const raw = await invoke('get_window_state', { ...target, include_screenshot: false }, execution.signal)
          const parsed = asRecord(JSON.parse(raw.rawJson) as unknown)
          afterState = asRecord(parsed?.['structuredContent']) ?? {}
          const revision = stateRevision(
            Array.isArray(afterState['elements']) ? afterState['elements'] as DriverRecord[] : [],
            typeof afterState['tree_markdown'] === 'string' ? afterState['tree_markdown'] : '',
          )
          return { changed: revision !== beforeRevision }
        }, { stableMs, timeoutMs, intervalMs: 150 })

        const afterRevision = stateRevision(
          Array.isArray(afterState['elements']) ? afterState['elements'] as DriverRecord[] : [],
          typeof afterState['tree_markdown'] === 'string' ? afterState['tree_markdown'] : '',
        )
        const expectText = typeof request['expect_text'] === 'string' ? request['expect_text'] : undefined
        const textAppeared = expectText === undefined || expectText.length === 0
          ? undefined
          : (evaluateWindowText(afterState, [{ text: expectText, mode: 'contains' }])[0]?.matches.length ?? 0) > 0
        const textPresentBefore = expectText === undefined || expectText.length === 0
          ? undefined
          : (evaluateWindowText(beforeState, [{ text: expectText, mode: 'contains' }])[0]?.matches.length ?? 0) > 0
        const windowFrame = (() => {
          const elements = Array.isArray(beforeState['elements']) ? beforeState['elements'] as DriverRecord[] : []
          const root = elements.find(row => row['role'] === 'AXWindow')
          const frame = asRecord(root?.['frame'])
          return frame === undefined ? undefined : { w: typeof frame['w'] === 'number' ? frame['w'] : undefined, h: typeof frame['h'] === 'number' ? frame['h'] : undefined }
        })()
        const hint = smallWindowHint(windowFrame)
        const verdict = actionVerdict({
          beforeRevision,
          afterRevision,
          ...textAppeared === undefined ? {} : { textAppeared },
          ...textPresentBefore === undefined ? {} : { textPresentBefore },
          ...expectText === undefined ? {} : { expectText },
        })
        ledger.set(actionKey, { key: actionKey, at: Date.now(), outcome: verdict.verified ? 'verified' : 'unverified' })
        return {
          summary: `${hint === undefined ? '' : `[cua] ${hint}\n`}[cua] click_verified: ${verdict.verified ? 'verified' : 'not verified — verification_required'}${verdict.verified ? '' : ', do not report this as done'}\n  ${verdict.detail}\n  [cua] effect={"verified":${String(verdict.verified)},"effect":"${verdict.verified ? 'observed' : 'unverifiable'}","verification_required":${String(!verdict.verified)}}`,
        }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__wait_settled',
      description: 'Wait until a window stops changing on BOTH its accessibility tree and its pixels. A spinner or animation repaints while the tree stands still, so a tree-only check reports a busy window as settled. Reports which signal was still moving when it timed out. Reads only.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          stable_ms: { type: 'integer', description: 'Required unchanged interval in milliseconds; default 400.' },
          timeout_ms: { type: 'integer', description: 'Give up after this many milliseconds; default 5000.' },
          interval_ms: { type: 'integer', description: 'Delay between samples in milliseconds; default 120.' },
        },
        required: ['pid', 'window_id'],
        additionalProperties: false,
      },
      output: summaryOutput,
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string }> {
        const request = asRecord(args) ?? {}
        const target = { pid: request['pid'], window_id: request['window_id'] } as DriverRecord
        const stableMs = typeof request['stable_ms'] === 'number' ? Math.max(0, request['stable_ms']) : 400
        const timeoutMs = typeof request['timeout_ms'] === 'number' ? Math.max(0, request['timeout_ms']) : 5000
        const intervalMs = typeof request['interval_ms'] === 'number' ? Math.max(1, request['interval_ms']) : 120
        // Pixels are compared as a coarse grid with two statistics, not as bytes: a blinking caret
        // or an overlay repaints a few pixels, and an exact hash then calls a quiet window busy
        // (measured on a Windows desktop: 9 samples over 6.3 s reported "moving").
        let previousGrid: number[] | undefined
        let lastExact = 'none'
        const seenExact = new Set<string>()
        const outcome = await waitForSettled(async () => {
          execution.signal.throwIfAborted()
          const treeRaw = await invoke('get_window_state', { ...target, include_screenshot: false }, execution.signal)
          const treeState = asRecord(asRecord(JSON.parse(treeRaw.rawJson) as unknown)?.['structuredContent']) ?? {}
          const shotRaw = await invoke('get_window_state', { ...target, include_screenshot: true, include_accessibility_tree: false }, execution.signal)
          const shotParsed = asRecord(JSON.parse(shotRaw.rawJson) as unknown)
          const blocks = Array.isArray(shotParsed?.['content']) ? shotParsed['content'] : []
          const image = blocks.map(asRecord).find(block => block?.['type'] === 'image' && typeof block['data'] === 'string')
          let pixels = 'no-image'
          let moving = false
          if (image !== undefined) {
            const bytes = Buffer.from(image['data'] as string, 'base64')
            lastExact = screenshotId(bytes)
            seenExact.add(lastExact)
            try {
              const grid = analysisLuma(bytes)
              pixels = settleSignature(previousGrid, grid)
              moving = pixels.startsWith('moving')
              previousGrid = grid
            } catch {
              // Undecodable image: fall back to the exact hash and let the summary say which signal ran.
              pixels = `exact:${lastExact}`
            }
          }
          return {
            tree: typeof treeState['tree_markdown'] === 'string' ? treeState['tree_markdown'] : '',
            pixels,
            moving,
          }
        }, { stableMs, timeoutMs, intervalMs, signal: execution.signal })
        const moving = [outcome.treeChanged ? 'tree' : '', outcome.pixelsChanged ? 'pixels' : ''].filter(Boolean).join('+')
        return {
          summary: outcome.settled
            ? `[cua] settled: tree and pixel grid unchanged for ${stableMs} ms; samples=${outcome.samples} waited=${outcome.waitedMs} ms; exactHashes=${seenExact.size} (bytes may differ; the grid did not)`
            : `[cua] not settled: still changing after ${outcome.waitedMs} ms; samples=${outcome.samples}; last moving signal=${moving || 'unknown'}; exactHashes=${seenExact.size}`,
        }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__assert_goal',
      description: 'Judge whether a stated end condition holds on one window: met, not met, or unknown. An unreadable or empty observation is unknown, never met, so a task is never reported done on a screen that was not measured.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          conditions: {
            type: 'array',
            description: 'Conditions that together mean the task is done: {text} must be visible, {absent} must be gone.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Literal text that must be visible.' },
                absent: { type: 'string', description: 'Literal text that must be absent.' },
              },
              additionalProperties: false,
            },
          },
        },
        required: ['pid', 'window_id', 'conditions'],
        additionalProperties: false,
      },
      output: summaryOutput,
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string }> {
        const request = asRecord(args) ?? {}
        const target = { pid: request['pid'], window_id: request['window_id'] } as DriverRecord
        const conditions = Array.isArray(request['conditions'])
          ? request['conditions'].map(entry => asRecord(entry) ?? {}).map(entry => ({
            ...typeof entry['text'] === 'string' ? { text: entry['text'] } : {},
            ...typeof entry['absent'] === 'string' ? { absent: entry['absent'] } : {},
          }))
          : []
        const raw = await invoke('get_window_state', { ...target, include_screenshot: false }, execution.signal)
        const parsed = asRecord(JSON.parse(raw.rawJson) as unknown)
        const state = asRecord(parsed?.['structuredContent']) ?? {}
        const elements = Array.isArray(state['elements']) ? state['elements'] as DriverRecord[] : []
        const tree = typeof state['tree_markdown'] === 'string' ? state['tree_markdown'] : ''
        const degraded = elements.length === 0 && tree.trim().length === 0
        const visible = degraded ? undefined : `${tree}\n${elements.map(row => `${String(row['label'] ?? '')} ${String(row['value'] ?? '')}`).join('\n')}`
        const verdict = goalVerdict(conditions, visible, degraded)
        return { summary: `[cua] assert_goal: ${verdict.verdict}${verdict.verdict === 'met' ? '' : verdict.verdict === 'not-met' ? ' — do not report this task as done' : ' — nothing was verified'}\n  ${verdict.reasons.join('\n  ')}` }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__invoke_menu_prepared',
      description: 'Invoke an application menu path after making the window stably key: bring it to the front, click into it when needed, retry once, and report a precondition failure as a precondition rather than as a missing menu item. Mutating: the invoked item runs.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'integer', description: 'Target process id.' },
          window_id: { type: 'integer', description: 'Target window id from list_windows.' },
          path: { type: 'array', items: { type: 'string' }, description: 'Exact menu path, one label per level, outermost first.' },
          click_retry: { type: 'boolean', description: 'Click into the window and retry once when the first attempt is refused; default true.' },
        },
        required: ['pid', 'window_id', 'path'],
        additionalProperties: false,
      },
      output: summaryOutput,
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string }> {
        const request = asRecord(args) ?? {}
        const target = { pid: request['pid'], window_id: request['window_id'] } as DriverRecord
        const path = Array.isArray(request['path']) ? request['path'].filter((entry): entry is string => typeof entry === 'string') : []
        if (path.length === 0) return { summary: '[cua] invoke_menu_prepared: no menu path was given' }
        const attempt = async (): Promise<{ ok: true; raw: string } | { ok: false; message: string }> => {
          try {
            const raw = await invoke('invoke_menu', { ...target, path }, execution.signal)
            return { ok: true, raw: raw.rawJson }
          } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) }
          }
        }
        await invoke('bring_to_front', target, execution.signal).catch(() => undefined)
        let result = await attempt()
        let notes = 'first attempt'
        if (!result.ok && menuPreconditionFailure(result.message) && request['click_retry'] !== false) {
          const observed = await invoke('get_window_state', { ...target, include_screenshot: false }, execution.signal)
          const state = asRecord(asRecord(JSON.parse(observed.rawJson) as unknown)?.['structuredContent']) ?? {}
          const elements = Array.isArray(state['elements']) ? state['elements'] as DriverRecord[] : []
          const frame = asRecord(asRecord(elements.find(row => row['role'] === 'AXWindow')?.['frame'])) ?? {}
          const width = typeof frame['w'] === 'number' ? frame['w'] : 0
          const height = typeof frame['h'] === 'number' ? frame['h'] : 0
          if (width > 0 && height > 0) {
            const scale = await pixelScale(execution.signal)
            const centre = toPixels({ x: width / 2, y: height / 2 }, scale)
            await invoke('click', { ...target, x: centre.x, y: centre.y }, execution.signal).catch(() => undefined)
            result = await attempt()
            notes = 'retried after clicking into the window'
          }
        }
        if (result.ok) return { summary: `[cua] invoke_menu_prepared: invoked ${JSON.stringify(path.join(' > '))} (${notes})` }
        return {
          summary: menuPreconditionFailure(result.message)
            ? `[cua] invoke_menu_prepared: precondition not satisfied — the driver could not confirm this window as stably key and frontmost, so the menu was NOT invoked\n  ${result.message}`
            : `[cua] invoke_menu_prepared: failed — ${result.message}`,
        }
      },
    })
    inner.tools.register({
      name: 'cua_driver_native__clipboard_text',
      description: 'Read the system clipboard as text and return it inline. The driver reports only a type count, so this tool exists to make the text the model asked for actually visible.',
      parameters: {
        type: 'object',
        properties: {
          max_chars: { type: 'integer', description: 'Truncate to this many characters; default 2000.' },
        },
        additionalProperties: false,
      },
      output: summaryOutput,
      async execute(args: unknown, execution: { signal: AbortSignal }): Promise<{ summary: string }> {
        const request = asRecord(args) ?? {}
        const maxChars = typeof request['max_chars'] === 'number' ? Math.max(1, request['max_chars']) : 2000
        const raw = await invoke('clipboard_read', { include_text: true }, execution.signal)
        const parsed = asRecord(JSON.parse(raw.rawJson) as unknown)
        const state = asRecord(parsed?.['structuredContent']) ?? {}
        const types = Array.isArray(state['types']) ? state['types'].filter((entry): entry is string => typeof entry === 'string') : []
        const candidate = state['text'] ?? state['content'] ?? state['data']
        if (typeof candidate !== 'string') {
          return { summary: `[cua] clipboard_text: no plain text on the clipboard (types: ${types.length === 0 ? 'unknown' : types.join(', ')})` }
        }
        const text = candidate.length > maxChars ? `${candidate.slice(0, maxChars)}… (${candidate.length} chars total)` : candidate
        return { summary: `[cua] clipboard_text: ${JSON.stringify(text)}${types.length === 0 ? '' : ` (types: ${types.join(', ')})`}` }
      },
    })
    inner.on('tools/execute', async (exec, next) => {
      if (!names.has(exec.name)) return next()
      const upstream = exec.signal
      exec.signal = AbortSignal.any([upstream, lifetime.signal])
      const operation = Promise.resolve().then(next)
      pending.add(operation)
      try {
        return await operation
      } finally {
        pending.delete(operation)
        exec.signal = upstream
      }
    })
    inner.systemPrompt.section({
      name: 'computer-use:cua-driver-native',
      order: inner.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
      text: GUIDANCE,
    })
  }
}
