/** Native SDK lifecycle and catalog behavior without desktop access. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as NativeProvider from '../src/index.ts'
import { catalog, fixture, resetFixture } from './fixtures/cua-driver.ts'
import { makePng } from './fixtures/png.ts'

vi.mock('@trycua/cua-driver', async () => import('./fixtures/cua-driver.ts'))

/** Bounded wait for a condition driven by microtasks or timers. */
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition not met in time')
}

/** Read the sample count out of a wait_stable summary. */
function samplesFrom(text: string): string {
  return /samples=(\d+)/.exec(text)?.[1] ?? '0'
}

let ctx: Context
const savedImages: Array<{ bytes: number; mediaType: string; name?: string }> = []

beforeEach(async () => {
  resetFixture()
  savedImages.length = 0
  ctx = new Context()
  // Screenshots must enter history as durable attachment references: an image
  // block carrying raw base64 instead fails every later model request.
  ctx.provide('attachments', {
    saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
      savedImages.push({
        bytes: input.data.byteLength,
        mediaType: input.mediaType,
        ...input.name === undefined ? {} : { name: input.name },
      })
      return {
        attachmentId: `sha256:${'a'.repeat(64)}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        ...input.name === undefined ? {} : { name: input.name },
      }
    },
  } as never)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

function execute(rawName: string, args: Record<string, unknown> = {}) {
  return ctx.tools.execute({
    name: `cua_driver_native__${rawName}`,
    callId: ToolCallId('native-test'),
    arguments: args,
    signal: new AbortController().signal,
  })
}

describe('Cua Driver native provider', () => {
  it('registers the upstream catalog and calls its raw names', async () => {
    const fiber = ctx.plugin(NativeProvider)
    await fiber
    expect(ctx.computerUse.providerName).toBe('cua-driver-native')
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([
      ...catalog.tools.map(tool => `cua_driver_native__${tool.name}`),
      // DSH-owned tools: one assertion oracle plus three that read the retained observation.
      'cua_driver_native__assert_window_text',
      'cua_driver_native__diff_window',
      'cua_driver_native__observe_region',
      'cua_driver_native__click_observed',
      'cua_driver_native__wait_stable',
      'cua_driver_native__type_text_verified',
      'cua_driver_native__probe_app',
      'cua_driver_native__capture_window',
      'cua_driver_native__click_screenshot',
      'cua_driver_native__permissions_report',
      'cua_driver_native__app_profile',
      'cua_driver_native__select_text',
      'cua_driver_native__click_verified',
      'cua_driver_native__wait_settled',
      'cua_driver_native__assert_goal',
      'cua_driver_native__invoke_menu_prepared',
      'cua_driver_native__clipboard_text',
    ])
    const result = await execute('click', { pid: 9, window_id: 7 })
    expect(result.isError).toBe(false)
    expect(fixture.calls).toMatchObject([{ name: 'click', args: { pid: 9, window_id: 7 } }])
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(fixture.shutdowns).toBe(1)
    expect(fixture.destroys).toBe(1)
  })

  it('rejects another provider before importing or creating a native runtime', async () => {
    const release = ctx.computerUse.register(ComputerUseProviderName('another-driver'))
    await expect(ctx.plugin(NativeProvider)).rejects.toThrow('already registered')
    expect(fixture.creates).toBe(0)
    expect(ctx.computerUse.providerName).toBe('another-driver')
    await release()
  })

  it('rolls back a failed native constructor', async () => {
    fixture.createError = new Error('native library initialization failed')
    await expect(ctx.plugin(NativeProvider)).rejects.toThrow('native library initialization failed')
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
    expect(fixture.shutdowns).toBe(0)
  })

  it('accepts upstream tools whose optional description is absent', async () => {
    fixture.list = async () => JSON.stringify({ tools: [{ name: 'check_permissions', inputSchema: { type: 'object', properties: {} } }] })
    await ctx.plugin(NativeProvider)
    expect(ctx.tools.schemas()[0]?.description).toBe('')
  })

  it.each([
    ['invalid JSON', '{'],
    ['missing catalog', '{}'],
    ['duplicate names', JSON.stringify({ tools: [catalog.tools[0], catalog.tools[0]] })],
    ['invalid function name', JSON.stringify({ tools: [{ ...catalog.tools[0], name: 'x'.repeat(70) }] })],
  ])('rolls back the native runtime after %s', async (_label, response) => {
    fixture.list = async () => response
    await expect(ctx.plugin(NativeProvider)).rejects.toThrow()
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
    expect(fixture.shutdowns).toBe(1)
    expect(fixture.destroys).toBe(1)
  })

  it('preserves native tool refusals as model-visible errors', async () => {
    fixture.call = async () => ({ isError: true, content: [{ type: 'text', text: 'background_unavailable' }] })
    await ctx.plugin(NativeProvider)
    const result = await execute('click', { pid: 9, window_id: 7 })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: background_unavailable' }])
  })

  it('keeps element tokens, delivery routes, and partial-tree flags visible to the model', async () => {
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'window_id=7 pid=9 elements=3' }],
      structuredContent: {
        window_id: 7,
        clicked: false,
        element_count: 3,
        elements_complete: false,
        elements: [
          { element_index: 0, role: 'AXWindow', element_token: 's00000001:0' },
          { element_index: 1, role: 'AXButton', element_token: 's00000001:1' },
          { element_index: 2, role: 'AXButton', element_token: 's00000001:2' },
        ],
        background_input: {
          routes: [
            { route: 'accessibility', status: 'available' },
            { route: 'window_pointer', status: 'available' },
          ],
        },
      },
    })
    await ctx.plugin(NativeProvider)
    const result = await execute('get_window_state', { pid: 9, window_id: 7 })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('window_id=7 pid=9 elements=3')
    expect(text).toContain('element_token = "<snapshot_id>:<element_index>"')
    expect(text).toContain('s00000001:0')
    expect(text).toContain('elements=3 complete=false')
    expect(text).toContain('routes: accessibility=available window_pointer=available')
  })

  it('says an observation carries no element token instead of staying silent', async () => {
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'window_id=7 pid=9 elements=1' }],
      structuredContent: { window_id: 7, clicked: false, elements: [{ element_index: 0, role: 'AXWindow' }] },
    })
    await ctx.plugin(NativeProvider)
    const text = (await execute('get_window_state', { pid: 9, window_id: 7 })).content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('element_token: none in this observation')
  })

  it('reports why a predicate check could not decide', async () => {
    // This scenario publishes `verify_state` for this test only: the shared catalog stays
    // byte-identical so the recorded session snapshot expectations remain valid.
    fixture.list = async () => JSON.stringify({
      ...catalog,
      tools: [...catalog.tools, {
        name: 'verify_state',
        description: 'Check bounded predicates against one native window.',
        inputSchema: { type: 'object', properties: { pid: { type: 'integer' }, window_id: { type: 'integer' }, expect: { type: 'array' } }, required: ['pid', 'window_id', 'expect'] },
      }],
    })
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'verify_state: unknown after 26 sample(s) in 5097 ms' }],
      structuredContent: {
        status: 'unknown',
        samples: 26,
        predicates: [{ index: 0, status: 'unknown', unknown_reason: 'untrusted_source', observed_json: '{"matches":1757}' }],
      },
    })
    await ctx.plugin(NativeProvider)
    const text = (await execute('verify_state', { pid: 9, window_id: 7 })).content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('status=unknown')
    expect(text).toContain('reason=untrusted_source')
    expect(text).toContain('matches=1757')
    expect(text).toContain('unknown is not success')
  })

  it('leaves a result without structured diagnostics exactly as the driver returned it', async () => {
    await ctx.plugin(NativeProvider)
    const result = await execute('check_permissions')
    expect(result.content).toEqual([{ type: 'text', text: 'Desktop permissions granted.' }])
  })

  it('asserts text the driver predicate check cannot reach', async () => {
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'window_id=7 pid=9 elements=3' }],
      structuredContent: {
        window_id: 7,
        clicked: false,
        elements: [
          { element_index: 0, element_token: 's00000001:0', role: 'AXWindow', label: '计算器' },
          { element_index: 1, element_token: 's00000001:1', role: 'AXButton', label: '2' },
          { element_index: 2, element_token: 's00000001:2', role: 'AXStaticText', value: '5' },
        ],
      },
    })
    await ctx.plugin(NativeProvider)
    const result = await execute('assert_window_text', { pid: 9, window_id: 7, expect: [{ text: '5', mode: 'equals' }] })
    expect(result.isError).toBe(false)
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('satisfied')
    expect(text).toContain('read 3 elements')
    expect(text).toContain('token=s00000001:2')
  })

  it('reports an unsatisfied assertion together with the domain it searched', async () => {
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'window_id=7 pid=9 elements=1' }],
      structuredContent: {
        window_id: 7,
        clicked: false,
        elements: [{ element_index: 0, element_token: 's00000001:0', role: 'AXStaticText', value: '4' }],
      },
    })
    await ctx.plugin(NativeProvider)
    const result = await execute('assert_window_text', { pid: 9, window_id: 7, expect: [{ text: '5', mode: 'equals' }] })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('unsatisfied')
    expect(text).toContain('read 1 elements')
    expect(text).toContain('"5"')
  })

  it('finds a value that only the rendered tree carries', async () => {
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'window_id=7 pid=9 elements=2' }],
      structuredContent: {
        window_id: 7,
        clicked: false,
        elements: [
          { element_index: 0, element_token: 's00000001:0', role: 'AXWindow', label: '\u8ba1\u7b97\u5668' },
          { element_index: 1, element_token: 's00000001:1', role: 'AXButton', label: '2' },
        ],
        tree_markdown: '- [0] AXWindow "\u8ba1\u7b97\u5668"\n  - AXStaticText = "56" (\u7f16\u8f91\u5b57\u6bb5)',
      },
    })
    await ctx.plugin(NativeProvider)
    const result = await execute('assert_window_text', { pid: 9, window_id: 7, expect: [{ text: '56' }] })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('satisfied')
    expect(text).toContain('tree line')
    expect(text).toContain('2 tree lines')
  })

  it('diffs successive observations and states an effect verdict', async () => {
    const trees = [
      { window_id: 7, clicked: false, tree_markdown: '- AXWindow "a"\n  - AXButton "1"', elements: [{ element_index: 0, element_token: 's1:0', role: 'AXWindow' }] },
      { window_id: 7, clicked: false, tree_markdown: '- AXWindow "a"\n  - AXButton "2"', elements: [{ element_index: 0, element_token: 's2:0', role: 'AXWindow' }] },
    ]
    let index = 0
    fixture.call = async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: trees[Math.min(index++, 1)] })
    await ctx.plugin(NativeProvider)
    const text = async (name: string, args: Record<string, unknown>) =>
      (await execute(name, args)).content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const first = await text('get_window_state', { pid: 9, window_id: 7 })
    expect(first).not.toContain('diff since previous observation')
    expect(first).toContain('observation_token=obs:1')
    const second = await text('get_window_state', { pid: 9, window_id: 7 })
    expect(second).toContain('diff since previous observation: +1 -1 lines')
    expect(second).toContain('+ - AXButton "2"')
    const click = await text('click', { pid: 9, window_id: 7, observation_token: 'obs:2' })
    expect(click).toContain('"verification_required":true')
  })

  it('returns only the delta for a known window and the tree when asked', async () => {
    let index = 0
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: {
        window_id: 7, clicked: false,
        tree_markdown: index++ === 0 ? '- AXWindow "a"\n  - AXButton "1"' : '- AXWindow "a"\n  - AXButton "9"',
        elements: [{ element_index: 0, element_token: `s${index}:0`, role: 'AXWindow' }],
      },
    })
    await ctx.plugin(NativeProvider)
    const summary = async (args: Record<string, unknown>) =>
      ((await execute('diff_window', args)) as unknown as { content: Array<{ type: string; text?: string }> })
        .content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('\n')
    const first = await summary({ pid: 9, window_id: 7 })
    expect(first).toContain('no baseline')
    const second = await summary({ pid: 9, window_id: 7 })
    expect(second).toContain('+1 -1 lines')
    expect(second).toContain('- - AXButton "1"')
    const full = await summary({ pid: 9, window_id: 7, full: true })
    expect(full).toContain('no baseline for this window yet (full tree follows)')
  })

  it('filters elements to a window-local rect', async () => {
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: {
        window_id: 7, clicked: false,
        tree_markdown: '- tree',
        elements: [
          { element_index: 0, element_token: 's1:0', role: 'AXWindow', frame: { x: 0, y: 0, w: 600, h: 400 } },
          { element_index: 1, element_token: 's1:1', role: 'AXButton', label: 'ok', frame: { x: 10, y: 10, w: 40, h: 40 } },
          { element_index: 2, element_token: 's1:2', role: 'AXButton', label: 'far', frame: { x: 500, y: 300, w: 40, h: 40 } },
        ],
      },
    })
    await ctx.plugin(NativeProvider)
    const result = await execute('observe_region', { pid: 9, window_id: 7, rect: { x: 0, y: 0, width: 60, height: 60 } })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('2 of 3 elements intersect')
    expect(text).toContain('[1] button "ok"')
  })

  it('converts screen frames with the window origin', async () => {
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: {
        window_id: 7, clicked: false,
        tree_markdown: '- tree',
        elements: [
          { element_index: 0, element_token: 's1:0', role: 'AXWindow', frame: { x: 100, y: 200, w: 600, h: 400 } },
          { element_index: 1, element_token: 's1:1', role: 'AXButton', label: 'inside', frame: { x: 110, y: 210, w: 40, h: 40 } },
          { element_index: 2, element_token: 's1:2', role: 'AXMenuBarItem', label: 'menubar', frame: { x: 10, y: 10, w: 30, h: 20 } },
        ],
      },
    })
    await ctx.plugin(NativeProvider)
    const result = await execute('observe_region', { pid: 9, window_id: 7, rect: { x: 0, y: 0, width: 60, height: 60 } })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    // The window itself plus the button inside it; the menu-bar item sits outside the window.
    expect(text).toContain('2 of 3 elements intersect window-local')
    expect(text).toContain('"inside" @local=px(30,30)')
    expect(text).not.toContain('"menubar"')
    expect(text).toContain('window origin 100,200')
  })

  it('maps roles to a stable vocabulary and calls unknown roles other', async () => {
    const module = await import('../src/index.ts')
    expect(module.roleKind('AXButton')).toBe('button')
    expect(module.roleKind('AXTextField')).toBe('text-input')
    expect(module.roleKind('AXWeirdThing')).toBe('other')
    expect(module.valueKind(undefined)).toBe('none')
    expect(module.valueKind(3)).toBe('number')
    expect(module.valueKind('')).toBe('empty')
    expect(module.valueKind('x')).toBe('text')
    expect(module.describeElement({ role: 'AXWeirdThing', label: 'huh' })).toBe('other(AXWeirdThing) "huh"')
    expect(module.describeElement({ role: 'AXButton', label: 'ok' })).toBe('button "ok"')
  })

  it('refuses a click whose observation token is missing or stale', async () => {
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { window_id: 7, clicked: false, tree_markdown: '- tree', elements: [] },
    })
    await ctx.plugin(NativeProvider)
    const first = await execute('click_observed', { pid: 9, window_id: 7, x: 5, y: 5, observation_token: 'obs:1' })
    expect(first.isError).toBe(true)
    expect(first.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
      .toContain('needs an observation of this window first')
    await execute('get_window_state', { pid: 9, window_id: 7 })
    const stale = await execute('click_observed', { pid: 9, window_id: 7, x: 5, y: 5, observation_token: 'obs:99' })
    expect(stale.isError).toBe(true)
    expect(stale.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
      .toContain('is not the newest for this window')
    const ok = await execute('click_observed', { pid: 9, window_id: 7, x: 5, y: 5, observation_token: 'obs:1' })
    const text = ok.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('bound to obs:1')
    expect(text).toContain('"verification_required":true')
  })

  it('waits for a settling window instead of sleeping a fixed time', async () => {
    let index = 0
    fixture.call = async () => {
      const tree = index < 2 ? `- line ${index++}` : '- line settled'
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { window_id: 7, clicked: false, tree_markdown: tree, elements: [] },
      }
    }
    await ctx.plugin(NativeProvider)
    const result = await execute('wait_stable', { pid: 9, window_id: 7, stable_ms: 80, interval_ms: 5, timeout_ms: 2000 })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('stable: tree unchanged for 80 ms')
    const samples = Number(samplesFrom(text))
    expect(samples).toBeGreaterThanOrEqual(3)
  })

  it('reports an unstable window instead of claiming it settled', async () => {
    let index = 0
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { window_id: 7, clicked: false, tree_markdown: `- line ${index++}`, elements: [] },
    })
    await ctx.plugin(NativeProvider)
    const result = await execute('wait_stable', { pid: 9, window_id: 7, stable_ms: 60, interval_ms: 5, timeout_ms: 150 })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('unstable: tree still changing')
    expect(Number(samplesFrom(text))).toBeGreaterThanOrEqual(2)
  })

  it('reports a structural change that the text diff cannot see', async () => {
    let index = 0
    const frames = [[{ element_index: 0, element_token: 's1:0', role: 'AXButton', label: 'ok', frame: { x: 10, y: 10, w: 40, h: 40 } }],
      [{ element_index: 0, element_token: 's2:0', role: 'AXButton', label: 'ok', frame: { x: 30, y: 10, w: 40, h: 40 } }]]
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { window_id: 7, clicked: false, tree_markdown: '- AXButton "ok"', elements: frames[Math.min(index++, 1)] },
    })
    await ctx.plugin(NativeProvider)
    const summary = async (args: Record<string, unknown>) => {
      const result = await execute('diff_window', args)
      return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    }
    await summary({ pid: 9, window_id: 7 })
    const moved = await summary({ pid: 9, window_id: 7 })
    expect(moved).toContain('+0 -0 lines')
    expect(moved).toContain('structure +1 -1 elements')
    expect(moved).not.toContain('(unchanged)')
  })

  it('treats a pure reordering as content-neutral', async () => {
    let index = 0
    const ordered = [
      [{ element_index: 0, element_token: 's1:0', role: 'AXButton', label: 'a', frame: { x: 0, y: 0, w: 10, h: 10 } },
        { element_index: 1, element_token: 's1:1', role: 'AXButton', label: 'b', frame: { x: 0, y: 20, w: 10, h: 10 } }],
      [{ element_index: 0, element_token: 's2:0', role: 'AXButton', label: 'b', frame: { x: 0, y: 20, w: 10, h: 10 } },
        { element_index: 1, element_token: 's2:1', role: 'AXButton', label: 'a', frame: { x: 0, y: 0, w: 10, h: 10 } }],
    ]
    const trees = ['- AXButton "a"\n- AXButton "b"', '- AXButton "b"\n- AXButton "a"']
    fixture.call = async () => {
      const step = Math.min(index++, 1)
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { window_id: 7, clicked: false, tree_markdown: trees[step], elements: ordered[step] },
      }
    }
    await ctx.plugin(NativeProvider)
    const summary = async (args: Record<string, unknown>) => {
      const result = await execute('diff_window', args)
      return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    }
    await summary({ pid: 9, window_id: 7 })
    const reordered = await summary({ pid: 9, window_id: 7 })
    // Both diffs are content-addressed, so order alone is not a change; tokens carry identity.
    expect(reordered).toContain('+0 -0 lines')
    expect(reordered).toContain('structure +0 -0 elements')
    expect(reordered).toContain('(unchanged)')
  })

  it('verifies typed text before submitting', async () => {
    const calls: string[] = []
    fixture.call = async (name, args) => {
      calls.push(`${name}:${JSON.stringify(args)}`)
      if (name === 'get_window_state') {
        return {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { window_id: 7, clicked: false, tree_markdown: '- AXTextField "hello world"', elements: [] },
        }
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const result = await execute('type_text_verified', { pid: 9, window_id: 7, text: 'hello world', clear: true, submit: true })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('cleared')
    expect(text).toContain('readback: verified')
    expect(text).toContain('submitted')
    expect(calls.findIndex(call => call.startsWith('hotkey:'))).toBeLessThan(calls.findIndex(call => call.startsWith('type_text:')))
    expect(calls.some(call => call.includes('"key":"return"'))).toBe(true)
  })

  it('refuses to submit when the readback does not confirm the text', async () => {
    const calls: string[] = []
    fixture.call = async (name, args) => {
      calls.push(`${name}:${JSON.stringify(args)}`)
      if (name === 'get_window_state') {
        return {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { window_id: 7, clicked: false, tree_markdown: '- AXTextField "something else"', elements: [] },
        }
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const result = await execute('type_text_verified', { pid: 9, window_id: 7, text: 'hello world', submit: true })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('readback: not verified')
    expect(text).toContain('verification_required')
    expect(text).toContain('submit skipped')
    expect(calls.some(call => call.includes('"key":"return"'))).toBe(false)
  })

  it('identifies screenshots by content and refuses stale bindings', async () => {
    const module = await import('../src/index.ts')
    const pixels = new Uint8Array([1, 2, 3, 4])
    const other = new Uint8Array([1, 2, 3, 5])
    const id = module.screenshotId(pixels)
    expect(id).toHaveLength(16)
    expect(module.screenshotId(pixels)).toBe(id)
    expect(module.screenshotId(other)).not.toBe(id)
    const binding = { id, at: 1_000_000 }
    expect(module.bindingMatches(binding, id, 60_000, 1_010_000).ok).toBe(true)
    const wrong = module.bindingMatches(binding, 'ffffffffffffffff', 60_000, 1_010_000)
    expect(wrong.ok).toBe(false)
    expect(wrong.reason).toContain('is not the newest capture')
    const old = module.bindingMatches(binding, id, 60_000, 1_200_000)
    expect(old.ok).toBe(false)
    expect(old.reason).toContain('re-capture before clicking')
    expect(module.bindingMatches(undefined, id).ok).toBe(false)
  })

  it('measures inactivity against an injectable clock', async () => {
    const module = await import('../src/index.ts')
    let time = 0
    const script = [true, true, false, false, false]
    let index = 0
    const settled = await module.waitForStable(
      async () => ({ changed: script[Math.min(index++, script.length - 1)]! }),
      { stableMs: 100, timeoutMs: 1000, intervalMs: 50, now: () => time, sleep: async (ms) => { time += ms } },
    )
    expect(settled.stable).toBe(true)
    expect(settled.samples).toBeGreaterThanOrEqual(4)

    // A slow observer must not satisfy the window from a single sample.
    let slow = 0
    const oneSample = await module.waitForStable(
      async () => { slow += 400; return { changed: false } },
      { stableMs: 300, timeoutMs: 5000, intervalMs: 1, now: () => slow, sleep: async () => {} },
    )
    expect(oneSample.samples).toBeGreaterThanOrEqual(2)

    let other = 0
    const busy = await module.waitForStable(
      async () => ({ changed: true }),
      { stableMs: 100, timeoutMs: 120, intervalMs: 50, now: () => other, sleep: async (ms) => { other += ms } },
    )
    expect(busy.stable).toBe(false)
    expect(busy.lastChangeAgoMs).toBe(0)
  })

  it('captures a window and binds a click to that image', async () => {
    const calls: string[] = []
    const png = Buffer.from([1, 2, 3, 4]).toString('base64')
    fixture.call = async (name) => {
      calls.push(name)
      if (name === 'get_window_state') {
        return {
          content: [{ type: 'image', data: png, mimeType: 'image/png' }, { type: 'text', text: 'shot' }],
          structuredContent: { window_id: 7, clicked: false, elements: [], tree_markdown: '' },
        }
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const capture = await execute('capture_window', { pid: 9, window_id: 7 })
    const captureText = capture.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const id = /screenshot_id=([0-9a-f]{16})/.exec(captureText)?.[1]
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    const imageBlocks = capture.content.filter(block => block.type === 'image')
    expect(imageBlocks).toEqual([
      expect.objectContaining({ type: 'image', attachment: expect.objectContaining({ mediaType: 'image/png' }) }),
    ])
    expect(imageBlocks.some(block => 'data' in block)).toBe(false)
    expect(savedImages).toEqual([{ bytes: 4, mediaType: 'image/png', name: 'cua-capture-7.png' }])

    const clicked = await execute('click_screenshot', { pid: 9, window_id: 7, x: 3, y: 4, screenshot_id: id! })
    expect(clicked.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toContain('input delivered')
    expect(calls).toContain('click')

    const stale = await execute('click_screenshot', { pid: 9, window_id: 7, x: 3, y: 4, screenshot_id: 'ffffffffffffffff' })
    expect(stale.isError).toBe(true)
    expect(stale.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toContain('refused')
  })

  it('refuses to pretend a window was captured when there is no image', async () => {
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'no image here' }],
      structuredContent: { window_id: 7, clicked: false, elements: [], tree_markdown: '' },
    })
    await ctx.plugin(NativeProvider)
    const result = await execute('capture_window', { pid: 9, window_id: 7 })
    expect(result.isError).toBe(true)
    expect(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toContain('capture is unavailable')
  })

  it('reports every permission with what was actually measured', async () => {
    const module = await import('../src/index.ts')
    const findings = await module.permissionReport([
      { name: 'granted-probe', probe: async () => ({ granted: true, evidence: 'said yes' }) },
      { name: 'denied-probe', probe: async () => ({ granted: false, evidence: 'said no' }) },
      { name: 'broken-probe', probe: async () => { throw new Error('measurement failed') } },
    ])
    expect(findings.map(finding => finding.state)).toEqual(['granted', 'denied', 'unprobed'])
    expect(findings[2]!.evidence).toContain('measurement failed')
  })

  it('reports the driver permissions and leaves unmeasured ones unprobed', async () => {
    fixture.call = async (name) => {
      if (name === 'check_permissions') {
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: { accessibility: true, screen_recording: false } }
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const result = await execute('permissions_report', {})
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('accessibility: granted')
    expect(text).toContain('screen-recording: denied')
    expect(text).toContain('apple-events: unprobed')
  })

  it('reports element coordinates in the pixel space clicks actually use', async () => {
    fixture.call = async (name, args) => {
      if (name === 'get_screen_size') {
        return { content: [{ type: 'text', text: 'screen' }], structuredContent: { scale_factor: 2 } }
      }
      const rect = (args as Record<string, unknown>)['rect'] as Record<string, number> | undefined
      if (name === 'get_window_state') {
        return {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: {
            window_id: 7, clicked: false, tree_markdown: '- tree',
            elements: [
              { element_index: 0, element_token: 's1:0', role: 'AXWindow', frame: { x: 0, y: 0, w: 600, h: 400 } },
              { element_index: 1, element_token: 's1:1', role: 'AXButton', label: 'ok', frame: { x: 10, y: 10, w: 40, h: 40 } },
            ],
          },
        }
      }
      void rect
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const result = await execute('observe_region', { pid: 9, window_id: 7, rect: { x: 0, y: 0, width: 400, height: 200 } })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('@local=px(60,60)')
  })

  it('filters a pixel rect against point frames', async () => {
    fixture.call = async (name) => {
      if (name === 'get_screen_size') return { content: [{ type: 'text', text: 's' }], structuredContent: { scale_factor: 2 } }
      if (name === 'get_window_state') {
        return {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: {
            window_id: 7, clicked: false, tree_markdown: '- tree',
            elements: [
              { element_index: 0, element_token: 's1:0', role: 'AXWindow', frame: { x: 0, y: 0, w: 600, h: 400 } },
              { element_index: 1, element_token: 's1:1', role: 'AXButton', label: 'near', frame: { x: 10, y: 10, w: 40, h: 40 } },
              { element_index: 2, element_token: 's1:2', role: 'AXButton', label: 'far', frame: { x: 150, y: 10, w: 40, h: 40 } },
            ],
          },
        }
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    // 200x200 PIXELS = 100x100 points: "near" is inside, "far" (300pt) is not.
    const result = await execute('observe_region', { pid: 9, window_id: 7, rect: { x: 0, y: 0, width: 200, height: 200 } })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('"near"')
    expect(text).not.toContain('"far"')
    expect(text).toContain('@local=px(60,60)')
  })

  it('returns a cropped image for the same window-local rect', async () => {
    const calls: string[] = []
    fixture.call = async (name) => {
      calls.push(name)
      if (name === 'get_window_state') {
        return {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: {
            window_id: 7, clicked: false, tree_markdown: '- tree',
            elements: [
              { element_index: 0, element_token: 's1:0', role: 'AXWindow', frame: { x: 0, y: 0, w: 600, h: 400 } },
              { element_index: 1, element_token: 's1:1', role: 'AXButton', label: 'ok', frame: { x: 10, y: 10, w: 40, h: 40 } },
            ],
          },
        }
      }
      if (name === 'zoom') {
        return {
          content: [{ type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: 'zoom' }],
          structuredContent: { format: 'jpeg', width: 120, height: 120, mime_type: 'image/jpeg' },
        }
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const withImage = await execute('observe_region', { pid: 9, window_id: 7, rect: { x: 0, y: 0, width: 100, height: 100 }, include_image: true })
    const text = withImage.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('image=120x120px jpeg for 100x100pt')
    expect(withImage.content.some(block => block.type === 'image')).toBe(true)
    const regionImages = withImage.content.filter(block => block.type === 'image')
    expect(regionImages).toEqual([
      expect.objectContaining({ type: 'image', attachment: expect.objectContaining({ mediaType: 'image/jpeg' }) }),
    ])
    expect(regionImages.some(block => 'data' in block)).toBe(false)
    expect(savedImages).toEqual([{ bytes: 3, mediaType: 'image/jpeg', name: 'cua-region-7.png' }])
    expect(calls).toContain('zoom')

    const withoutImage = await execute('observe_region', { pid: 9, window_id: 7, rect: { x: 0, y: 0, width: 100, height: 100 } })
    expect(withoutImage.content.some(block => block.type === 'image')).toBe(false)
    expect(calls.filter(call => call === 'zoom')).toHaveLength(1)
  })

  it('classifies how an app is built from evidence it carries', async () => {
    const module = await import('../src/index.ts')
    const electron = module.appProfile({ bundleId: 'com.tinyspeck.slackmacgap', frameworkNames: ['Electron Framework.framework', 'Squirrel.framework'] })
    expect(electron.isElectron).toBe(true)
    expect(electron.hasChromiumInputSurface).toBe(true)
    expect(electron.evidence.join(' ')).toContain('Electron Framework')

    const cef = module.appProfile({ bundleId: 'com.example.cef', frameworkNames: ['Chromium Embedded Framework.framework'] })
    expect(cef.hasCef).toBe(true)
    expect(cef.hasChromiumInputSurface).toBe(true)

    const chrome = module.appProfile({ bundleId: 'com.google.Chrome', frameworkNames: ['Google Chrome Framework.framework'] })
    expect(chrome.isElectron).toBe(false)
    expect(chrome.hasCef).toBe(false)
    expect(chrome.hasChromiumInputSurface).toBe(true)
    expect(chrome.evidence.join(' ')).toContain('Chromium family')

    const native = module.appProfile({ bundleId: 'com.apple.finder', frameworkNames: [] })
    expect(native.isElectron).toBe(false)
    expect(native.hasCef).toBe(false)
    expect(native.hasChromiumInputSurface).toBe(false)
    expect(native.evidence.join(' ')).toContain('no frameworks were listed')
  })

  it('degrades honestly when a pid cannot be resolved', async () => {
    await ctx.plugin(NativeProvider)
    const result = await execute('app_profile', { pid: 999_999 })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('electron=false')
    expect(text).toContain('bundle=(unknown)')
  })

  it('selects text by extending from the caret and reports what was selected', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    fixture.call = async (name, args) => {
      calls.push({ name, args: (args ?? {}) as Record<string, unknown> })
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const result = await execute('select_text', { pid: 9, window_id: 7, mode: 'chars', count: 3, at_x: 60, at_y: 85 })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('extended by 3 chars')
    const presses = calls.filter(call => call.name === 'press_key')
    expect(presses).toHaveLength(3)
    expect(presses[0]!.args['modifiers']).toEqual(['shift'])
    expect(calls[0]!.name).toBe('click')
    expect(calls.some(call => call.name === 'hotkey' && JSON.stringify(call.args['keys']) === '["cmd","c"]')).toBe(true)
  })

  it('selects the whole document with one shortcut', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    fixture.call = async (name, args) => {
      calls.push({ name, args: (args ?? {}) as Record<string, unknown> })
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const result = await execute('select_text', { pid: 9, window_id: 7, mode: 'all' })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('selected all')
    expect(calls.some(call => call.name === 'hotkey' && JSON.stringify(call.args['keys']) === '["cmd","a"]')).toBe(true)
    expect(calls.filter(call => call.name === 'press_key')).toHaveLength(0)
  })

  it('reports a whitespace-normalized readback instead of a false negative', async () => {
    fixture.call = async (name) => {
      if (name === 'get_window_state') {
        return {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { window_id: 7, clicked: false, tree_markdown: '- AXTextArea="omegabeta gamma"', elements: [] },
        }
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const result = await execute('type_text_verified', { pid: 9, window_id: 7, text: ' omega' })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('readback: verified (whitespace-normalized match)')
  })

  it('verifies a click only when the declared effect happened', async () => {
    const module = await import('../src/index.ts')
    expect(module.actionVerdict({ beforeRevision: 'a', afterRevision: 'b', textAppeared: true, expectText: '42' }).verified).toBe(true)
    expect(module.actionVerdict({ beforeRevision: 'a', afterRevision: 'a', textAppeared: false, expectText: '42' }).verified).toBe(false)
    expect(module.actionVerdict({ beforeRevision: 'a', afterRevision: 'b', textAppeared: true, textPresentBefore: true, expectText: '7' }).verified).toBe(false)
    const noExpectation = module.actionVerdict({ beforeRevision: 'a', afterRevision: 'b' })
    expect(noExpectation.verified).toBe(false)
    expect(noExpectation.expectation).toBe('any-change')
  })

  it('reports a click that changed nothing as not verified', async () => {
    let call = 0
    fixture.call = async (name) => {
      if (name !== 'get_window_state') return { content: [{ type: 'text', text: 'ok' }] }
      call += 1
      const elements = call === 1
        ? [{ element_index: 0, element_token: 's1:0', role: 'AXStaticText', value: '0', frame: { x: 0, y: 0, w: 10, h: 10 } }]
        : [{ element_index: 0, element_token: 's2:0', role: 'AXStaticText', value: '42', frame: { x: 0, y: 0, w: 10, h: 10 } }]
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: { window_id: 7, clicked: false, elements, tree_markdown: JSON.stringify(elements.length) } }
    }
    await ctx.plugin(NativeProvider)
    const verified = await execute('click_verified', { pid: 9, window_id: 7, x: 10, y: 10, expect_text: '42', timeout_ms: 150 })
    const verifiedText = verified.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(verifiedText).toContain('verified')
    expect(verifiedText).toContain('"verified":true')

    let stuck = 0
    fixture.call = async (name) => {
      if (name !== 'get_window_state') return { content: [{ type: 'text', text: 'ok' }] }
      stuck += 1
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { window_id: 7, clicked: false, tree_markdown: '- same', elements: [{ element_index: 0, element_token: 's3:0', role: 'AXStaticText', value: '0', frame: { x: 0, y: 0, w: 10, h: 10 } }] },
      }
    }
    const unchanged = await execute('click_verified', { pid: 9, window_id: 7, x: 20, y: 20, expect_text: '42', timeout_ms: 200 })
    const unchangedText = unchanged.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(unchangedText).toContain('not verified')
    expect(unchangedText).toContain('"verified":false')
  })

  it('detects a change that only shows up in the rendered tree', async () => {
    const module = await import('../src/index.ts')
    const elements = [{ role: 'AXButton', label: 'AC', frame: { x: 0, y: 0, w: 10, h: 10 } }]
    const before = module.stateRevision(elements, '- AXStaticText = "0"')
    const after = module.stateRevision(elements, '- AXStaticText = "42"')
    expect(before).not.toBe(after)
    expect(module.stateRevision(elements, '- same')).toBe(module.stateRevision(elements, '- same'))
  })

  it('refuses to repeat an action that already took effect', async () => {
    const module = await import('../src/index.ts')
    const ledger = new Map()
    expect(module.duplicateCheck(ledger, 'k', 1000).action).toBe('proceed')
    ledger.set('k', { key: 'k', at: 1000, outcome: 'verified' })
    expect(module.duplicateCheck(ledger, 'k', 1500).action).toBe('already-done')
    expect(module.duplicateCheck(ledger, 'k', 99_000).action).toBe('proceed')
    ledger.set('u', { key: 'u', at: 1000, outcome: 'unverified' })
    expect(module.duplicateCheck(ledger, 'u', 1500).action).toBe('needs-approval')
  })

  it('skips a duplicated click and clicks again only when told to', async () => {
    let clicks = 0
    let call = 0
    fixture.call = async (name) => {
      if (name === 'click') { clicks += 1; return { content: [{ type: 'text', text: 'ok' }] } }
      call += 1
      const elements = call <= 2
        ? [{ element_index: 0, element_token: 's1:0', role: 'AXStaticText', value: '0', frame: { x: 0, y: 0, w: 10, h: 10 } }]
        : [{ element_index: 0, element_token: 's2:0', role: 'AXStaticText', value: '42', frame: { x: 0, y: 0, w: 10, h: 10 } }]
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: { window_id: 7, clicked: false, elements, tree_markdown: String(call) } }
    }
    await ctx.plugin(NativeProvider)
    const first = await execute('click_verified', { pid: 9, window_id: 7, x: 10, y: 10, expect_text: '42', timeout_ms: 150 })
    expect(first.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toContain('verified')
    expect(clicks).toBe(1)

    const second = await execute('click_verified', { pid: 9, window_id: 7, x: 10, y: 10, expect_text: '42', timeout_ms: 150 })
    expect(second.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toContain('skipped')
    expect(clicks).toBe(1)

    const forced = await execute('click_verified', { pid: 9, window_id: 7, x: 10, y: 10, expect_text: '42', timeout_ms: 150, allow_repeat: true })
    expect(forced.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toContain('click_verified')
    expect(clicks).toBe(2)
  })

  it('needs both the tree and the pixels to call a window settled', async () => {
    const module = await import('../src/index.ts')
    let time = 0
    const clock = () => time
    const step = async (ms: number) => { time += ms }
    const calm = await module.waitForSettled(async () => ({ tree: 'a', pixels: 'p1' }), { stableMs: 100, timeoutMs: 1000, intervalMs: 50, now: clock, sleep: step })
    expect(calm.settled).toBe(true)

    let spinner = 0
    time = 0
    const busy = await module.waitForSettled(
      async () => ({ tree: 'same', pixels: spinner++ % 2 === 0 ? 'p1' : 'p2' }),
      { stableMs: 100, timeoutMs: 120, intervalMs: 50, now: clock, sleep: step },
    )
    expect(busy.settled).toBe(false)
    expect(busy.pixelsChanged).toBe(true)
    expect(busy.treeChanged).toBe(false)
  })

  it('reports a spinner as not settled through the tool', async () => {
    let shot = 0
    fixture.call = async (name, args) => {
      const record = args as Record<string, unknown>
      if (name === 'get_window_state' && record['include_screenshot'] === true) {
        shot += 1
        const data = Buffer.from([shot % 2, 1, 2]).toString('base64')
        return { content: [{ type: 'image', data, mimeType: 'image/png' }], structuredContent: { window_id: 7 } }
      }
      if (name === 'get_window_state') {
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: { window_id: 7, tree_markdown: '- same', elements: [] } }
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const busy = await execute('wait_settled', { pid: 9, window_id: 7, stable_ms: 80, timeout_ms: 200, interval_ms: 40 })
    const busyText = busy.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(busyText).toContain('not settled')
    expect(busyText).toContain('pixels')
  })

  it('compares pixels by changed fraction, so a caret-sized change still settles', async () => {
    const { analysisLuma, settleSignature } = await import('../src/png.ts')
    const white = makePng(384, 216, () => [255, 255, 255])
    const luma = analysisLuma(white)
    expect(luma.length).toBe(384 * 216)
    expect(Math.round(luma[0] ?? -1)).toBe(255)
    expect(settleSignature(undefined, luma)).toBe('first')
    expect(settleSignature(luma, luma.slice())).toBe('still/flat')
    // A caret: one analysis sample out of 82944.
    const caret = luma.slice()
    caret[7] = (caret[7] ?? 0) - 40
    expect(settleSignature(luma, caret)).toBe('still/flat')
    // A rotating spinner: one pixel per row column, i.e. 216/82944 = 0.26%.
    const spin = luma.slice()
    for (let row = 0; row < 216; row += 1) spin[row * 384] = 0
    expect(settleSignature(luma, spin).startsWith('moving/')).toBe(true)
  })

  it('settles on a blinking caret and still reports a moving page as busy', async () => {
    let shot = 0
    fixture.call = async (name, args) => {
      const record = args as Record<string, unknown>
      if (name === 'get_window_state' && record['include_screenshot'] === true) {
        shot += 1
        // One pixel flickers: a caret. Every sample differs byte-wise, the grid does not care.
        const png = makePng(384, 216, (x, y) => (x === 5 && y === 5 && shot % 2 === 0 ? [200, 200, 200] : [255, 255, 255]))
        return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }], structuredContent: { window_id: 7 } }
      }
      if (name === 'get_window_state') {
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: { window_id: 7, tree_markdown: '- same', elements: [] } }
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const textOf = result => result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const caret = await execute('wait_settled', { pid: 9, window_id: 7, stable_ms: 60, timeout_ms: 2000, interval_ms: 20 })
    expect(textOf(caret)).toContain('settled')
    expect(textOf(caret)).not.toContain('not settled')
  })

  it('reports a real animated page as busy, not as a stable "moving" label', async () => {
    let shot = 0
    fixture.call = async (name, args) => {
      const record = args as Record<string, unknown>
      if (name === 'get_window_state' && record['include_screenshot'] === true) {
        shot += 1
        // Half the columns invert every sample: the signature label stays "moving", so equality
        // alone would call this "unchanged" — the moving flag has to decide.
        const png = makePng(384, 216, (x) => {
          const left = x < 192
          const light = shot % 2 === 0 ? left : !left
          return light ? [255, 255, 255] : [0, 0, 0]
        })
        return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }], structuredContent: { window_id: 7 } }
      }
      if (name === 'get_window_state') {
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: { window_id: 7, tree_markdown: '- same', elements: [] } }
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const busy = await execute('wait_settled', { pid: 9, window_id: 7, stable_ms: 80, timeout_ms: 300, interval_ms: 40 })
    const busyText = busy.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(busyText).toContain('not settled')
    expect(busyText).toContain('pixels')
  })

  it('judges an end condition without ever guessing', async () => {
    const module = await import('../src/index.ts')
    const met = module.goalVerdict([{ text: 'done' }], 'header line\nall done here', false)
    expect(met.verdict).toBe('met')
    expect(met.reasons[0]).toContain('present in:')
    expect(met.reasons[0]).toContain('all done here')
    expect(module.goalVerdict([{ text: 'done' }, { absent: 'error' }], 'done, error shown', false).verdict).toBe('not-met')
    expect(module.goalVerdict([{ text: 'done' }], undefined, true).verdict).toBe('unknown')
    expect(module.goalVerdict([], 'anything', false).verdict).toBe('unknown')
  })

  it('reports unknown when the window cannot be read', async () => {
    fixture.call = async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { window_id: 7, elements: [], tree_markdown: '' } })
    await ctx.plugin(NativeProvider)
    const blank = await execute('assert_goal', { pid: 9, window_id: 7, conditions: [{ text: 'done' }] })
    const blankText = blank.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(blankText).toContain('assert_goal: unknown')
    expect(blankText).not.toContain('assert_goal: met')
  })

  it('stops waiting as soon as the caller aborts', async () => {
    const module = await import('../src/index.ts')
    const controller = new AbortController()
    let samples = 0
    const outcome = await module.waitForStable(async () => {
      samples += 1
      if (samples === 2) controller.abort()
      return { changed: false }
    }, { stableMs: 10_000, timeoutMs: 10_000, intervalMs: 1, now: () => samples * 100, sleep: async () => {}, signal: controller.signal })
    expect(outcome.aborted).toBe(true)
    expect(outcome.samples).toBeLessThan(4)

    const settleController = new AbortController()
    let settleSamples = 0
    const settleOutcome = await module.waitForSettled(async () => {
      settleSamples += 1
      if (settleSamples === 2) settleController.abort()
      return { tree: 't', pixels: `p${settleSamples}` }
    }, { stableMs: 10_000, timeoutMs: 10_000, intervalMs: 1, now: () => settleSamples * 100, sleep: async () => {}, signal: settleController.signal })
    expect(settleOutcome.aborted).toBe(true)
  })

  it('projects window records so a caller can name a window', async () => {
    const module = await import('../src/index.ts')
    const lines = module.windowListLines({ windows: [{ pid: 496, window_id: 425, app_name: 'Finder', title: '下载' }] })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('pid=496')
    expect(lines[0]).toContain('window_id=425')
    expect(lines[0]).toContain('下载')
    expect(module.windowListLines(undefined)).toEqual([])
  })

  it('refuses a second agent on the same target and takes over an expired claim', async () => {
    const lease = await import('../src/lease.ts')
    const dir = await (await import('node:fs/promises')).mkdtemp('/tmp/cu-lease-')
    expect((await lease.acquireLease('win:1:2', 'agent-a', { dir })).ok).toBe(true)
    const blocked = await lease.acquireLease('win:1:2', 'agent-b', { dir })
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toContain('agent-a')
    expect((await lease.acquireLease('win:1:2', 'agent-a', { dir })).ok).toBe(true)
    expect((await lease.acquireLease('win:1:2', 'agent-b', { dir, ttlMs: -1 })).ok).toBe(true)
    expect(await lease.releaseLease('win:1:2', 'agent-a', dir)).toBe(false)
    expect(await lease.releaseLease('win:1:2', 'agent-b', dir)).toBe(true)
  })

  it('treats a window that moved on as contended instead of fighting it', async () => {
    const module = await import('../src/index.ts')
    expect(module.contendedVerdict('r1', 'r1').contended).toBe(false)
    expect(module.contendedVerdict('r1', 'r2').contended).toBe(true)
    expect(module.contendedVerdict('r1', 'r1', 'r2').contended).toBe(true)
  })

  it('refuses to click while another agent holds the window', async () => {
    const lease = await import('../src/lease.ts')
    const fs = await import('node:fs/promises')
    const dir = await fs.mkdtemp('/tmp/cu-lease-tool-')
    process.env['DSH_CUA_LEASE_DIR'] = dir
    let clicks = 0
    fixture.call = async (name) => {
      if (name === 'click') { clicks += 1; return { content: [{ type: 'text', text: 'ok' }] } }
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { window_id: 7, clicked: false, tree_markdown: '- same', elements: [{ element_index: 0, element_token: 's1:0', role: 'AXButton', label: 'x', frame: { x: 0, y: 0, w: 10, h: 10 } }] },
      }
    }
    await lease.acquireLease('win:9:7', 'other-agent', { dir })
    try {
      await ctx.plugin(NativeProvider)
      const busy = await execute('click_verified', { pid: 9, window_id: 7, x: 10, y: 10, expect_text: 'never', timeout_ms: 150 })
      const text = busy.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      expect(text).toContain('busy')
      expect(text).toContain('other-agent')
      expect(clicks).toBe(0)
    } finally {
      await lease.releaseLease('win:9:7', 'other-agent', dir)
      delete process.env['DSH_CUA_LEASE_DIR']
    }
  })

  it('refuses to type while another agent holds the window', async () => {
    const lease = await import('../src/lease.ts')
    const fs = await import('node:fs/promises')
    const dir = await fs.mkdtemp('/tmp/cu-lease-type-')
    process.env['DSH_CUA_LEASE_DIR'] = dir
    let typed = 0
    fixture.call = async (name) => {
      if (name === 'type_text') { typed += 1; return { content: [{ type: 'text', text: 'ok' }] } }
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { window_id: 7, tree_markdown: '- same', elements: [{ element_index: 0, element_token: 's1:0', role: 'AXStaticText', value: 'x', frame: { x: 0, y: 0, w: 10, h: 10 } }] },
      }
    }
    await lease.acquireLease('win:9:7', 'other-agent', { dir })
    try {
      await ctx.plugin(NativeProvider)
      const busy = await execute('type_text_verified', { pid: 9, window_id: 7, text: 'hello' })
      const text = busy.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      expect(text).toContain('busy')
      expect(typed).toBe(0)
    } finally {
      await lease.releaseLease('win:9:7', 'other-agent', dir)
      delete process.env['DSH_CUA_LEASE_DIR']
    }
  })

  it('verifies a browser action only on a delta in the page text', async () => {
    const module = await import('../src/cdp.ts')
    const met = module.domVerdict('idle', 'idle AXCLICK-OK', 'AXCLICK-OK')
    expect(met.verified).toBe(true)
    expect(met.expectation).toBe('text-appeared')
    const stale = module.domVerdict('idle AXCLICK-OK', 'idle AXCLICK-OK', 'AXCLICK-OK')
    expect(stale.verified).toBe(false)
    expect(stale.detail).toContain('already on the page')
    expect(module.domVerdict('busy', 'done', undefined, 'busy').verified).toBe(true)
    expect(module.domVerdict('same', 'same').verified).toBe(false)
  })

  it('warns before trusting coordinates on a small window', async () => {
    const module = await import('../src/index.ts')
    expect(module.smallWindowHint({ w: 115, h: 204 })).toContain('prefer type_text')
    expect(module.smallWindowHint({ w: 460, h: 816 })).toBeUndefined()
    expect(module.smallWindowHint(undefined)).toBeUndefined()
  })

  it('classifies a menu precondition refusal instead of blaming the menu path', async () => {
    const module = await import('../src/index.ts')
    expect(module.menuPreconditionFailure('invoke_menu: target window 1 did not become stably key and frontmost')).toBe(true)
    expect(module.menuPreconditionFailure('menu item not found: 编辑 > 删除')).toBe(false)

    fixture.call = async (name) => {
      if (name === 'invoke_menu') throw new Error('invoke_menu: target window 7 did not become stably key and frontmost')
      if (name === 'get_window_state') {
        return {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { window_id: 7, elements: [{ element_index: 0, element_token: 's1:0', role: 'AXWindow', frame: { x: 0, y: 0, w: 400, h: 300 } }], tree_markdown: '- tree' },
        }
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const result = await execute('invoke_menu_prepared', { pid: 9, window_id: 7, path: ['编辑', '删除'] })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('precondition not satisfied')
    expect(text).toContain('was NOT invoked')
  })

  it('returns clipboard text inline instead of a type count', async () => {
    fixture.call = async (name) => {
      if (name === 'clipboard_read') {
        return { content: [{ type: 'text', text: 'Clipboard read succeeded (2 available type(s)).' }], structuredContent: { types: ['public.utf8-plain-text'], text: 'menu-test' } }
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const result = await execute('clipboard_text', {})
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('menu-test')

    fixture.call = async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { types: ['public.png'] } })
    const none = await execute('clipboard_text', {})
    expect(none.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toContain('no plain text')
  })

  it('projects the browser target and tab ids the driver keeps out of its text', async () => {
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'bound target bt-abc (exact) with 2 tab(s)' }],
      structuredContent: { target: { id: 'bt-abc' }, tabs: [{ id: 'tab-7' }, { id: 'tab-8' }] },
    })
    await ctx.plugin(NativeProvider)
    const result = await execute('click', { pid: 9, window_id: 7 })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('target_id=bt-abc')
    expect(text).toContain('tab_ids=tab-7,tab-8')

    fixture.call = async () => ({ content: [{ type: 'text', text: 'clicked' }], structuredContent: {} })
    const plain = await execute('click', { pid: 9, window_id: 7 })
    expect(plain.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).not.toContain('target_id=')

    fixture.call = async () => ({
      content: [{ type: 'text', text: 'bound target bt-abc (exact) with 2 tab(s)' }],
      structuredContent: { target_id: 'bt-abc', tabs: ['tab-a', 'tab-b'] },
    })
    const flat = await execute('click', { pid: 9, window_id: 7 })
    const flatText = flat.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(flatText).toContain('target_id=bt-abc')
    expect(flatText).toContain('tab_ids=tab-a,tab-b')
  })

  it('projects the action refs a browser snapshot keeps out of its text', async () => {
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'snapshot p1 of http://x/: 1 action ref(s), 2 content ref(s)' }],
      structuredContent: { snapshot_id: 'p1', elements: [{ ref: 'p1:3', role: 'button', name: 'HOVER-ME' }] },
    })
    await ctx.plugin(NativeProvider)
    const result = await execute('click', { pid: 9, window_id: 7 })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('browser refs:')
    expect(text).toContain('p1:3')
    expect(text).toContain('HOVER-ME')

    fixture.call = async () => ({ content: [{ type: 'text', text: 'snapshot p2' }], structuredContent: { snapshot_id: 'p2' } })
    const none = await execute('click', { pid: 9, window_id: 7 })
    expect(none.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).not.toContain('browser refs:')
  })

  it('recommends a route from the three probes', () => {
    expect(NativeProvider.routeVerdict({ treeReadable: true, clickChanged: true }).route).toBe('ax-pixels')
    expect(NativeProvider.routeVerdict({ treeReadable: true, clickChanged: false, chromium: true }).route).toBe('cdp')
    expect(NativeProvider.routeVerdict({ treeReadable: false, chromium: true }).route).toBe('cdp')
    expect(NativeProvider.routeVerdict({ treeReadable: false, keyLanded: true }).route).toBe('keyboard')
    expect(NativeProvider.routeVerdict({ treeReadable: false }).route).toBe('vision')
    expect(NativeProvider.routeVerdict({ treeReadable: true }).route).toBe('unknown')
  })

  it('probe_app is read-only until confirmed, then measures the click', async () => {
    let observations = 0
    fixture.call = async (name) => {
      if (name === 'get_window_state') {
        observations += 1
        return {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: {
            elements: [{ element_index: 0, element_token: 's1:0', role: 'AXButton', frame: { x: 10, y: 10, w: 20, h: 20 } }],
            tree_markdown: observations === 1 ? '- tree A' : '- tree B',
          },
        }
      }
      if (name === 'get_screen_size') return { content: [{ type: 'text', text: 'ok' }], structuredContent: { scale_factor: 2 } }
      return { content: [{ type: 'text', text: 'clicked' }] }
    }
    await ctx.plugin(NativeProvider)
    const textOf = result => result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const readOnly = await execute('probe_app', { pid: 9, window_id: 7 })
    expect(textOf(readOnly)).toContain('route: unknown')
    expect(textOf(readOnly)).toContain('changed=null')

    observations = 0
    const probed = await execute('probe_app', { pid: 9, window_id: 7, confirm: true, click_element: 0 })
    expect(textOf(probed)).toContain('route: ax-pixels')
    expect(textOf(probed)).toContain('changed=true')
  })

  it('drags through CDP with a real press-move-release sequence', async () => {
    const module = await import('../src/cdp.ts')
    const sent: Array<{ method: string; params: Record<string, unknown> }> = []
    const page = { evaluate: async () => undefined, send: async (method: string, params: Record<string, unknown> = {}) => { sent.push({ method, params }); return undefined }, close: () => undefined }
    await module.dragOnPage(page, { from: { x: 10, y: 20 }, to: { x: 110, y: 220 }, steps: 2 })
    expect(sent).toHaveLength(4)
    expect(sent.every(entry => entry.method === 'Input.dispatchMouseEvent')).toBe(true)
    expect(sent[0]!.params['type']).toBe('mousePressed')
    expect(sent[1]!.params['type']).toBe('mouseMoved')
    expect(sent[1]!.params['x']).toBe(60)
    expect(sent[3]!.params['type']).toBe('mouseReleased')
    expect(sent[3]!.params['x']).toBe(110)
    expect(sent[3]!.params['buttons']).toBe(0)
  })

  it('uses the drag events for HTML5 drag and drop', async () => {
    const module = await import('../src/cdp.ts')
    const sent: Array<{ method: string; params: Record<string, unknown> }> = []
    const page = { evaluate: async () => undefined, send: async (method: string, params: Record<string, unknown> = {}) => { sent.push({ method, params }); return undefined }, once: async () => ({ data: { items: [{ mimeType: 'text/plain', data: 'PAYLOAD' }] } }), close: () => undefined }
    await module.html5DragOnPage(page, { from: { x: 10, y: 10 }, to: { x: 90, y: 90 }, steps: 2 }, 'PAYLOAD')
    const types = sent.filter(entry => entry.params['type'] !== undefined).map(entry => entry.params['type'])
    expect(types).toEqual(['mousePressed', 'mouseMoved', 'dragEnter', 'dragOver', 'dragOver', 'drop', 'mouseReleased'])
    const dragEvent = sent.find(entry => entry.params['type'] === 'drop')
    expect(JSON.stringify(dragEvent?.params['data'])).toContain('PAYLOAD')
  })

  it('sets file inputs through the protocol instead of the native panel', async () => {
    const module = await import('../src/cdp.ts')
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const page = {
      evaluate: async () => undefined,
      send: async () => undefined,
      once: async () => ({}),
      sendRaw: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params })
        if (method === 'DOM.getDocument') return { root: { nodeId: 7 } }
        if (method === 'DOM.querySelector') return { nodeId: 42 }
        return {}
      },
      close: () => undefined,
    }
    await module.setFileInput(page, 'input[type=file]', ['/tmp/a.txt'])
    expect(calls.map(call => call.method)).toEqual(['DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles'])
    expect(calls[1]!.params['selector']).toBe('input[type=file]')
    expect(calls[2]!.params['nodeId']).toBe(42)
    expect(JSON.stringify(calls[2]!.params['files'])).toContain('/tmp/a.txt')

    const none = { ...page, sendRaw: async (method: string) => method === 'DOM.getDocument' ? { root: { nodeId: 7 } } : { nodeId: 0 } }
    await expect(module.setFileInput(none as never, '#missing', ['/tmp/a.txt'])).rejects.toThrow(/no element matched/)
  })

  it('reports an aborted call as an unknown outcome', async () => {
    const started = Promise.withResolvers<void>()
    fixture.call = async (_name, _args, signal) => {
      started.resolve()
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('native call aborted')) }, { once: true })
      })
    }
    await ctx.plugin(NativeProvider)
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      name: 'cua_driver_native__get_window_state', callId: ToolCallId('abort-guidance'),
      arguments: { pid: 9, window_id: 7 }, signal: controller.signal,
    })
    await started.promise
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('aborted')
    expect(text).toContain('outcome is unknown')
  })

  it('labels the driver escalation hint as a hint, not a failure', async () => {
    fixture.call = async () => ({
      content: [{ type: 'text', text: 'window_id=7 pid=9' }],
      structuredContent: { window_id: 7, clicked: false, escalation: { reason: 'delivery_failed', target: 'foreground' } },
    })
    await ctx.plugin(NativeProvider)
    const text = (await execute('get_window_state', { pid: 9, window_id: 7 })).content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('not failure evidence')
    expect(text).not.toContain('[cua] escalation=')
  })

  it('serializes calls that target the same window', async () => {
    const starts: string[] = []
    const releases: Array<() => void> = []
    fixture.call = async (name) => {
      starts.push(name)
      await new Promise<void>((resolve) => { releases.push(resolve) })
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const first = execute('click', { pid: 9, window_id: 7 })
    const second = execute('click', { pid: 9, window_id: 7 })
    await until(() => starts.length === 1)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(starts.length).toBe(1)
    releases[0]!()
    await first
    await until(() => starts.length === 2)
    releases[1]!()
    await second
    expect(starts).toEqual(['click', 'click'])
  })

  it('keeps different windows independent instead of serializing globally', async () => {
    const starts: string[] = []
    const releases: Array<() => void> = []
    fixture.call = async () => {
      starts.push('call')
      await new Promise<void>((resolve) => { releases.push(resolve) })
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    await ctx.plugin(NativeProvider)
    const first = execute('click', { pid: 9, window_id: 7 })
    const second = execute('click', { pid: 9, window_id: 8 })
    await until(() => starts.length === 2)
    releases.forEach(release => release())
    await Promise.all([first, second])
  })

  it('leaves an unrelated tool running when the native provider unloads', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const settled = Promise.withResolvers<boolean>()
    const controller = new AbortController()
    const fiber = ctx.plugin(NativeProvider)
    await fiber
    ctx.tools.register({
      name: 'unrelated', description: 'Independent tool.', parameters: { type: 'object' },
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Done.' }] },
      execute(_args, exec) {
        started.resolve(exec.signal)
        return settled.promise
      },
    })
    const result = ctx.tools.execute({
      name: 'unrelated', callId: ToolCallId('unrelated'), arguments: {}, signal: controller.signal,
    })
    try {
      const signal = await started.promise
      await fiber.dispose()
      expect(signal).toBe(controller.signal)
      expect(signal.aborted).toBe(false)
      expect(fixture.shutdowns).toBe(1)
      expect(fixture.destroys).toBe(1)
      expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['unrelated'])
    } finally {
      settled.resolve(true)
      await result
    }
    expect((await result).isError).toBe(false)
  })

  it('retains the reservation until aborted calls and native shutdown settle', async () => {
    const called: PromiseWithResolvers<void> = Promise.withResolvers()
    const callSettled = Promise.withResolvers<unknown>()
    const shutdownStarted: PromiseWithResolvers<void> = Promise.withResolvers()
    const shutdownSettled: PromiseWithResolvers<void> = Promise.withResolvers()
    fixture.call = async () => {
      called.resolve()
      return callSettled.promise
    }
    fixture.shutdown = async () => {
      shutdownStarted.resolve()
      await shutdownSettled.promise
    }
    const fiber = ctx.plugin(NativeProvider)
    await fiber
    const result = execute('click', { pid: 9, window_id: 7 })
    await called.promise
    const disposal = fiber.dispose()
    try {
      await vi.waitFor(() => {
        expect(fixture.calls[0]?.signal?.aborted).toBe(true)
        expect(ctx.tools.schemas()).toEqual([])
      })
      expect(ctx.computerUse.providerName).toBe('cua-driver-native')
      expect(() => ctx.computerUse.register(ComputerUseProviderName('replacement'))).toThrow('already registered')
      callSettled.resolve({ content: [{ type: 'text', text: 'late native completion' }] })
      await shutdownStarted.promise
      expect(ctx.computerUse.providerName).toBe('cua-driver-native')
      expect(fixture.destroys).toBe(0)
    } finally {
      callSettled.resolve({ content: [] })
      shutdownSettled.resolve()
      await disposal
    }
    expect((await result).isError).toBe(true)
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(fixture.destroys).toBe(1)
  })

  it.each([['tools', ToolRuntime], ['systemPrompt', SystemPrompt]] as const)('closes the old native runtime before %s restarts it', async (_name, service) => {
    const shutdownStarted: PromiseWithResolvers<void> = Promise.withResolvers()
    const shutdownSettled: PromiseWithResolvers<void> = Promise.withResolvers()
    fixture.shutdown = async () => {
      shutdownStarted.resolve()
      await shutdownSettled.promise
    }
    const fiber = ctx.plugin(NativeProvider)
    await fiber
    const dependency = [...ctx.registry.get(service)!.fibers][0]!
    const restart = dependency.restart()
    try {
      await shutdownStarted.promise
      expect(fixture.creates).toBe(1)
      expect(fixture.destroys).toBe(0)
      expect(ctx.computerUse.providerName).toBe('cua-driver-native')
    } finally {
      shutdownSettled.resolve()
      await restart
      await fiber
    }
    await vi.waitFor(() => { expect(fixture.creates).toBe(2) })
    expect(fixture.shutdowns).toBe(1)
    expect(fixture.destroys).toBe(1)
    expect((await execute('check_permissions')).isError).toBe(false)
    await fiber.dispose()
    expect(fixture.shutdowns).toBe(2)
    expect(fixture.destroys).toBe(2)
  })

  it('interrupts discovery when unloaded during startup', async () => {
    const started: PromiseWithResolvers<void> = Promise.withResolvers()
    fixture.list = signal => new Promise((_resolve, reject) => {
      started.resolve()
      signal?.addEventListener('abort', () => { reject(new Error('Native discovery aborted')) }, { once: true })
    })
    const fiber = ctx.plugin(NativeProvider)
    const readiness = Promise.resolve(fiber).catch(() => undefined)
    await started.promise
    await fiber.dispose()
    await readiness
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
    expect(fixture.shutdowns).toBe(1)
    expect(fixture.destroys).toBe(1)
  })

  it('keeps the reservation when native shutdown cannot prove completion', async () => {
    fixture.shutdown = async () => { throw new Error('Native shutdown failed') }
    const fiber = ctx.plugin(NativeProvider)
    await fiber
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.computerUse.providerName).toBe('cua-driver-native')
    expect(fixture.destroys).toBe(0)
    expect(() => ctx.computerUse.register(ComputerUseProviderName('replacement'))).toThrow('already registered')
  })
})
