import type { MapNode, NodeStatus, SessionMap } from '../types'

export const EMPTY: SessionMap = { goals: [], nodes: [], cursor: null }

export type Action = 'goal' | 'plan' | 'step' | 'branch' | 'return'

export type Update = {
  action: Action
  text?: string
  items?: string[]
  status?: NodeStatus
}

export type Applied = { map: SessionMap } | { error: string }

const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')

const clean = (text: unknown) => (typeof text === 'string' ? text.trim() : '')

/** Puts `node` before the first planned node of its branch, so history reads before the plan. */
const placeBeforePlan = (nodes: MapNode[], node: MapNode): MapNode[] => {
  const rest = nodes.filter(one => one.id !== node.id)
  const at = rest.findIndex(one => one.parent === node.parent && one.status === 'planned')

  return at === -1 ? [...rest, node] : [...rest.slice(0, at), node, ...rest.slice(at)]
}

const nextId = (map: SessionMap) => `n${map.nodes.length + 1}`

export const branchOf = (map: SessionMap, id: string | null) =>
  id === null ? undefined : map.nodes.find(one => one.id === id && one.kind === 'branch')

export const apply = (map: SessionMap, change: Update, at: number): Applied => {
  const text = clean(change.text)

  switch (change.action) {
    case 'goal': {
      if (!text) return { error: 'goal needs `text`: the goal as it reads now.' }
      const last = map.goals[map.goals.length - 1]
      if (last && norm(last.text) === norm(text)) return { map }

      return { map: { ...map, goals: [...map.goals, { text, at }] } }
    }

    case 'plan': {
      const items = (change.items ?? []).map(clean).filter(Boolean)
      if (items.length === 0) return { error: 'plan needs `items`: the steps still ahead.' }
      let next = map
      for (const title of items) {
        const isKnown = next.nodes.some(
          one => one.parent === next.cursor && norm(one.title) === norm(title),
        )
        if (isKnown) continue
        const node: MapNode = {
          id: nextId(next),
          kind: 'step',
          title,
          status: 'planned',
          parent: next.cursor,
          at,
        }
        next = { ...next, nodes: [...next.nodes, node] }
      }

      return { map: next }
    }

    case 'step': {
      if (!text) return { error: 'step needs `text`: the milestone in a few words.' }
      const status = change.status ?? 'done'
      const known = map.nodes.find(
        one => one.kind === 'step' && one.parent === map.cursor && norm(one.title) === norm(text),
      )
      let nodes = map.nodes
      if (status === 'active') {
        nodes = nodes.map(one =>
          one.kind === 'step' && one.parent === map.cursor && one.status === 'active' && one.id !== known?.id
            ? { ...one, status: 'done' }
            : one,
        )
      }
      const node: MapNode = known
        ? { ...known, title: text, status, at }
        : { id: nextId(map), kind: 'step', title: text, status, parent: map.cursor, at }
      nodes = status === 'planned' && !known ? [...nodes, node] : placeBeforePlan(nodes, node)

      return { map: { ...map, nodes } }
    }

    case 'branch': {
      if (!text) return { error: 'branch needs `text`: the side task in a few words.' }
      const node: MapNode = {
        id: nextId(map),
        kind: 'branch',
        title: text,
        status: 'active',
        parent: map.cursor,
        at,
      }

      return { map: { ...map, nodes: placeBeforePlan(map.nodes, node), cursor: node.id } }
    }

    case 'return': {
      const branch = branchOf(map, map.cursor)
      if (!branch) return { error: 'return: work is already on the main line.' }
      const status: NodeStatus = change.status === 'dropped' ? 'dropped' : 'done'
      const nodes = map.nodes.map(one => {
        if (one.id === branch.id) return { ...one, status, outcome: text || undefined }
        if (one.parent === branch.id && one.status === 'active') return { ...one, status }

        return one
      })

      return { map: { ...map, nodes, cursor: branch.parent } }
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

/** The nodes in drawing order, each with the guides that place it in the tree. */
export const rows = (map: SessionMap): Row[] => {
  const out: Row[] = []
  const walk = (parent: string | null, lead: string) => {
    const kids = map.nodes.filter(one => one.parent === parent)
    kids.forEach((node, i) => {
      const isLast = i === kids.length - 1
      const isCurrent =
        node.kind === 'branch'
          ? node.id === map.cursor
          : node.status === 'active' && node.parent === map.cursor
      out.push({ id: node.id, guide: lead + (isLast ? '└ ' : '├ '), node, isCurrent })
      if (node.kind === 'branch') walk(node.id, lead + (isLast ? '  ' : '│ '))
    })
  }
  walk(null, '')

  return out
}

export const goal = (map: SessionMap) => map.goals[map.goals.length - 1]?.text

/** The map as plain text: what the tool answers and what `/session-map text` prints. */
export const toText = (map: SessionMap) => {
  const head = goal(map)
  if (!head && map.nodes.length === 0) return 'The session map is empty.'
  const changed = map.goals.length > 1 ? ` (goal reworded ${map.goals.length - 1}×)` : ''
  const lines = [`Goal: ${head ?? '(not set)'}${changed}`]
  for (const row of rows(map)) {
    const { node } = row
    const label = node.kind === 'branch' ? `↳ ${node.title}` : node.title
    const outcome = node.outcome ? ` → ${node.outcome}` : ''
    lines.push(`${row.guide}${ICON[node.status]} ${label}${outcome}${row.isCurrent ? '   ← now' : ''}`)
  }

  return lines.join('\n')
}

/** One line for the status bar: the goal and the side task work is in. */
export const statusLine = (map: SessionMap, width = 70) => {
  const head = goal(map)
  if (!head) return undefined
  const branch = branchOf(map, map.cursor)
  const line = branch ? `◎ ${head} · ↳ ${branch.title}` : `◎ ${head}`

  return line.length > width ? `${line.slice(0, width - 1)}…` : line
}
