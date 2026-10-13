export type NodeStatus = 'done' | 'active' | 'planned' | 'dropped'

export type MapNode = {
  id: string
  kind: 'step' | 'branch'
  title: string
  status: NodeStatus
  /** The topic the node was recorded in. */
  topic: string
  /** The branch the node sits in; null is the topic's main line. */
  parent: string | null
  /** How a branch ended, given when work returned from it. */
  outcome?: string
  at: number
}

/** One task of the session: a bug, a check, a request. */
export type Topic = {
  id: string
  /** Every wording the topic had, oldest first; the last is the current one. Empty until it is named. */
  wordings: { text: string; at: number }[]
  /** The branch work is in inside this topic; null is its main line. */
  cursor: string | null
  at: number
}

export type SessionMap = {
  topics: Topic[]
  /** The topic work is in now. */
  current: string | null
  nodes: MapNode[]
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
