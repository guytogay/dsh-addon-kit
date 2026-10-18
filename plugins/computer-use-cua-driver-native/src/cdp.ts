/**
 * Minimal Chrome DevTools Protocol client for browser actions that coordinate clicks cannot reach.
 * Web content does not honour the accessibility press route (see the contract's 8c-bis), so a click
 * on a page has to be delivered as a DOM event through CDP. Node ships a WebSocket client, so this
 * needs no dependency.
 */

/** Verdict for a browser action checked against a declared expectation. */
export interface DomVerdict {
  verified: boolean
  changed: boolean
  expectation: 'text-appeared' | 'text-gone' | 'any-change'
  detail: string
}

/**
 * Decide whether one browser action produced its declared effect.
 * Same rule as the native path: the expectation must be a DELTA. Text that was already on the page
 * cannot be evidence for a click that was supposed to create it.
 * @param beforeText - page text before the action.
 * @param afterText - page text after the action.
 * @param expectText - text that must appear, if the caller declared one.
 * @param absentText - text that must disappear, if the caller declared one.
 * @returns the verdict plus which expectation was applied.
 */
export function domVerdict(
  beforeText: string,
  afterText: string,
  expectText?: string,
  absentText?: string,
): DomVerdict {
  const changed = beforeText !== afterText
  if (expectText !== undefined && expectText.length > 0) {
    const appeared = afterText.includes(expectText) && !beforeText.includes(expectText)
    const already = beforeText.includes(expectText)
    return {
      verified: appeared,
      changed,
      expectation: 'text-appeared',
      detail: already
        ? `${JSON.stringify(expectText.slice(0, 60))} was already on the page before the action, so this action did not produce it`
        : `${JSON.stringify(expectText.slice(0, 60))} ${appeared ? 'appeared' : 'did not appear'}`,
    }
  }
  if (absentText !== undefined && absentText.length > 0) {
    const gone = beforeText.includes(absentText) && !afterText.includes(absentText)
    return {
      verified: gone,
      changed,
      expectation: 'text-gone',
      detail: `${JSON.stringify(absentText.slice(0, 60))} ${gone ? 'is gone' : 'is still present'}`,
    }
  }
  return { verified: false, changed, expectation: 'any-change', detail: `page text ${changed ? 'changed' : 'did not change'}; no expectation was declared, so this is not verified` }
}

/** One short-lived CDP connection bound to a single page target. */
export interface CdpPage {
  evaluate: (expression: string) => Promise<unknown>
  /** Send any CDP method and resolve its result value. */
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  /** Resolve with the next event of this CDP method, or reject after a timeout. */
  once: (method: string, timeoutMs?: number) => Promise<Record<string, unknown>>
  /** Send a CDP method and resolve its whole result object (DOM.* replies are not nested under value). */
  sendRaw: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  close: () => void
}

/** A pointer path expressed in page CSS pixels. */
export interface PagePath {
  from: { x: number; y: number }
  to: { x: number; y: number }
  steps?: number
}

/** Narrow an unknown value to a plain record. */
function asRecordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Drag with real trusted mouse input through CDP.
 * The driver's own click is an accessibility press, which web content ignores (contract 8c-bis), and a
 * drag needs a real press-move-release sequence anyway. Steps are interpolated so the page sees
 * movement rather than a teleport, which is what drag targets tend to key on.
 * @param page - an open page connection.
 * @param path - start, end, and how many intermediate moves to send.
 */
export async function dragOnPage(page: CdpPage, path: PagePath): Promise<void> {
  const steps = Math.max(1, path.steps ?? 6)
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: path.from.x, y: path.from.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: path.from.x + (path.to.x - path.from.x) * ratio,
      y: path.from.y + (path.to.y - path.from.y) * ratio,
      button: 'left',
      buttons: 1,
    })
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: path.to.x, y: path.to.y, button: 'left', buttons: 0, clickCount: 1 })
}

/**
 * Connect to one page target's WebSocket and return an evaluator.
 * @param webSocketDebuggerUrl - the target's ws URL, as listed by /json/list.
 * @param timeoutMs - how long to wait for each reply.
 * @returns an evaluator, a raw sender, an event waiter, and a closer.
 */
