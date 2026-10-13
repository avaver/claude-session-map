import type { MapNode, NodeStatus, SessionMap, Topic } from '../types'

export const EMPTY: SessionMap = { topics: [], current: null, nodes: [] }

export type Action = 'topic' | 'goal' | 'plan' | 'step' | 'branch' | 'return'

export type Update = {
  action: Action
  text?: string
  items?: string[]
  status?: NodeStatus
}

export type Applied = { map: SessionMap } | { error: string }

const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')

const clean = (text: unknown) => (typeof text === 'string' ? text.trim() : '')

export const title = (topic: Topic) => topic.wordings[topic.wordings.length - 1]?.text

export const currentTopic = (map: SessionMap) => map.topics.find(one => one.id === map.current)

export const goal = (map: SessionMap) => {
  const topic = currentTopic(map)

  return topic ? title(topic) : undefined
}

const cursorOf = (map: SessionMap) => currentTopic(map)?.cursor ?? null

export const branchOf = (map: SessionMap, id: string | null) =>
  id === null ? undefined : map.nodes.find(one => one.id === id && one.kind === 'branch')

/** Puts `node` before the first planned node of its branch, so history reads before the plan. */
const placeBeforePlan = (nodes: MapNode[], node: MapNode): MapNode[] => {
  const rest = nodes.filter(one => one.id !== node.id)
  const at = rest.findIndex(
    one => one.topic === node.topic && one.parent === node.parent && one.status === 'planned',
  )

  return at === -1 ? [...rest, node] : [...rest.slice(0, at), node, ...rest.slice(at)]
}

const nextId = (map: SessionMap) => `n${map.nodes.length + 1}`

const nextTopicId = (map: SessionMap) =>
  `t${map.topics.reduce((most, one) => Math.max(most, Number(one.id.slice(1)) || 0), 0) + 1}`

const startTopic = (map: SessionMap, at: number, text?: string): SessionMap => {
  const topic: Topic = { id: nextTopicId(map), wordings: text ? [{ text, at }] : [], cursor: null, at }

  return { ...map, topics: [...map.topics, topic], current: topic.id }
}

/** The map with a current topic: steps recorded before any goal go into an unnamed one. */
const withTopic = (map: SessionMap, at: number): SessionMap => (currentTopic(map) ? map : startTopic(map, at))

const setCursor = (map: SessionMap, cursor: string | null): SessionMap => ({
  ...map,
  topics: map.topics.map(one => (one.id === map.current ? { ...one, cursor } : one)),
})

export const apply = (map: SessionMap, change: Update, at: number): Applied => {
  const text = clean(change.text)

  switch (change.action) {
    case 'topic': {
      if (!text) return { error: 'topic needs `text`: the new task in a few words.' }
      const known = map.topics.find(one => norm(title(one) ?? '') === norm(text))
      if (known) return { map: { ...map, current: known.id } }

      return { map: startTopic(map, at, text) }
    }

    case 'goal': {
      if (!text) return { error: 'goal needs `text`: the current task as it reads now.' }
      const topic = currentTopic(map)
      if (!topic) return { map: startTopic(map, at, text) }
      if (norm(title(topic) ?? '') === norm(text)) return { map }
      const wordings = [...topic.wordings, { text, at }]

      return { map: { ...map, topics: map.topics.map(one => (one.id === topic.id ? { ...one, wordings } : one)) } }
    }

    case 'plan': {
      const items = (change.items ?? []).map(clean).filter(Boolean)
      if (items.length === 0) return { error: 'plan needs `items`: the steps still ahead.' }
      let next = withTopic(map, at)
      const topic = next.current as string
      const parent = cursorOf(next)
      for (const item of items) {
        const isKnown = next.nodes.some(
          one => one.topic === topic && one.parent === parent && norm(one.title) === norm(item),
        )
        if (isKnown) continue
        const node: MapNode = { id: nextId(next), kind: 'step', title: item, status: 'planned', topic, parent, at }
        next = { ...next, nodes: [...next.nodes, node] }
      }

      return { map: next }
    }

    case 'step': {
      if (!text) return { error: 'step needs `text`: the milestone in a few words.' }
      const base = withTopic(map, at)
      const topic = base.current as string
      const parent = cursorOf(base)
      const status = change.status ?? 'done'
      const isHere = (one: MapNode) => one.kind === 'step' && one.topic === topic && one.parent === parent
      const known = base.nodes.find(one => isHere(one) && norm(one.title) === norm(text))
      let nodes = base.nodes
      if (status === 'active') {
        nodes = nodes.map(one =>
          isHere(one) && one.status === 'active' && one.id !== known?.id ? { ...one, status: 'done' } : one,
        )
      }
      const node: MapNode = known
        ? { ...known, title: text, status, at }
        : { id: nextId(base), kind: 'step', title: text, status, topic, parent, at }
      nodes = status === 'planned' && !known ? [...nodes, node] : placeBeforePlan(nodes, node)

      return { map: { ...base, nodes } }
    }

    case 'branch': {
      if (!text) return { error: 'branch needs `text`: the side task in a few words.' }
      const base = withTopic(map, at)
      const node: MapNode = {
        id: nextId(base),
        kind: 'branch',
        title: text,
        status: 'active',
        topic: base.current as string,
        parent: cursorOf(base),
        at,
      }

      return { map: setCursor({ ...base, nodes: placeBeforePlan(base.nodes, node) }, node.id) }
    }

    case 'return': {
      const branch = branchOf(map, cursorOf(map))
      if (!branch) return { error: 'return: work is already on the main line.' }
      const status: NodeStatus = change.status === 'dropped' ? 'dropped' : 'done'
      const nodes = map.nodes.map(one => {
        if (one.id === branch.id) return { ...one, status, outcome: text || undefined }
        if (one.parent === branch.id && one.status === 'active') return { ...one, status }

        return one
      })

      return { map: setCursor({ ...map, nodes }, branch.parent) }
    }

    default:
      return { error: `unknown action: ${String((change as { action: unknown }).action)}` }
  }
}

