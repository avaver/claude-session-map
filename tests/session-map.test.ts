import type { CommandRunArgs, On, UiOpenResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { EMPTY, apply, currentTopic, migrate, rows, statusLine, summary, toText } from '../hooks/map'
import type { Update } from '../hooks/map'
import type { SessionMap } from '../types'

const TOOL = 'mcp__session-map__update'

const run = (...changes: Update[]): SessionMap =>
  changes.reduce<SessionMap>((map, change, i) => {
    const out = apply(map, change, i)
    if ('error' in out) throw new Error(out.error)

    return out.map
  }, EMPTY)

/** The engine beneath the plugin: what a session answers, from memory. */
const world = (on: On, stored?: Record<string, unknown>, opening: UiOpenResult = { isPlaced: true }) => {
  mock.clock(on, { now: 1000 })
  mock.store(on, stored)
  const status: (string | undefined)[] = []
  const opened: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__session-map__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: opening }
  })
  on('ui.status', ($, e) => {
    status.push(e.text)

    return { value: undefined }
  })

  return { status, opened }
}

const PANE = {
  component: 'Pane',
  requestId: 'session-map',
  props: {
    title: 'Session map',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('a goal that is reworded keeps its history', () => {
  const map = run(
    { action: 'goal', text: 'Migrate auth to OAuth' },
    { action: 'goal', text: 'migrate  auth to oauth' },
    { action: 'goal', text: 'Migrate auth to OAuth and drop sessions' },
  )
  expect(map.topics.length).toBe(1)
  expect(currentTopic(map)?.wordings.map(one => one.text)).toEqual([
    'Migrate auth to OAuth',
    'Migrate auth to OAuth and drop sessions',
  ])
})

test('a new topic keeps its own steps, and naming an earlier one returns to it', () => {
  const map = run(
    { action: 'goal', text: 'Bug 1' },
    { action: 'step', text: 'fix' },
    { action: 'branch', text: 'flaky test' },
    { action: 'topic', text: 'Release check' },
    { action: 'step', text: 'logs' },
    { action: 'topic', text: 'bug 1' },
    { action: 'step', text: 'PR', status: 'active' },
  )
  expect(map.topics.map(one => one.wordings.map(w => w.text).join('/'))).toEqual(['Bug 1', 'Release check'])
  expect(currentTopic(map)?.id).toBe('t1')
  expect(rows(map).map(row => row.node.title)).toEqual(['fix', 'flaky test', 'PR'])
  expect(rows(map, 't2').map(row => row.node.title)).toEqual(['logs'])
  expect(statusLine(map)).toBe('◎ Bug 1 · ↳ flaky test')
  const [release] = map.topics.filter(one => one.id === 't2')
  expect(release && summary(map, release)).toEqual({ icon: '✓', text: 'Release check · 1 ✓' })
  const open = run({ action: 'goal', text: 'Open' }, { action: 'step', text: 'later', status: 'planned' }, { action: 'topic', text: 'Next' })
  const [first] = open.topics
  expect(first && summary(open, first)).toEqual({ icon: '◐', text: 'Open · 1 ○' })
})

test('the text shows the current topic in full and earlier ones in a line, all of them in full on request', () => {
  const map = run(
    { action: 'goal', text: 'Old task' },
    { action: 'step', text: 'old step' },
    { action: 'topic', text: 'New task' },
    { action: 'step', text: 'new step', status: 'active' },
  )
  const short = toText(map)
  expect(short).toContain('Goal: New task')
  expect(short).toContain('▶ new step   ← now')
  expect(short).toContain('✓ Old task · 1 ✓')
  expect(short).not.toContain('old step')
  expect(toText(map, { isFull: true })).toContain('  └ ✓ old step')
})

test('a map kept before topics is split into topics by when each step was recorded', () => {
  const legacy = {
    goals: [
      { text: 'First', at: 0 },
      { text: 'first, reworded', at: 5 },
      { text: 'Second', at: 10 },
    ],
    nodes: [
      { id: 'n1', kind: 'step', title: 'a', status: 'done', parent: null, at: 1 },
      { id: 'n2', kind: 'branch', title: 'side', status: 'active', parent: null, at: 11 },
      { id: 'n3', kind: 'step', title: 'b', status: 'active', parent: 'n2', at: 3 },
    ],
    cursor: 'n2',
  }
  const map = migrate(legacy)
  expect(map?.topics.map(one => one.wordings.map(w => w.text))).toEqual([['First'], ['first, reworded', 'Second']])
  expect(map?.current).toBe('t3')
  expect(map?.nodes.map(one => one.topic)).toEqual(['t1', 't3', 't3'])
  expect(map && statusLine(map)).toBe('◎ Second · ↳ side')
  expect(migrate(map)).toBe(map)
  expect(migrate('nonsense')).toBe(undefined)
})

test('steps fill the plan in place and history reads before it', () => {
  const map = run(
    { action: 'goal', text: 'G' },
    { action: 'plan', items: ['A', 'B', 'C'] },
    { action: 'step', text: 'A' },
    { action: 'step', text: 'Unplanned' },
    { action: 'step', text: 'b', status: 'active' },
  )
  expect(map.nodes.map(one => `${one.title}:${one.status}`)).toEqual([
    'A:done',
    'Unplanned:done',
    'b:active',
    'C:planned',
  ])
})

test('a new active step marks the previous active one done', () => {
  const map = run(
    { action: 'step', text: 'one', status: 'active' },
    { action: 'step', text: 'two', status: 'active' },
  )
  expect(map.nodes.map(one => one.status)).toEqual(['done', 'active'])
})

test('a side task branches off and returns to where it left', () => {
  const map = run(
    { action: 'goal', text: 'G' },
    { action: 'step', text: 'first' },
    { action: 'branch', text: 'fix lint' },
    { action: 'step', text: 'update eslint', status: 'active' },
    { action: 'return', text: 'lint green' },
    { action: 'step', text: 'second', status: 'active' },
  )
  expect(currentTopic(map)?.cursor).toBe(null)
  const branch = map.nodes.find(one => one.kind === 'branch')
  expect(branch?.status).toBe('done')
  expect(branch?.outcome).toBe('lint green')
  expect(map.nodes.find(one => one.title === 'update eslint')?.status).toBe('done')
  expect(rows(map).map(row => row.guide)).toEqual(['├ ', '├ ', '│ └ ', '└ '])
  expect(toText(map)).toContain('✓ ↳ fix lint → lint green')
  expect(toText(map)).toContain('▶ second   ← now')
})

test('return on the main line is an error, as are missing texts', () => {
  expect(apply(EMPTY, { action: 'return' }, 0)).toEqual({
    error: 'return: work is already on the main line.',
  })
  expect('error' in apply(EMPTY, { action: 'goal', text: '  ' }, 0)).toBe(true)
  expect('error' in apply(EMPTY, { action: 'plan', items: [] }, 0)).toBe(true)
})

test('the status line names the goal and the side task', () => {
  const map = run({ action: 'goal', text: 'Ship it' }, { action: 'branch', text: 'flaky test' })
  expect(statusLine(map)).toBe('◎ Ship it · ↳ flaky test')
  expect(statusLine(EMPTY)).toBe(undefined)
})

test('the tool updates the map and the pane draws it on every surface', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(seen.opened).toEqual([])
  const set = await $.tool.call({ tool: TOOL, action: 'goal', text: 'Migrate auth' })
  expect(set.deny).toBe(undefined)
  await $.tool.call({ tool: TOOL, action: 'plan', items: ['Client', 'Sessions'] })
  await $.tool.call({ tool: TOOL, action: 'step', text: 'Client' })
  await $.tool.call({ tool: TOOL, action: 'branch', text: 'CI lint' })
  const last = await $.tool.call({ tool: TOOL, action: 'step', text: 'eslint', status: 'active' })
  expect(last.result).toContain('Goal: Migrate auth')
  expect(last.result).toContain('▶ eslint   ← now')

  expect(seen.opened.length).toBeGreaterThan(0)
  expect(seen.status[seen.status.length - 1]).toBe('◎ Migrate auth · ↳ CI lint')

  const refused = await $.tool.call({ tool: TOOL, action: 'goal' })
  expect(refused.deny).toContain('goal needs `text`')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-map', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /Migrate auth/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↳ CI lint/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /← зараз/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a resumed session draws the map it kept', async ($, on) => {
  const kept = run({ action: 'goal', text: 'Kept goal' }, { action: 'step', text: 'kept step' })
  const seen = world(on, { 's:test-session': kept, index: ['test-session'] })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(seen.opened).toEqual(['session-map'])
  const ui = await $.ui.mount({ plugin: 'session-map', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Kept goal/ })).toBeDefined()
  await ui.unmount()
})

test('the pane draws the current topic in full and earlier topics in a line each', async ($, on) => {
  world(on)
  await $.tool.call({ tool: TOOL, action: 'goal', text: 'Old task' })
  await $.tool.call({ tool: TOOL, action: 'step', text: 'old step' })
  await $.tool.call({ tool: TOOL, action: 'topic', text: 'New task' })
  await $.tool.call({ tool: TOOL, action: 'step', text: 'new step', status: 'active' })
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-map', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /◎ New task/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /← зараз/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Раніше' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✓ Old task · 1 ✓' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /old step/ })).toBe(undefined)
    await ui.unmount()
  }
})

