import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { EMPTY, apply, rows, statusLine, toText } from '../hooks/map'
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
const world = (on: On, stored?: Record<string, unknown>) => {
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

    return { value: { isPlaced: true } }
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
  expect(map.goals.map(one => one.text)).toEqual([
    'Migrate auth to OAuth',
    'Migrate auth to OAuth and drop sessions',
  ])
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
  expect(map.cursor).toBe(null)
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

test('the newest update call draws the whole map in the transcript, on the phone too', async ($, on) => {
  world(on)
  await $.tool.call({ tool: TOOL, tool_use_id: 'call-1', action: 'goal', text: 'Phone goal' })
  await $.tool.call({ tool: TOOL, tool_use_id: 'call-2', action: 'branch', text: 'side quest' })
  for (const surface of ['terminal', 'desktop', 'mobile', 'vscode'] as const) {
    const newest = await $.ui.mount({ plugin: 'session-map', surface, ...resultRow('call-2') })
    expect(await newest.find({ type: 'Text', text: /Phone goal/ })).toBeDefined()
    expect(await newest.find({ type: 'Text', text: /↳ side quest/ })).toBeDefined()
    await newest.unmount()
    const older = await $.ui.mount({ plugin: 'session-map', surface, ...resultRow('call-1') })
    expect(await older.find({ type: 'Text', text: /мапу оновлено/ })).toBeDefined()
    expect(await older.find({ type: 'Text', text: /Phone goal/ })).toBe(undefined)
    await older.unmount()
  }
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