export const ICON: Record<NodeStatus, string> = {
  done: '✓',
  active: '▶',
  planned: '○',
  dropped: '✗',
}

export type Row = {
  id: string
  /** Tree guides ahead of the node: `│ `, `├ `, `└ `. */
  guide: string
  node: MapNode
  isCurrent: boolean
}

/** The nodes of one topic in drawing order, each with the guides that place it in the tree. */
export const rows = (map: SessionMap, topic: string | null = map.current): Row[] => {
  const out: Row[] = []
  const isWorkingTopic = topic === map.current
  const cursor = map.topics.find(one => one.id === topic)?.cursor ?? null
  const walk = (parent: string | null, lead: string) => {
    const kids = map.nodes.filter(one => one.topic === topic && one.parent === parent)
    kids.forEach((node, i) => {
      const isLast = i === kids.length - 1
      const isCurrent =
        isWorkingTopic &&
        (node.kind === 'branch' ? node.id === cursor : node.status === 'active' && node.parent === cursor)
      out.push({ id: node.id, guide: lead + (isLast ? '└ ' : '├ '), node, isCurrent })
      if (node.kind === 'branch') walk(node.id, lead + (isLast ? '  ' : '│ '))
    })
  }
  walk(null, '')

  return out
}

/** Topics other than the current one, the latest first. */
export const earlierTopics = (map: SessionMap) => map.topics.filter(one => one.id !== map.current).reverse()

/** A topic in one line: how far it got and what it holds. */
export const summary = (map: SessionMap, topic: Topic) => {
  const nodes = map.nodes.filter(one => one.topic === topic.id)
  const count = (status: NodeStatus) => nodes.filter(one => one.status === status).length
  const icon = count('active') > 0 ? ICON.active : count('planned') > 0 ? ICON.planned : ICON.done
  const counts = (['done', 'active', 'planned', 'dropped'] as const)
    .filter(status => count(status) > 0)
    .map(status => `${count(status)} ${ICON[status]}`)

  return { icon, text: [title(topic) ?? 'без назви', ...counts].join(' · ') }
}

const topicLines = (map: SessionMap, topic: string) =>
  rows(map, topic).map(({ guide, node, isCurrent }) => {
    const label = node.kind === 'branch' ? `↳ ${node.title}` : node.title
    const outcome = node.outcome ? ` → ${node.outcome}` : ''

    return `${guide}${ICON[node.status]} ${label}${outcome}${isCurrent ? '   ← now' : ''}`
  })

/**
 * The map as plain text: the current topic in full and the earlier ones in a line each.
 * `isFull` spells out every topic, as `/session-map text` prints it.
 */
