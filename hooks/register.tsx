import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, UiOpenResult } from 'claude-code'

import type { NodeStatus, SessionMap } from '../types'
import { EMPTY, ICON, apply, currentTopic, describe, earlierTopics, goal, migrate, rows, statusLine, summary, toText } from './map'
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
/** The newest update call, whose result row in the transcript is not dimmed. */
const lastCall = atom({ plugin: 'session-map', key: 'lastCall' } as const, null)
/** What each update call changed, by tool_use_id: the one line its result row draws. */
const calls = atom({ plugin: 'session-map', key: 'calls' } as const, {})
/** Update calls whose line the transcript keeps. */
const KEEP_CALLS = 200

const DESCRIPTION = `Updates the session map the person watches in a side pane: the topics of the session, the milestones reached in each, and the side tasks work branched into. One action per call:
- topic: start a new topic (text) when the person moves to a different task: another bug, work item or request. Steps already recorded stay under the topic they belong to. Naming an earlier topic's title returns to it.
- goal: reword the current topic (text) when the same task is clarified or extended. Sets the first topic when there is none yet.
- plan: lay out the steps still ahead (items), shown as planned.
- step: record a milestone (text). status "done" (default) when it finished, "active" when work on it starts (the branch's previous active step becomes done), "dropped" when abandoned. A step whose title matches a planned one updates it.
- branch: open a side task (text) the topic does not need by itself: a failing unrelated test, a tooling problem, a side question. Later steps go into it.
- return: close the current side task, status "done" (default) or "dropped", text = how it ended. Work goes back to where it branched from.
Titles are a few words in the language the person writes in. Answers with the map as it now stands.`

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['topic', 'goal', 'plan', 'step', 'branch', 'return'] },
    text: { type: 'string', description: 'The topic, goal wording, step or side task; for return, how it ended.' },
    items: { type: 'array', items: { type: 'string' }, description: 'plan: the steps ahead, in order.' },
    status: { type: 'string', enum: ['done', 'active', 'planned', 'dropped'] },
  },
  required: ['action'],
}

const GUIDE = `# Session map

The person follows this session through a map drawn from the \`${TOOL}\` tool. Keep it current for any task longer than a couple of steps:
- Once the task is clear, set it (action goal). When the person clarifies or extends the same task, reword it (goal again).
- When the person moves to a different task (another bug, work item or request), start a new topic (action topic), even when it grew out of the previous one. Coming back to an earlier task: topic with its title.
- Record milestones as they finish (step), not every tool call: a handful per topic. When you know the steps ahead, lay them out with plan.
- When you divert into something the topic does not need by itself (an unrelated failing test, a tooling problem, a side question from the person), open a branch, and return when it ends, saying how it ended.
- Titles are a few words in the person's language. Do not narrate the map in your replies: the person sees it.
Skip it for a single question or a one-step change.`

const NUDGE = `session-map: ${NUDGE_EVERY} tool calls since the session map last changed. If a milestone finished, the task changed, or work went into a side task, record it with ${TOOL}; otherwise carry on.`

const readMap = async ($: EngineInterface) => migrate(await read($, mapAtom)) ?? EMPTY

const isEmpty = (map: SessionMap) => map.topics.length === 0 && map.nodes.length === 0

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
    let map = await readMap($)
    if (isEmpty(map)) {
      const kept = await $.store.get(`s:${await $.session.id()}`)
      const restored = migrate(kept)
      if (restored && !isEmpty(restored)) map = await update($, mapAtom, () => restored)
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
    let line = ''
    const map = await update($, mapAtom, stored => {
      const current = migrate(stored) ?? EMPTY
      const out = apply(current, change, now)
      if ('error' in out) {
        failure = out.error

        return current
      }
      failure = undefined
      line = describe(current, change)

      return out.map
    })
    if (failure !== undefined) return { deny: failure }
    sinceUpdate = 0
    const id = e.tool_use_id
    if (id !== undefined) {
      await update($, lastCall, () => id)
      await update($, calls, kept => Object.fromEntries([...Object.entries(kept), [id, line]].slice(-KEEP_CALLS)))
    }
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
    if (arg === 'text') return { text: toText(await readMap($), { isFull: true }) }
    await update($, isHidden, () => false)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    if (!opened.isPlaced) return { text: `Session map is open but not shown: ${opened.reason}` }
    if (e.presentation?.isFullscreen === false) {
      return { text: 'Session map opened above the prompt. `/tui fullscreen` docks it beside the transcript.' }
    }

    return { text: 'Session map opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, isHidden, () => true)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    drawMap($.ui.resolve(e), await readMap($)),
  )

  // The transcript draws one line per update; the whole map lives in the pane and in `/session-map text`.
  on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Text } = $.ui.resolve(e)
    const line = (await read($, calls))[e.props.tool_use_id] ?? '◎ мапу оновлено'

    return <Text dimColor={(await read($, lastCall)) !== e.props.tool_use_id}>{line}</Text>
  })
}

type Drawing = Pick<Elements['terminal'], 'Box' | 'Text'>

/** The map as elements: the current topic in full, with its earlier wordings, then the earlier topics in a line each. */
const drawMap = ({ Box, Text }: Drawing, map: SessionMap) => {
  if (isEmpty(map)) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Мапа порожня.</Text>
        <Text dimColor>Claude заповнить її, щойно ціль стане зрозумілою.</Text>
      </Box>
    )
  }

  const head = goal(map)
  const wordings = currentTopic(map)?.wordings ?? []
  const reworded = wordings.slice(0, -1).slice(-3)
  const nodes = map.nodes.filter(one => one.topic === map.current)
  const count = (status: NodeStatus) => nodes.filter(one => one.status === status).length
  const earlier = earlierTopics(map)

  return (
    <Box flexDirection="column">
      <Text bold>◎ {head ?? 'Ціль ще не задана'}</Text>
      {reworded.map(one => (
        <Text dimColor strikethrough>
          {'  '}
          {one.text}
        </Text>
      ))}
      {wordings.length > 1 && <Text dimColor> ціль змінювалась {wordings.length - 1}×</Text>}
      <Text> </Text>
      {rows(map).map(row => {
        const { node } = row
        const isBranch = node.kind === 'branch'

        // The guide is its own column so a wrapped title stays under itself instead of the tree.
        return (
          <Box key={`row-${row.id}`} flexDirection="row">
            <Box key={`guide-${row.id}`} flexShrink={0}>
              <Text>
                <Text dimColor>{row.guide}</Text>
                <Text color={COLOR[node.status]}>{ICON[node.status]} </Text>
              </Text>
            </Box>
            <Box key={`title-${row.id}`} flexShrink={1}>
              <Text>
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
            </Box>
          </Box>
        )
      })}
      <Text> </Text>
      <Text dimColor>
        ✓ {count('done')} · ▶ {count('active')} · ○ {count('planned')}
        {count('dropped') > 0 ? ` · ✗ ${count('dropped')}` : ''}
      </Text>
      {earlier.length > 0 && <Text> </Text>}
      {earlier.length > 0 && <Text dimColor>Раніше</Text>}
      {earlier.map(one => {
        const line = summary(map, one)

        return (
          <Text key={`topic-${one.id}`} dimColor>
            {line.icon} {line.text}
          </Text>
        )
      })}
    </Box>
  )
}
