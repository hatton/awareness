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
  /** The branch the pull request merges, such as `BL-16822-inline-3-model`. */
  head: string
  /** The branch it merges into; the first one's is the branch the whole stack goes into. */
  base: string
  /** `draft`, `open`, `merged` or `closed`. */
  status: string
} | null

/** The YouTrack card the branch names, with its summary and state once read; null until one is read. */
export type Card = {
  /** Such as `BL-15958`. */
  id: string
  summary: string
  /** The card's State field, such as `Ready For Code Review`; null when it has none. */
  state: string | null
} | null

/** One pull request in the stack the branch's pull request belongs to. */
export type StackEntry = {
  number: number
  url: string
  head: string
  /** The branch it merges into; the first one's is the branch the whole stack goes into. */
  base: string
  /** `draft`, `open`, `merged` or `closed`. */
  status: string
}

/**
 * The pull requests in the branch's pull request's stack, in the order they
 * merge, merged ones included; empty when it is in no stack.
 */
export type Stack = readonly StackEntry[]

/** A worktree on this machine that has a branch checked out. */
export type CheckedOut = {
  /** The worktree's top folder, written the Windows way on Windows. */
  path: string
  /** The branch's name on the remote, which is what a pull request names. */
  remoteBranch: string
  /** How the local branch stands against the remote one: `in sync`, `ahead`, `behind`, `diverged` or `not pushed`. */
  sync: string
  /**
   * What the agents Orca runs in the worktree are doing: `working` when any is,
   * else `waiting` when any waits on the person; null when none is, or Orca does
   * not manage the worktree.
   */
  agent: string | null
}

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
      stack: Stack
      card: Card
      workingOn: WorkingOn
      agents: readonly RunningAgent[]
      checkedOut: readonly CheckedOut[]
    }
  }
}