export const toText = (map: SessionMap, { isFull = false }: { isFull?: boolean } = {}) => {
  const topic = currentTopic(map)
  if (map.topics.length === 0 && map.nodes.length === 0) return 'The session map is empty.'
  const reworded = topic && topic.wordings.length > 1 ? ` (reworded ${topic.wordings.length - 1}×)` : ''
  const lines = [`Goal: ${goal(map) ?? '(not set)'}${reworded}`, ...(topic ? topicLines(map, topic.id) : [])]
  const earlier = earlierTopics(map)
  if (earlier.length > 0) lines.push('', 'Earlier topics:')
  for (const one of earlier) {
    const { icon, text } = summary(map, one)
    lines.push(`${icon} ${text}`)
    if (isFull) lines.push(...topicLines(map, one.id).map(line => `  ${line}`))
  }

  return lines.join('\n')
}

/** One line for the status bar: the goal and the side task work is in. */
export const statusLine = (map: SessionMap, width = 70) => {
  const head = goal(map)
  if (!head) return undefined
  const branch = branchOf(map, cursorOf(map))
  const line = branch ? `◎ ${head} · ↳ ${branch.title}` : `◎ ${head}`

  return line.length > width ? `${line.slice(0, width - 1)}…` : line
}

/** One line for the transcript: what `change` did to `before`. */
export const describe = (before: SessionMap, change: Update) => {
  const text = clean(change.text)

  switch (change.action) {
    case 'topic':
    case 'goal':
      return `◎ ${text}`
    case 'plan':
      return `${ICON.planned} ${(change.items ?? []).map(clean).filter(Boolean).join(' · ')}`
    case 'step':
      return `${ICON[change.status ?? 'done']} ${text}`
    case 'branch':
      return `↳ ${text}`
    case 'return': {
      const branch = branchOf(before, cursorOf(before))?.title ?? ''

      return text ? `↩ ${branch} → ${text}` : `↩ ${branch}`
    }
  }
}

type LegacyMap = {
  goals: { text: string; at: number }[]
  nodes: Omit<MapNode, 'topic'>[]
  cursor: string | null
}

const isLegacy = (value: Record<string, unknown>): value is LegacyMap & Record<string, unknown> =>
  Array.isArray(value.goals) && Array.isArray(value.nodes)

/**
 * A stored map in the current shape. A map from before topics gets one topic per goal wording;
 * each node goes to the wording that was current when it was recorded, and wordings that
 * collected nothing join the next topic as its earlier wordings.
 */
export const migrate = (value: unknown): SessionMap | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const stored = value as Record<string, unknown>
  if (Array.isArray(stored.topics) && Array.isArray(stored.nodes)) return value as SessionMap
  if (!isLegacy(stored)) return undefined

  const wordings = stored.goals.length > 0 ? stored.goals : [{ text: '', at: stored.nodes[0]?.at ?? 0 }]
  const starts = wordings.map((one, i) => ({ id: `t${i + 1}`, at: one.at }))
  const topicAt = (at: number) => starts.filter(one => one.at <= at).pop()?.id ?? 't1'
  const byId = new Map(stored.nodes.map(one => [one.id, one]))
  const topicOf = (node: Omit<MapNode, 'topic'>): string => {
    const parent = node.parent === null ? undefined : byId.get(node.parent)

    return parent ? topicOf(parent) : topicAt(node.at)
  }
  const nodes: MapNode[] = stored.nodes.map(one => ({ ...one, topic: topicOf(one) }))

  const topics: Topic[] = []
  let pending: Topic['wordings'] = []
  wordings.forEach((wording, i) => {
    const id = `t${i + 1}`
    const isLast = i === wordings.length - 1
    const named = wording.text ? [wording] : []
    if (!isLast && !nodes.some(one => one.topic === id)) {
      pending = [...pending, ...named]

      return
    }
    topics.push({ id, wordings: [...pending, ...named], cursor: null, at: wording.at })
    pending = []
  })

  const cursorTopic = stored.cursor === null ? undefined : nodes.find(one => one.id === stored.cursor)?.topic
  const current = topics[topics.length - 1]?.id ?? null

  return {
    topics: topics.map(one => (one.id === cursorTopic ? { ...one, cursor: stored.cursor } : one)),
    current,
    nodes,
  }
}
