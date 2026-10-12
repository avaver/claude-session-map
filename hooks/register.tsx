import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, UiOpenResult } from 'claude-code'

import type { NodeStatus, SessionMap } from '../types'
import { EMPTY, ICON, apply, goal, rows, statusLine, toText } from './map'
import type { Update } from './map'

const PANE = 'session-map'
const TITLE = 'Session map'
const TOOL = 'mcp__session-map__update'
/** Main-loop tool calls without a map update before the model is reminded once. */
const NUDGE_EVERY = 25
/** Sessions whose maps the store keeps for a resume. */
const KEEP = 40

const mapAtom = atom({ plugin: 'session-map', key: 'map' } as const, EMPTY)
const isHidden = atom({ plugin: 'session-map', key: 'isHidden' } as const, false)
/** The newest update call, whose result row in the transcript draws the whole map. */
const lastCall = atom({ plugin: 'session-map', key: 'lastCall' } as const, null)

const DESCRIPTION = `Updates the session map the person watches in a side pane: the goal, the milestones reached, and the side tasks work branched into. One action per call:
- goal: set the goal (text) once it is clear; call again with the new wording when the person changes or extends it.
- plan: lay out the steps still ahead (items), shown as planned.
- step: record a milestone (text). status "done" (default) when it finished, "active" when work on it starts (the branch's previous active step becomes done), "dropped" when abandoned. A step whose title matches a planned one updates it.
- branch: open a side task (text) the goal does not need by itself: a failing unrelated test, a tooling problem, a side question. Later steps go into it.
- return: close the current side task, status "done" (default) or "dropped", text = how it ended. Work goes back to where it branched from.
Titles are a few words in the language the person writes in. Answers with the map as it now stands.`

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['goal', 'plan', 'step', 'branch', 'return'] },
    text: { type: 'string', description: 'The goal, step or side task; for return, how it ended.' },
    items: { type: 'array', items: { type: 'string' }, description: 'plan: the steps ahead, in order.' },
    status: { type: 'string', enum: ['done', 'active', 'planned', 'dropped'] },
  },
  required: ['action'],
}

const GUIDE = `# Session map

The person follows this session through a map drawn from the \`${TOOL}\` tool. Keep it current for any task longer than a couple of steps:
- Once the goal is clear, set it (action goal). When the person changes or extends it, set it again with the new wording.
- Record milestones as they finish (step), not every tool call: a handful per goal. When you know the steps ahead, lay them out with plan.
- When you divert into something the goal does not need by itself (an unrelated failing test, a tooling problem, a side question from the person), open a branch, and return when it ends, saying how it ended.
- Titles are a few words in the person's language. Do not narrate the map in your replies: the person sees it.
Skip it for a single question or a one-step change.`

const NUDGE = `session-map: ${NUDGE_EVERY} tool calls since the session map last changed. If a milestone finished, the goal shifted, or work went into a side task, record it with ${TOOL}; otherwise carry on.`

const isMap = (value: unknown): value is SessionMap =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as SessionMap).goals) &&
  Array.isArray((value as SessionMap).nodes)

const isEmpty = (map: SessionMap) => map.goals.length === 0 && map.nodes.length === 0

/** Keeps the map past the session, so a resumed session draws it again. */
const save = async ($: EngineInterface, map: SessionMap) => {
  const id = await $.session.id()
  const index = ((await $.store.get('index')) as string[] | undefined) ?? []
  const kept = [...index.filter(one => one !== id), id]
  for (const old of kept.slice(0, -KEEP)) await $.store.delete(`s:${old}`)
  await $.store.set(`s:${id}`, map)
  await $.store.set('index', kept.slice(-KEEP))
}

/** Sets the status line and opens the pane unless the person closed it; answers how the open went. */
const show = async ($: EngineInterface, map: SessionMap): Promise<UiOpenResult | undefined> => {
  $.ui.status(statusLine(map))
  if (isEmpty(map) || (await read($, isHidden))) return undefined

  return $.ui.open({ id: PANE, title: TITLE })
}

const COLOR: Record<NodeStatus, string> = {
  done: 'success',
  active: 'claude',
  planned: 'inactive',
  dropped: 'error',
}