export async function openCdpPage(webSocketDebuggerUrl: string, timeoutMs = 10_000): Promise<CdpPage> {
  const socket = new WebSocket(webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const eventWaiters = new Map<string, { resolve: (value: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }>()
  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP socket failed to open')), { once: true })
  })
  socket.addEventListener('message', (event: MessageEvent) => {
    let message: { id?: number; method?: string; params?: unknown; result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string } }; error?: { message?: string } }
    try { message = JSON.parse(String(event.data)) } catch { return }
    if (message.id === undefined) {
      const method = typeof message.method === 'string' ? message.method : ''
      const listener = eventWaiters.get(method)
      if (listener !== undefined) {
        eventWaiters.delete(method)
        clearTimeout(listener.timer)
        listener.resolve(asRecordOf(message.params) ?? {})
      }
      return
    }
    const waiting = pending.get(message.id)
    if (waiting === undefined) return
    pending.delete(message.id)
    clearTimeout(waiting.timer)
    if (message.error !== undefined) { waiting.reject(new Error(message.error.message ?? 'CDP error')); return }
    if (message.result?.exceptionDetails !== undefined) { waiting.reject(new Error(message.result.exceptionDetails.text ?? 'evaluation threw')); return }
    waiting.resolve(message.result !== undefined && Object.keys(message.result).length > 0 && !('result' in message.result) ? message.result : message.result?.result?.value)
  })
  await ready
  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => new Promise<unknown>((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`)) }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const once = (method: string, waitMs = 2000): Promise<Record<string, unknown>> => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => { eventWaiters.delete(method); reject(new Error(`CDP event ${method} did not arrive within ${waitMs} ms`)) }, waitMs)
    eventWaiters.set(method, { resolve, timer })
  })
  const sendRaw = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`)) }, timeoutMs)
    pending.set(id, {
      resolve: value => resolve(asRecordOf(value) ?? {}),
      reject,
      timer,
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return {
    send,
    once,
    sendRaw,
    evaluate: (expression: string) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    close: () => { socket.close() },
  }
}

/**
 * Drag for HTML5 drag-and-drop, which mouse events alone never start.
 * Two layers had to be measured before this could work: a plain press/move/release leaves the drop
 * unfired, and dispatching drag events without interception also leaves it unfired. Chromium only
 * replays them while drag interception is armed, so the sequence arms interception, presses to start
 * the drag, takes the intercepted drag data, replays it on the drop, then disarms.
 * @param page - an open page connection.
 * @param path - start and end in page CSS pixels.
 * @param data - plain text carried as the drag payload when interception yields nothing.
 */
export async function html5DragOnPage(page: CdpPage, path: PagePath, data = 'X'): Promise<void> {
  let dragData: Record<string, unknown> = { items: [{ mimeType: 'text/plain', data }], dragOperationsMask: 1 }
  const canIntercept = typeof page.once === 'function'
  const interceptArmed = canIntercept && await page.send('Input.setInterceptDrags', { enabled: true }).then(() => true).catch(() => false)
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: path.from.x, y: path.from.y, button: 'left', buttons: 1, clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: path.from.x + 2, y: path.from.y + 2, button: 'left', buttons: 1 })
  if (interceptArmed) {
    try {
      const intercepted = await page.once('Input.dragIntercepted', 1500)
      const interceptedData = asRecordOf(intercepted['data'])
      if (interceptedData !== undefined) dragData = interceptedData
    } catch { /* keep the constructed payload */ }
  }
  await page.send('Input.dispatchDragEvent', { type: 'dragEnter', x: path.from.x + 2, y: path.from.y + 2, data: dragData })
  const steps = Math.max(1, path.steps ?? 4)
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps
    await page.send('Input.dispatchDragEvent', {
      type: 'dragOver',
      x: path.from.x + (path.to.x - path.from.x) * ratio,
      y: path.from.y + (path.to.y - path.from.y) * ratio,
      data: dragData,
    })
  }
  await page.send('Input.dispatchDragEvent', { type: 'drop', x: path.to.x, y: path.to.y, data: dragData })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: path.to.x, y: path.to.y, button: 'left', buttons: 0, clickCount: 1 })
  if (interceptArmed) await page.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
}

/**
 * Give a file input its files without opening the native panel.
 * A native open panel is a separate window that a computer-use agent must locate and drive; the browser
 * protocol can set the files directly, which is both simpler and the only route that works headless.
 * Playwright documents the same idea as setInputFiles (playwright.dev/docs/input).
 * @param page - an open page connection.
 * @param selector - CSS selector of the input[type=file].
 * @param files - absolute paths to hand to the input.
 */
export async function setFileInput(page: CdpPage, selector: string, files: readonly string[]): Promise<void> {
  const document = await page.sendRaw('DOM.getDocument', { depth: 0 })
  const rootNodeId = (asRecordOf(document['root'])?.['nodeId'])
  if (typeof rootNodeId !== 'number') throw new Error('DOM.getDocument did not return a root nodeId')
  const found = await page.sendRaw('DOM.querySelector', { nodeId: rootNodeId, selector })
  const nodeId = found['nodeId']
  if (typeof nodeId !== 'number' || nodeId === 0) throw new Error(`no element matched selector ${JSON.stringify(selector)}`)
  await page.sendRaw('DOM.setFileInputFiles', { nodeId, files: [...files] })
}

/** Text of the page body, used as the readback channel for browser actions. */
export async function pageText(page: CdpPage): Promise<string> {
  const value = await page.evaluate('document.body === null ? "" : document.body.innerText')
  return typeof value === 'string' ? value : ''
}

/** Click one element by CSS selector inside the page. */
export async function clickBySelector(page: CdpPage, selector: string): Promise<void> {
  const clicked = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return false; el.click(); return true })()`)
  if (clicked !== true) throw new Error(`no element matched selector ${JSON.stringify(selector)}`)
}
