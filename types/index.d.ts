export type NodeStatus = 'done' | 'active' | 'planned' | 'dropped'

export type MapNode = {
  id: string
  kind: 'step' | 'branch'
  title: string
  status: NodeStatus
  /** The branch the node sits in; null is the main line. */
  parent: string | null
  /** How a branch ended, given when work returned from it. */
  outcome?: string
  at: number
}

export type SessionMap = {
  /** Every wording the goal had, oldest first; the last is the current one. */
  goals: { text: string; at: number }[]
  nodes: MapNode[]
  /** The branch work is in now; null is the main line. */
  cursor: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-map': {
      map: SessionMap
      isHidden: boolean
      lastCall: string | null
      /** The transcript line of each update call, by tool_use_id. */
      calls: Record<string, string>
    }
  }
}
