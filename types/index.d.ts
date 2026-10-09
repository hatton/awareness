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
  /** The repository's default branch, such as `master`; null when `origin/HEAD` is not set. */
  defaultBranch: string | null
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
  /** The branch the pull request merges into, such as `master`. */
  base: string
  /** `draft`, `open`, `merged` or `closed`. */
  status: string
} | null

/** The YouTrack card the branch names, with its summary once read; null until one is read. */
export type Card = {
  /** Such as `BL-15958`. */
  id: string
  summary: string
} | null

/** One entry of the main conversation's task list, by its id. */
export type TrackedTask = {
  /** The present-continuous phrase shown beside the spinner, else the subject. */
  doing: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** What the "Working on:" line is made from. */
export type WorkingOn = {
  /** The skill last started, as the person or the model named it. */
  skill: string | null
  /** The `TaskCreate`/`TaskUpdate` task list, by task id. */
  tasks: Readonly<Record<string, TrackedTask>>
  /** The in-progress item of the last `TodoWrite` list, if any. */
  todo: string | null
}

/** A subagent or teammate still at work. */
export type RunningAgent = { id: string; description: string; type: string }

declare module 'claude-code' {
  interface PluginState {
    awareness: {
      recent: Recent
      header: Header
      repo: Repo
      pullRequest: PullRequest
      card: Card
      workingOn: WorkingOn
      agents: readonly RunningAgent[]
    }
  }
}
