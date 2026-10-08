/** The person's most recent prompts, oldest first. */
export type Recent = readonly string[]

/** One subscription usage window, as a share used. */
export type Limit = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  percentUsed: number
}

/** What the pane's top lines show; each part null until it is known. */
export type Header = {
  /** The main loop's model, as `/model` shows it. */
  model: string | null
  /** The effort the main loop's last request asked for. */
  effort: string | null
  /** How full the context window is, as a whole percentage. */
  contextPercent: number | null
  /** The subscription usage windows; empty off a subscription. */
  limits: readonly Limit[]
}

/** The git state of the session's worktree; null outside a repository. */
export type Repo = {
  branch: string
  /** The session's directory. */
  worktree: string
  /** Files with changes not yet committed, untracked ones included. */
  changedFiles: number
  /** Commits on the branch not on its upstream; null when it has no upstream. */
  unpushedCommits: number | null
} | null

/** The branch's pull request; null when it has none or `gh` cannot say. */
export type PullRequest = {
  number: number
  url: string
  /** `draft`, `open`, `merged` or `closed`. */
  status: string
} | null

/** A subagent or teammate still at work. */
export type RunningAgent = { id: string; description: string; type: string }

declare module 'claude-code' {
  interface PluginState {
    awareness: {
      recent: Recent
      header: Header
      repo: Repo
      pullRequest: PullRequest
      agents: readonly RunningAgent[]
    }
  }
}