test('a resumed session draws a map kept before topics', async ($, on) => {
  const legacy = {
    goals: [{ text: 'Kept from 0.1', at: 0 }],
    nodes: [{ id: 'n1', kind: 'step', title: 'kept step', status: 'done', parent: null, at: 1 }],
    cursor: null,
  }
  world(on, { 's:test-session': legacy, index: ['test-session'] })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'session-map', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Kept from 0.1/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'title-n1' })).toBeDefined()
  await ui.unmount()
  const next = await $.tool.call({ tool: TOOL, action: 'step', text: 'after resume' })
  expect(next.result).toContain('✓ kept step')
  expect(next.result).toContain('✓ after resume')
})

test('the pane says it is empty before a goal is set', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-map', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /Мапа порожня/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a long stretch without map updates reminds the model once', async ($, on) => {
  on('tool.call', { tool: 'Read' }, () => ({ result: 'contents' }))
  const contexts: (readonly string[] | undefined)[] = []
  for (let i = 0; i < 26; i += 1) {
    const ran = await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
    contexts.push(ran.context)
  }
  expect(contexts.slice(0, 24).every(one => one === undefined || one.length === 0)).toBe(true)
  expect(contexts[24]?.[0]).toContain('session-map:')
  expect(contexts[25]).toBe(undefined)
})