export const register: Register = on => {
  let sinceUpdate = 0

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'update',
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: 'session-map',
      description: 'Open the session map pane; `text` prints it, `reset` clears it',
      argumentHint: '[text | reset]',
    })
    let map = await read($, mapAtom)
    if (isEmpty(map)) {
      const kept = await $.store.get(`s:${await $.session.id()}`)
      if (isMap(kept) && !isEmpty(kept)) map = await update($, mapAtom, () => kept)
    }
    void show($, map)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return {
      sections: [...composed.sections, { id: 'session-map:guide', text: GUIDE, scope: 'session' }],
    }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const change: Update = {
      action: input.action as Update['action'],
      text: typeof input.text === 'string' ? input.text : undefined,
      items: Array.isArray(input.items) ? input.items.map(String) : undefined,
      status: input.status as NodeStatus | undefined,
    }
    const now = await $.clock.now()
    let failure: string | undefined
    const map = await update($, mapAtom, current => {
      const out = apply(current, change, now)
      if ('error' in out) {
        failure = out.error

        return current
      }
      failure = undefined

      return out.map
    })
    if (failure !== undefined) return { deny: failure }
    sinceUpdate = 0
    if (e.tool_use_id !== undefined) await update($, lastCall, () => e.tool_use_id ?? null)
    await save($, map)
    const opened = await show($, map)
    const note =
      opened?.isPlaced === false
        ? `\n(The side pane is not on the person's screen: ${opened.reason}. They see the map drawn under this call.)`
        : ''

    return { result: toText(map) + note }
  }).catch(() => ({ deny: 'session-map: the map could not be updated.' }))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || e.tool === TOOL || ran.deny !== undefined) return ran
    sinceUpdate += 1
    if (sinceUpdate < NUDGE_EVERY) return ran
    sinceUpdate = 0

    return { ...ran, context: [...(ran.context ?? []), NUDGE] }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'session-map' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'reset') {
      await update($, mapAtom, () => EMPTY)
      await save($, EMPTY)
      $.ui.status(undefined)

      return { text: 'Session map cleared.' }
    }
    if (arg === 'text') return { text: toText(await read($, mapAtom)) }
    await update($, isHidden, () => false)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Session map opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, isHidden, () => true)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    drawMap($.ui.resolve(e), await read($, mapAtom), { isFull: true }),
  )

  // The transcript draws the map too, under the newest update call: the one
  // place every surface shows, the phone included, which seats no side pane.
  on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Text } = $.ui.resolve(e)
    if ((await read($, lastCall)) !== e.props.tool_use_id) {
      return <Text dimColor>◎ мапу оновлено</Text>
    }

    return drawMap($.ui.resolve(e), await read($, mapAtom), { isFull: false })
  })
}

type Drawing = Pick<Elements['terminal'], 'Box' | 'Text'>

/** The map as a tree of elements: the goal, its earlier wordings, the steps and side tasks. */
const drawMap = ({ Box, Text }: Drawing, map: SessionMap, { isFull }: { isFull: boolean }) => {
  if (isEmpty(map)) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Мапа порожня.</Text>
        <Text dimColor>Claude заповнить її, щойно ціль стане зрозумілою.</Text>
      </Box>
    )
  }

  const head = goal(map)
  const earlier = isFull ? map.goals.slice(0, -1).slice(-3) : []
  const count = (status: NodeStatus) => map.nodes.filter(one => one.status === status).length

  return (
    <Box flexDirection="column">
      <Text bold>◎ {head ?? 'Ціль ще не задана'}</Text>
      {earlier.map(one => (
        <Text dimColor strikethrough>
          {'  '}
          {one.text}
        </Text>
      ))}
      {map.goals.length > 1 && <Text dimColor> ціль змінювалась {map.goals.length - 1}×</Text>}
      {isFull && <Text> </Text>}
      {rows(map).map(row => {
        const { node } = row
        const isBranch = node.kind === 'branch'

        return (
          <Text>
            <Text dimColor>{row.guide}</Text>
            <Text color={COLOR[node.status]}>{ICON[node.status]} </Text>
            <Text
              bold={row.isCurrent}
              dimColor={node.status === 'planned' || node.status === 'dropped'}
              strikethrough={node.status === 'dropped'}
              color={isBranch ? 'suggestion' : undefined}
            >
              {isBranch ? `↳ ${node.title}` : node.title}
            </Text>
            {node.outcome !== undefined && <Text dimColor> → {node.outcome}</Text>}
            {row.isCurrent && <Text color="claude"> ← зараз</Text>}
          </Text>
        )
      })}
      {isFull && <Text> </Text>}
      {isFull && (
        <Text dimColor>
          ✓ {count('done')} · ▶ {count('active')} · ○ {count('planned')}
          {count('dropped') > 0 ? ` · ✗ ${count('dropped')}` : ''}
        </Text>
      )}
    </Box>
  )
}