test('the system prompt carries the guide, after the shared sections', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  const composed = await $.prompt.compose({
    model: 'claude-test',
    promptModel: 'claude-test',
    surfaces: ['terminal'],
    tools: [TOOL],
    outputStyle: null,
    traits: [],
  })
  const ids = composed.sections.map(one => one.id)
  expect(ids).toEqual(['intro', 'session-map:guide'])
  expect(composed.sections[1]?.scope).toBe('session')
  expect(composed.sections[1]?.text).toContain(TOOL)
})

const resultRow = (id: string) =>
  ({
    component: 'ToolResult',
    requestId: id,
    props: { tool_use_id: id, tool: TOOL, output: '', isErrored: false },
  }) as const

test('each update call draws one line in the transcript: what it changed, never the whole map', async ($, on) => {
  world(on)
  await $.tool.call({ tool: TOOL, tool_use_id: 'call-1', action: 'goal', text: 'Phone goal' })
  await $.tool.call({ tool: TOOL, tool_use_id: 'call-2', action: 'plan', items: ['Draft', 'Send'] })
  await $.tool.call({ tool: TOOL, tool_use_id: 'call-3', action: 'branch', text: 'side quest' })
  await $.tool.call({ tool: TOOL, tool_use_id: 'call-4', action: 'step', text: 'probe', status: 'active' })
  await $.tool.call({ tool: TOOL, tool_use_id: 'call-5', action: 'return', text: 'found it' })
  const lines: Record<string, string> = {
    'call-1': '◎ Phone goal',
    'call-2': '○ Draft · Send',
    'call-3': '↳ side quest',
    'call-4': '▶ probe',
    'call-5': '↩ side quest → found it',
  }
  for (const surface of ['terminal', 'desktop', 'mobile', 'vscode'] as const) {
    for (const [id, line] of Object.entries(lines)) {
      const row = await $.ui.mount({ plugin: 'session-map', surface, ...resultRow(id) })
      const text = await row.find({ type: 'Text' })
      expect(text?.text).toBe(line)
      expect(text?.props.dimColor).toBe(id !== 'call-5')
      expect((await row.find({ type: 'Text', text: /Phone goal/ })) !== undefined).toBe(id === 'call-1')
      await row.unmount()
    }
  }
})

test('a call from before the plugin kept lines still says the map changed', async ($, on) => {
  world(on)
  await $.tool.call({ tool: TOOL, tool_use_id: 'call-1', action: 'goal', text: 'G' })
  const row = await $.ui.mount({ plugin: 'session-map', surface: 'terminal', ...resultRow('unknown') })
  expect((await row.find({ type: 'Text' }))?.text).toBe('◎ мапу оновлено')
  await row.unmount()
})

test('a long title wraps beside the tree guide, not under it', async ($, on) => {
  world(on)
  await $.tool.call({ tool: TOOL, action: 'goal', text: 'G' })
  await $.tool.call({ tool: TOOL, action: 'branch', text: 'side task' })
  await $.tool.call({ tool: TOOL, action: 'step', text: 'a step long enough to wrap in a narrow pane' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-map', surface, ...PANE })
    const guide = await ui.find({ type: 'Box', key: 'guide-n2' })
    expect(guide?.text).toBe('  └ ✓ ')
    expect(guide?.props.flexShrink).toBe(0)
    const title = await ui.find({ type: 'Box', key: 'title-n2' })
    expect(title?.text).toBe('a step long enough to wrap in a narrow pane')
    expect(title?.props.flexShrink).toBe(1)
    await ui.unmount()
  }
})

test('the command says why the pane is not shown', async ($, on) => {
  world(on, undefined, { isPlaced: false, reason: 'the attached desktop places no panes' })
  const ran = await $.command.run({ command: 'session-map', args: '' })
  expect(ran.text).toBe('Session map is open but not shown: the attached desktop places no panes')
})

test('the command says where the pane went on the main screen', async ($, on) => {
  world(on)
  const run = (isFullscreen: boolean) =>
    $.command.run({ command: 'session-map', args: '', presentation: { isFullscreen, columns: 120 } } as CommandRunArgs)
  const inline = await run(false)
  expect(inline.text).toContain('above the prompt')
  expect(inline.text).toContain('/tui fullscreen')
  expect((await run(true)).text).toBe('Session map opened.')
})

test('the pane draws on the phone and in VS Code as well', async ($, on) => {
  world(on)
  await $.tool.call({ tool: TOOL, action: 'goal', text: 'Everywhere' })
  for (const surface of ['mobile', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-map', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /Everywhere/ })).toBeDefined()
    await ui.unmount()
  }
})
