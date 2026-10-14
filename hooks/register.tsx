import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, CheckedOut, Header, PullRequest, Recent, Repo, RunningAgent, Stack, StackEntry, WorkingOn } from '../types'

const SHOWN = 3
const PANE = 'awareness'
const TITLE = 'Awareness'
// Above this share of the context window, the figure turns red.
const CONTEXT_WARNING_PERCENT = 50
// Above this share of a usage window, the figure turns red.
const LIMIT_WARNING_PERCENT = 80
// How often git, agents and usage are read again, for changes made outside a turn.
const REFRESH_MS = 10_000
// The pull request is read over the network, so less often.
const PULL_REQUEST_REFRESH_MS = 60_000
const YOUTRACK_ISSUE_URL = 'https://issues.bloomlibrary.org/youtrack/issue/'
const YOUTRACK_API_URL = 'https://issues.bloomlibrary.org/youtrack/api/issues/'
// How many prompts pass before the task summary in an Orca tab's label is asked for again.
const TAB_SUMMARY_EVERY_TURNS = 5
const TAB_SUMMARY_PROMPT =
  'In two or three words, name the task this conversation is working on now, as a label for a terminal tab ' +
  '(for example "Contentful sponsors" or "Devin fixes"). Reply with only those words.'

// Oldest first, newest last; at most SHOWN entries.
const recent = atom({ plugin: 'awareness', key: 'recent' } as const, [] as Recent)
const header = atom({ plugin: 'awareness', key: 'header' } as const, {
  model: null,
  effort: null,
  contextPercent: null,
  limits: [],
} as Header)
const repo = atom({ plugin: 'awareness', key: 'repo' } as const, null as Repo)
const pullRequest = atom({ plugin: 'awareness', key: 'pullRequest' } as const, null as PullRequest)
const card = atom({ plugin: 'awareness', key: 'card' } as const, null as Card)
const stack = atom({ plugin: 'awareness', key: 'stack' } as const, [] as Stack)
const checkedOut = atom({ plugin: 'awareness', key: 'checkedOut' } as const, [] as readonly CheckedOut[])
// The branches a worktree is being made for, so their rows say so until it exists.
const creating = atom({ plugin: 'awareness', key: 'creating' } as const, [] as readonly string[])
const agents = atom({ plugin: 'awareness', key: 'agents' } as const, [] as readonly RunningAgent[])
const NOTHING_YET: WorkingOn = { skill: null, tasks: {}, todo: null }
const workingOn = atom({ plugin: 'awareness', key: 'workingOn' } as const, NOTHING_YET)

/** Collapses a prompt's whitespace so blank lines in it don't stretch the pane. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * Turns a skill's name into a title: `preflight` reads `Preflight`,
 * `youtrack-fix` `Youtrack fix`, and a plugin's `vercel:deploy` `Deploy`.
 */
export const skillTitle = (name: string) => {
  const words = (name.split(':').pop() ?? name).replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Lowers the first letter of a step phrase so it reads after a comma
 * (`Fixing Devin bugs` reads `fixing Devin bugs`), but leaves a word in
 * capitals alone (`CI`, `PR`).
 */
const lowerFirst = (phrase: string) =>
  /^[A-Z][a-z]/.test(phrase) ? phrase.charAt(0).toLowerCase() + phrase.slice(1) : phrase

/**
 * Builds the "Working on:" line: the skill, then the step in progress; null
 * when neither is known. The step is the in-progress task's phrase, else the
 * in-progress item of the last `TodoWrite` list.
 */
export const workingOnText = (state: WorkingOn) => {
  const task = Object.values(state.tasks).find(t => t.status === 'in_progress')
  const step = task?.doing ?? state.todo
  if (state.skill !== null && step !== null) {
    return `Working on: ${state.skill}, ${lowerFirst(step)}`
  }
  if (state.skill !== null) {
    return `Working on: ${state.skill}`
  }
  if (step !== null) {
    return `Working on: ${step}`
  }
  return null
}

/**
 * The skill a prompt starts, when it is a slash command: `/preflight thorough`
 * names `preflight`, as does the `<command-name>/preflight</command-name>`
 * form the prompt takes once Claude Code expands it.
 */
export const typedSkillName = (text: string) =>
  /<command-name>\/?([\w:.-]+)<\/command-name>/.exec(text)?.[1] ?? /^\/([\w:.-]+)/.exec(text.trim())?.[1]

/**
 * Turns a model id such as `claude-opus-5-5[1m]` into `Opus 5.5 (1M context)`.
 * Anything not spelled that way is shown as given.
 */
export const friendlyModelName = (model: string) => {
  const match = /^claude-([a-z]+)-(\d+(?:-\d{1,2})*)(?:-\d{8})?(\[1m\])?$/i.exec(model)
  if (!match) {
    return model
  }
  const [, family = '', version = '', isLongContext] = match
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.replace(/-/g, '.')}`
  return isLongContext ? `${name} (1M context)` : name
}

/** Names a usage window the way people say it. */
const limitLabel = (kind: string) => {
  switch (kind) {
    case 'five_hour':
      return '5-hour'
    case 'seven_day':
      return 'week'
    case 'spend_limit':
      return 'spend'
    default:
      return kind
  }
}

/**
 * Reads `git status --porcelain=v2 --branch` output into the repo's state.
 * A detached HEAD shows as `(detached)`.
 */
export const parseGitStatus = (stdout: string, worktree: string, defaultBranch: string | null): NonNullable<Repo> => {
  let branch = '(detached)'
  let unpushedCommits: number | null = null
  let changedFiles = 0
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const ahead = /\+(\d+)/.exec(line)
      unpushedCommits = ahead ? Number(ahead[1]) : 0
    } else if (line !== '' && !line.startsWith('#')) {
      changedFiles += 1
    }
  }
  return { branch, defaultBranch, worktree, changedFiles, unpushedCommits }
}

/** Turns a folder path such as `D:\work` into a `vscode://file/D:/work` URL that opens it in VS Code. */
export const vscodeUrl = (path: string) => `vscode://file/${path.replace(/\\/g, '/').replace(/^\/+/, '')}`

/**
 * Hands a folder or a URL to Windows Explorer: a folder opens in Explorer, a
 * URL in the app registered for its scheme. A terminal opens only some link
 * schemes itself, so the pane's folder links go this way instead.
 */
const openInExplorer = async ($: EngineInterface, target: string) => {
  await $.process.run(['explorer.exe', target], { timeoutMs: 10_000 })
}

/** Describes the uncommitted files for the pane. */
const uncommittedText = (count: number) => {
  if (count === 0) {
    return 'Nothing uncommitted'
  }
  return `${count} ${count === 1 ? 'file' : 'files'} uncommitted`
}

/** Describes the unpushed commits for the pane. */
const unpushedText = (count: number | null) => {
  if (count === null) {
    return 'Branch not pushed (no upstream)'
  }
  if (count === 0) {
    return 'Nothing unpushed'
  }
  return `${count} ${count === 1 ? 'commit' : 'commits'} not pushed`
}

/** Reads the model, the context window's fill and the usage windows into the header. */
const refreshHeader = async ($: EngineInterface) => {
  const [model, usage] = await Promise.all([$.session.model(), $.session.usage()])
  await update($, header, h => ({
    ...h,
    model: friendlyModelName(model),
    contextPercent: usage.context.percent ?? h.contextPercent,
    limits: usage.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed })),
  }))
}

/** Reads the thinking level from settings, for before the first request reports it. */
const readEffortSetting = async ($: EngineInterface) => {
  const { effortLevel } = await $.settings.read()
  if (effortLevel === undefined) {
    return
  }
  await update($, header, h => ({ ...h, effort: String(effortLevel) }))
}

/**
 * Reads `git rev-parse --abbrev-ref origin/HEAD` output, `origin/master`,
 * into the default branch's name, `master`.
 */
export const parseDefaultBranch = (stdout: string) => stdout.trim().replace(/^origin\//, '') || null

/**
 * Writes a drive path that git gives with forward slashes, `D:/work`, the
 * Windows way, `D:\work`, which Explorer needs; any other path as it is.
 */
export const windowsPath = (path: string) => (/^[A-Za-z]:\//.test(path) ? path.replace(/\//g, '\\') : path)

/** Reads the worktree's branch, the repository's default branch, uncommitted files and unpushed commits. */
const refreshRepo = async ($: EngineInterface) => {
  const [status, originHead, topLevel] = await Promise.all([
    $.process.run(['git', 'status', '--porcelain=v2', '--branch'], { timeoutMs: 10_000 }),
    $.process.run(['git', 'rev-parse', '--abbrev-ref', 'origin/HEAD'], { timeoutMs: 10_000 }),
    $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 }),
  ])
  // The session can move into a subfolder; the worktree is the repository's top folder.
  const worktree = topLevel.exitCode === 0 ? windowsPath(topLevel.stdout.trim()) : await $.session.cwd()
  const defaultBranch = originHead.exitCode === 0 ? parseDefaultBranch(originHead.stdout) : null
  const state: Repo = status.exitCode === 0 ? parseGitStatus(status.stdout, worktree, defaultBranch) : null
  await update($, repo, () => state)
}

/**
 * Turns a GitHub pull request URL such as
 * `https://github.com/BloomBooks/BloomDesktop/pull/8315` into its Reviewable
 * page, `https://reviewable.io/reviews/BloomBooks/BloomDesktop/8315`.
 */
export const reviewableUrl = (pullRequestUrl: string) =>
  pullRequestUrl.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+).*$/, 'https://reviewable.io/reviews/$1/$2/$3')

/**
 * Reads `gh pr view --json number,url,baseRefName,headRefName,state,isDraft` output into
 * the pull request's state: a draft reads `draft`, otherwise the state in lower case.
 */
export const parsePullRequest = (stdout: string): NonNullable<PullRequest> => {
  const pr = JSON.parse(stdout) as GhPullRequest
  return { number: pr.number, url: pr.url, base: pr.baseRefName, head: pr.headRefName, status: pullRequestStatus(pr) }
}

/** A pull request as `gh` gives it with the fields this module asks for. */
type GhPullRequest = {
  number: number
  url: string
  baseRefName: string
  headRefName: string
  state: string
  isDraft: boolean
}

/** A draft reads `draft`, otherwise the state in lower case. */
const pullRequestStatus = (pr: GhPullRequest) => (pr.isDraft && pr.state === 'OPEN' ? 'draft' : pr.state.toLowerCase())

/**
 * Finds the stack a branch's pull request is in, from `gh pr list --json
 * number,url,baseRefName,headRefName,state,isDraft` output of the open pull
 * requests: below it, the one whose branch it merges into, and that one's, and
 * so on; above it, the one that merges into its branch, while there is exactly
 * one. Returned in the order they merge; empty when nothing is chained to it.
 */
export const stackOf = (stdout: string, head: string): Stack => {
  const open = JSON.parse(stdout) as GhPullRequest[]
  const byHead = new Map(open.map(pr => [pr.headRefName, pr]))
  const current = byHead.get(head)
  if (current === undefined) {
    return []
  }
  const chain = [current]
  const seen = new Set([current.headRefName])
  for (let below = byHead.get(current.baseRefName); below && !seen.has(below.headRefName); below = byHead.get(below.baseRefName)) {
    chain.unshift(below)
    seen.add(below.headRefName)
  }
  for (let top = current; ; ) {
    const above = open.filter(pr => pr.baseRefName === top.headRefName)
    if (above.length !== 1 || seen.has(above[0]!.headRefName)) {
      break
    }
    top = above[0]!
    chain.push(top)
    seen.add(top.headRefName)
  }
  if (chain.length < 2) {
    return []
  }
  return chain.map((pr): StackEntry => ({ number: pr.number, url: pr.url, head: pr.headRefName, base: pr.baseRefName, status: pullRequestStatus(pr) }))
}

/**
 * Reads `git rev-parse --abbrev-ref @{upstream}` output, `origin/canvas-refit`,
 * into the branch's name on its remote, `canvas-refit`; null when it is empty.
 */
export const parseUpstreamBranch = (stdout: string) => stdout.trim().replace(/^[^/]+\//, '') || null

const pullRequestFields = ['--json', 'number,url,baseRefName,headRefName,state,isDraft']

/**
 * Reads the current branch's pull request through the GitHub CLI. `gh` finds it
 * by where the branch pushes, and when the local name differs from the remote one
 * (Orca names a second worktree of `canvas-refit` `canvas-refit-2`) git cannot say
 * where that is, so `gh` finds nothing. Then we ask again by the name of the
 * branch it tracks.
 */
const refreshPullRequest = async ($: EngineInterface) => {
  let { exitCode, stdout } = await $.process.run(['gh', 'pr', 'view', ...pullRequestFields], { timeoutMs: 20_000 })
  if (exitCode !== 0) {
    const upstream = await $.process.run(['git', 'rev-parse', '--abbrev-ref', '@{upstream}'], { timeoutMs: 10_000 })
    const remoteBranch = upstream.exitCode === 0 ? parseUpstreamBranch(upstream.stdout) : null
    if (remoteBranch !== null) {
      ;({ exitCode, stdout } = await $.process.run(['gh', 'pr', 'view', remoteBranch, ...pullRequestFields], {
        timeoutMs: 20_000,
      }))
    }
  }
  const state: PullRequest = exitCode === 0 ? parsePullRequest(stdout) : null
  await update($, pullRequest, () => state)
  await refreshStack($, state)
  await refreshCheckedOut($)
}

const STACK_QUERY =
  'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ' +
  'stack { entries(first: 100) { nodes { position pullRequest { number url headRefName baseRefName state isDraft } } } } } } }'

/**
 * Reads GitHub's answer to STACK_QUERY into the stack the pull request is in,
 * merged pull requests included, in the order they merge; null when GitHub
 * has it in no stack.
 */
export const parseGitHubStack = (stdout: string): Stack | null => {
  const answer = JSON.parse(stdout) as {
    data: { repository: { pullRequest: { stack: { entries: { nodes: { position: number; pullRequest: GhPullRequest }[] } } | null } } }
  }
  const found = answer.data.repository.pullRequest.stack
  if (found === null) {
    return null
  }
  return [...found.entries.nodes]
    .sort((a, b) => a.position - b.position)
    .map(({ pullRequest: pr }): StackEntry => ({ number: pr.number, url: pr.url, head: pr.headRefName, base: pr.baseRefName, status: pullRequestStatus(pr) }))
}

/**
 * Keeps the stack the branch's pull request is in. GitHub's own stack comes
 * first, since it remembers the pull requests already merged. A pull request
 * GitHub has in no stack may still be chained to others by their branches,
 * and those are found from the open pull requests.
 */
const refreshStack = async ($: EngineInterface, pr: PullRequest) => {
  if (pr === null) {
    await update($, stack, () => [])
    return
  }
  const repoMatch = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url)
  if (repoMatch) {
    const asked = await $.process.run(
      ['gh', 'api', 'graphql', '-f', `query=${STACK_QUERY}`, '-F', `owner=${repoMatch[1]}`, '-F', `repo=${repoMatch[2]}`, '-F', `number=${pr.number}`],
      { timeoutMs: 20_000 },
    )
    const fromGitHub = asked.exitCode === 0 ? parseGitHubStack(asked.stdout) : null
    if (fromGitHub !== null) {
      await update($, stack, () => fromGitHub)
      return
    }
  }
  if (pr.status !== 'open' && pr.status !== 'draft') {
    await update($, stack, () => [])
    return
  }
  const { exitCode, stdout } = await $.process.run(
    ['gh', 'pr', 'list', '--state', 'open', '--limit', '200', ...pullRequestFields],
    { timeoutMs: 20_000 },
  )
  if (exitCode !== 0) {
    return
  }
  const found = stackOf(stdout, pr.head)
  await update($, stack, () => found)
}

/**
 * What is wrong with keeping this worktree as it is, for the line under it:
 * its pull request is already merged or closed, so the folder can go, and its
 * folder is named for something other than its branch. Empty when neither.
 */
export const worktreeWarnings = (worktree: string, branch: string, pullRequestStatus: string | null) => {
  const warnings: string[] = []
  if (pullRequestStatus === 'merged' || pullRequestStatus === 'closed') {
    warnings.push(`PR ${pullRequestStatus}; this worktree can be removed`)
  }
  const folder = (worktree.split(/[\\/]/).pop() ?? '').toLowerCase()
  const name = branch.toLowerCase()
  if (branch !== '(detached)' && !folder.startsWith(name) && !name.startsWith(folder)) {
    warnings.push(`folder name is not the branch (${branch})`)
  }
  return warnings
}

/** The YouTrack card id a branch named the team's way starts with, such as `BL-15958`; null without one. */
export const cardId = (branch: string) => /^BL-\d+/i.exec(branch)?.[0].toUpperCase() ?? null

/**
 * Reads YouTrack's answer to `?fields=summary,customFields(name,value(name))`
 * into the card: its summary, and the name of its State field's value.
 */
export const parseCard = (id: string, text: string): NonNullable<Card> => {
  const issue = JSON.parse(text) as {
    summary: string
    customFields?: { name: string; value: { name?: string } | null }[]
  }
  const state = issue.customFields?.find(f => f.name === 'State')?.value?.name ?? null
  return { id, summary: issue.summary, state }
}

/**
 * Reads the summary and state of the card the branch names from YouTrack,
 * through the team's Bot token in `YOUTRACK_BOT`. It is read again on every
 * refresh, because the card's state moves while the work goes on.
 */
const refreshCard = async ($: EngineInterface) => {
  const git = await read($, repo)
  const id = git === null ? null : cardId(git.branch)
  if (id === null) {
    return
  }
  const token = await $.env.get('YOUTRACK_BOT')
  if (!token) {
    return
  }
  const response = await $.http.fetch(`${YOUTRACK_API_URL}${id}?fields=summary,customFields(name,value(name))`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!response.ok) {
    return
  }
  const latest = parseCard(id, response.text)
  await update($, card, () => latest)
}

/** Reads what lives on the network, the pull request and the card's summary. */
const refreshRemote = ($: EngineInterface) => Promise.allSettled([refreshPullRequest($), refreshCard($)])

/**
 * The words after the card id in a branch named the team's way:
 * `BL-15958-crop-marks` gives `crop marks`; a branch without a card id, none.
 */
export const cardWords = (branch: string) => {
  const words = /^[A-Za-z]+-\d+[-_](.+)$/.exec(branch)?.[1]?.replace(/[-_]+/g, ' ').trim()
  return words || null
}

/** Trims a model's reply to a tab label: one line, no quotes or closing period, at most four words. */
export const tidySummary = (text: string) =>
  text
    .split('\n')[0]!
    .replace(/["'`*.]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join(' ')

/**
 * The Orca tab's label: the summary of what the conversation is working on.
 * The worktree's card can be about something else entirely, so its words
 * stand in only until the first summary; null when there is neither.
 */
export const tabLabel = (words: string | null, task: string | null) => task ?? words

// What this module last asked Orca for, so an unchanged label is not sent again.
let lastLabel: string | null = null
let task: string | null = null
let taskAskedAtTurn = -Infinity

/**
 * Keeps the Orca terminal tab this session runs in labelled with what it is
 * about. Outside Orca there is no tab handle and it does nothing.
 */
const refreshTabLabel = async ($: EngineInterface) => {
  const handle = await $.env.get('ORCA_TERMINAL_HANDLE')
  if (!handle) {
    return
  }
  const branch = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 10_000 })
  const words = branch.exitCode === 0 ? cardWords(branch.stdout.trim()) : null
  const turns = await $.session.turns()
  if (turns > 0 && turns - taskAskedAtTurn >= TAB_SUMMARY_EVERY_TURNS) {
    const reply = await $.model.fork({ prompt: TAB_SUMMARY_PROMPT })
    if (reply.isAnswered && tidySummary(reply.text)) {
      task = tidySummary(reply.text)
      taskAskedAtTurn = turns
    }
  }
  const label = tabLabel(words, task)
  if (label === null || label === lastLabel) {
    return
  }
  const renamed = await $.process.run(['orca', 'terminal', 'rename', '--terminal', handle, '--title', label], {
    timeoutMs: 10_000,
  })
  if (renamed.exitCode === 0) {
    lastLabel = label
  }
}

/** Reads which subagents and teammates are still at work. */
const refreshAgents = async ($: EngineInterface) => {
  const list = await $.agent.list()
  const running = list
    .filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
    .map(a => ({ id: a.id, description: a.description, type: a.type }))
  await update($, agents, () => running)
}

/**
 * Applies a `TaskUpdate` to the tracked task list: a new status or phrase, or
 * the task's removal when it is deleted. An id the list never saw (one
 * created before the list was last cleared) is added only when the update
 * names what it does; otherwise the list is left as it was.
 */
export const updatedTasks = (
  tasks: WorkingOn['tasks'],
  change: { taskId: string; status?: string; activeForm?: string; subject?: string },
): WorkingOn['tasks'] => {
  if (change.status === 'deleted') {
    const { [change.taskId]: _removed, ...rest } = tasks
    return rest
  }
  const known = tasks[change.taskId]
  const named = change.activeForm ?? change.subject
  if (known === undefined && named === undefined) {
    return tasks
  }
  const before = known ?? { doing: named ?? '', status: 'pending' as const }
  const status =
    change.status === 'in_progress' || change.status === 'completed' || change.status === 'pending'
      ? change.status
      : before.status
  return {
    ...tasks,
    [change.taskId]: { doing: change.activeForm ?? change.subject ?? before.doing, status },
  }
}

/** Takes the activity from a prompt that runs a skill as a slash command. */
const noteTypedSkill = async ($: EngineInterface, text: string) => {
  const name = typedSkillName(text)
  if (name === undefined) {
    return
  }
  const command = (await $.command.list()).find(c => c.name === name)
  // Built-in commands (/clear, /model) and this mod's own name no activity.
  if (command === undefined || command.source === 'builtin' || command.plugin === 'awareness') {
    return
  }
  await update($, workingOn, w => ({ ...w, skill: skillTitle(name) }))
}

/** Reads everything the pane shows that can change outside a turn. */
/**
 * Reads `git worktree list --porcelain` output into each worktree's folder and
 * the local branch it has checked out; a detached worktree is left out.
 */
export const parseWorktrees = (stdout: string) => {
  const found: { path: string; branch: string }[] = []
  let path: string | null = null
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch refs/heads/') && path !== null) {
      found.push({ path: windowsPath(path), branch: line.slice('branch refs/heads/'.length).trim() })
    }
  }
  return found
}

/**
 * Reads `git for-each-ref --format=%(refname:short)%09%(upstream:short)%09%(upstream:track) refs/heads`
 * output into each local branch's upstream (the name on the remote, without the remote) and
 * how it stands against it; a branch with no upstream is left out.
 */
export const parseTracking = (stdout: string) => {
  const found = new Map<string, { remoteBranch: string; sync: string }>()
  for (const line of stdout.split(/\r?\n/)) {
    const [branch, upstream, track = ''] = line.split('\t')
    if (!branch || !upstream) {
      continue
    }
    found.set(branch, { remoteBranch: upstream.replace(/^[^/]+\//, ''), sync: syncFromCounts(track) })
  }
  return found
}

/** Turns git's `[ahead 3, behind 5]`, or the same counts written `ahead 3 behind 5`, into one word. */
const syncFromCounts = (track: string) => {
  if (track.includes('gone')) {
    return 'not pushed'
  }
  const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
  if (ahead > 0 && behind > 0) {
    return 'diverged'
  }
  if (ahead > 0) {
    return 'ahead'
  }
  if (behind > 0) {
    return 'behind'
  }
  return 'in sync'
}

/**
 * Finds which worktree on this machine has each of the stack's branches
 * checked out, and how that branch stands against the remote. A branch with
 * no upstream is compared with the remote branch of the same name.
 */
/**
 * Reads `orca worktree ps --json` output into what the agents in each Orca
 * worktree are doing, by the worktree's folder in lower case, written the
 * Windows way: `working` when any agent is, else `waiting` when any waits on
 * the person. A worktree whose agents are all done is left out.
 */
export const parseOrcaAgents = (stdout: string) => {
  const answer = JSON.parse(stdout) as { result?: { worktrees?: { path: string; agents?: { state: string }[] }[] } }
  const found = new Map<string, string>()
  for (const w of answer.result?.worktrees ?? []) {
    const states = (w.agents ?? []).map(a => a.state)
    const agent = states.includes('working') ? 'working' : states.find(s => s !== 'done' && s !== 'working') ? 'waiting' : null
    if (agent !== null) {
      found.set(windowsPath(w.path).toLowerCase(), agent)
    }
  }
  return found
}

/** Asks Orca what its agents are doing; empty when Orca is not running or not installed. */
const readOrcaAgents = async ($: EngineInterface) => {
  const ps = await $.process.run(['orca', 'worktree', 'ps', '--json', '--limit', '500'], { timeoutMs: 10_000 }).catch(() => null)
  if (ps === null || ps.exitCode !== 0) {
    return new Map<string, string>()
  }
  try {
    return parseOrcaAgents(ps.stdout)
  } catch {
    return new Map<string, string>()
  }
}

const refreshCheckedOut = async ($: EngineInterface) => {
  const heads = new Set((await read($, stack)).map(s => s.head))
  if (heads.size === 0) {
    await update($, checkedOut, () => [])
    return
  }
  const [list, refs, agentsByPath] = await Promise.all([
    $.process.run(['git', 'worktree', 'list', '--porcelain'], { timeoutMs: 10_000 }),
    $.process.run(
      ['git', 'for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)', 'refs/heads'],
      { timeoutMs: 10_000 },
    ),
    readOrcaAgents($),
  ])
  if (list.exitCode !== 0 || refs.exitCode !== 0) {
    return
  }
  const tracking = parseTracking(refs.stdout)
  const found: CheckedOut[] = []
  for (const { path, branch } of parseWorktrees(list.stdout)) {
    const tracked = tracking.get(branch)
    const remoteBranch = tracked?.remoteBranch ?? branch
    if (!heads.has(remoteBranch)) {
      continue
    }
    let sync = tracked?.sync
    if (sync === undefined) {
      const counts = await $.process.run(
        ['git', 'rev-list', '--left-right', '--count', `refs/heads/${branch}...refs/remotes/origin/${branch}`],
        { timeoutMs: 10_000 },
      )
      const [ahead = '0', behind = '0'] = counts.stdout.trim().split(/\s+/)
      sync = counts.exitCode === 0 ? syncFromCounts(`ahead ${ahead} behind ${behind}`) : 'not pushed'
    }
    found.push({ path, remoteBranch, sync, agent: agentsByPath.get(path.toLowerCase()) ?? null })
  }
  await update($, checkedOut, () => found)
}

/**
 * Reads `orca terminal list --worktree <selector> --json` output into the
 * handle of the terminal to show for that worktree: the first one an agent
 * runs in, else the first one; null when the worktree has none.
 */
export const parseOrcaTerminal = (stdout: string) => {
  const answer = JSON.parse(stdout) as { result?: { terminals?: { handle: string; agentIdentity?: string | null }[] } }
  const terminals = answer.result?.terminals ?? []
  return (terminals.find(t => t.agentIdentity) ?? terminals[0])?.handle ?? null
}

/**
 * Names a folder beside the worktree's top folder: `D:\BL16822-1` with
 * `BL-1-part-4` gives `D:\BL-1-part-4`. That is where Orca puts the
 * worktrees it makes.
 */
export const siblingFolder = (worktree: string, name: string) => worktree.replace(/[^\\/]+[\\/]*$/, '') + name

/**
 * Brings Orca's window to a worktree, on the tab of the agent working there
 * if there is one; a worktree with no terminal gets a new one.
 */
const goToWorktree = async ($: EngineInterface, path: string) => {
  const selector = `path:${path.replace(/\\/g, '/')}`
  const list = await $.process.run(['orca', 'terminal', 'list', '--worktree', selector, '--json'], { timeoutMs: 10_000 })
  const handle = list.exitCode === 0 ? parseOrcaTerminal(list.stdout) : null
  const shown =
    handle === null
      ? await $.process.run(['orca', 'terminal', 'create', '--worktree', selector, '--focus', '--json'], { timeoutMs: 20_000 })
      : await $.process.run(['orca', 'terminal', 'switch', '--terminal', handle, '--json'], { timeoutMs: 10_000 })
  if (shown.exitCode !== 0) {
    $.ui.toast(`Orca could not show ${path}: ${(shown.stderr || shown.stdout).trim()}`)
  }
}

/**
 * Checks a stacked pull request's branch out in a new worktree beside this
 * one, named after the branch, then brings Orca to it. `git worktree add`
 * checks out the branch itself, tracking the remote one; `orca worktree
 * create` would make a new branch with a number on the end instead.
 */
const createWorktree = async ($: EngineInterface, worktree: string, branch: string) => {
  await update($, creating, list => [...list, branch])
  try {
    await $.process.run(['git', 'fetch', 'origin', branch], { timeoutMs: 120_000 })
    let path = siblingFolder(worktree, branch)
    for (let n = 2; await $.fs.exists(path); n += 1) {
      path = siblingFolder(worktree, `${branch}-${n}`)
    }
    const added = await $.process.run(['git', 'worktree', 'add', path, branch], { timeoutMs: 600_000 })
    if (added.exitCode !== 0) {
      $.ui.toast(`Could not make a worktree for ${branch}: ${added.stderr.trim()}`)
      return
    }
    await refreshCheckedOut($)
    await goToWorktree($, path)
  } finally {
    await update($, creating, list => list.filter(b => b !== branch))
  }
}

const refreshAll = async ($: EngineInterface) => {
  await Promise.allSettled([refreshHeader($), refreshRepo($), refreshAgents($), refreshCheckedOut($)])
}

export const register: Register = (on, options) => {
  const labelOrcaTab = options.labelOrcaTab !== false

  // Claude Code docks the pane beside the transcript in the fullscreen layout
  // from 110 columns; elsewhere it seats it above the prompt.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'awareness',
      description: 'Show the Awareness pane: model, git state, usage, agents and your last three prompts',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    await Promise.allSettled([refreshAll($), readEffortSetting($)])
    void refreshRemote($)
    if (labelOrcaTab) {
      void refreshTabLabel($).catch(() => undefined)
    }
    $.clock.every(REFRESH_MS, () => refreshAll($))
    $.clock.every(PULL_REQUEST_REFRESH_MS, () => refreshRemote($))

    return next(e)
  })

  // /clear starts the conversation over, so the activity starts over too.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      await update($, workingOn, () => NOTHING_YET).catch(() => undefined)
    }
    return next(e)
  })

  // A slash command typed at the prompt; noteTypedSkill skips built-ins.
  on('command.run', async ($, e, next) => {
    if (e.command !== 'awareness') {
      await noteTypedSkill($, `/${e.command}`).catch(() => undefined)
    }
    return next(e)
  })

  on('command.run', { command: 'awareness' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Awareness pane opened.' }
  })

  // Records only what the person typed (here or through Remote Control), not
  // prompts raised by plugins, schedules, task notifications or other agents.
  on('prompt.submit', async ($, e, next) => {
    const text = oneLine(e.text)
    if ((e.origin.kind === 'composer' || e.origin.kind === 'bridge') && text) {
      // A failed write must not hold up the prompt.
      await update($, recent, list => [...list, text].slice(-SHOWN)).catch(() => undefined)
      await noteTypedSkill($, e.text).catch(() => undefined)
    }
    return next(e)
  })

  // The model starting a skill names the activity.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.deny === undefined && result.isError !== true) {
      await update($, workingOn, w => ({ ...w, skill: skillTitle(e.skill) })).catch(() => undefined)
    }
    return result
  })

  // The main conversation's task list names the step in progress.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.deny === undefined && result.isError !== true) {
      const doing = e.activeForm ?? e.subject
      await update($, workingOn, w => ({
        ...w,
        tasks: { ...w.tasks, [result.result.task.id]: { doing, status: 'pending' as const } },
      })).catch(() => undefined)
    }
    return result
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.deny === undefined && result.isError !== true) {
      await update($, workingOn, w => ({ ...w, tasks: updatedTasks(w.tasks, e) })).catch(() => undefined)
    }
    return result
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.deny === undefined && result.isError !== true) {
      const todo = e.todos.find(t => t.status === 'in_progress')?.activeForm ?? null
      await update($, workingOn, w => ({ ...w, todo })).catch(() => undefined)
    }
    return result
  })

  // Each main-loop request carries the effort it asks for, and its response
  // moves the context window's fill.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e)
    }
    const effort = e.effort === undefined ? null : String(e.effort)
    await update($, header, h => ({ ...h, effort })).catch(() => undefined)
    const response = yield* next(e)
    await refreshHeader($).catch(() => undefined)

    return response
  })

  // A tool call can commit, push, edit a file or start an agent.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    void Promise.allSettled([refreshRepo($), refreshAgents($)])
    return result
  })

  // The main conversation's turn ending leaves Claude idle, so nothing is being worked on.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, workingOn, () => NOTHING_YET).catch(() => undefined)
    }
    void refreshAll($)
    void refreshRemote($)
    if (labelOrcaTab && e.agentId === undefined) {
      void refreshTabLabel($).catch(() => undefined)
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text, Link } = $.ui.resolve(e)
    const list = await read($, recent)
    const top = await read($, header)
    const git = await read($, repo)
    const pr = await read($, pullRequest)
    const chain = await read($, stack)
    const worktrees = await read($, checkedOut)
    const beingMade = await read($, creating)
    const working = await read($, agents)
    const activity = workingOnText(await read($, workingOn))
    const newest = list.length - 1
    const percent = top.contextPercent
    const id = git === null ? null : cardId(git.branch)
    const known = await read($, card)
    const shown = known !== null && known.id === id ? known : null
    // A pull request names the branch it merges into; without one, the repository's default branch stands in.
    const parent = pr?.base ?? git?.defaultBranch ?? null

    return (
      <Box flexDirection="column" gap={1} paddingLeft={2} minHeight={e.props.placement === 'dock' ? e.props.scroll.bodyRows : undefined}>
        {git !== null && (
          <Box flexDirection="column">
            {id !== null && (
              <Box flexDirection="row" gap={1} marginBottom={1}>
                {/* Only the summary gives way to a narrow pane; the label and the id keep their width. */}
                <Box flexShrink={0}>
                  <Text>Issue:</Text>
                </Box>
                <Box flexShrink={0}>
                  <Link href={`${YOUTRACK_ISSUE_URL}${id}`}>
                    <Text underline>
                      {id}
                    </Text>
                  </Link>
                </Box>
                {/* A long summary gives way so the state after it stays in view. */}
                {shown !== null && (
                  <Box flexShrink={1}>
                    <Text wrap="truncate-end">
                      {shown.summary}
                    </Text>
                  </Box>
                )}
                {shown?.state != null && (
                  <Box flexShrink={0}>
                    <Text>({shown.state})</Text>
                  </Box>
                )}
              </Box>
            )}
            <Box flexDirection="row" gap={1}>
              {/* Only the path gives way to a narrow pane; the label and VSCode keep their width. */}
              <Box flexShrink={0}>
                <Text dimColor>Worktree:</Text>
              </Box>
              <Box flexShrink={1}>
                <Button key="open-folder" plain dimColor onPress={() => openInExplorer($, git.worktree)}>
                  <Text underline wrap="truncate-middle">
                    {git.worktree}
                  </Text>
                </Button>
              </Box>
              <Box flexShrink={0}>
                <Button key="open-vscode" plain dimColor onPress={() => openInExplorer($, vscodeUrl(git.worktree))}>
                  <Text underline>VSCode</Text>
                </Button>
              </Box>
            </Box>
            {worktreeWarnings(git.worktree, git.branch, pr?.status ?? null).map(w => (
              <Text key={w} color="warning" wrap="truncate-end">
                {w}
              </Text>
            ))}
            <Text bold dimColor wrap="truncate-end">
              Branch: {git.branch}
              {parent === null ? '' : `  Parent: ${parent}`}
            </Text>
            <Box flexDirection="column" paddingLeft={2}>
              <Text color={git.changedFiles > 0 ? 'warning' : undefined} dimColor={git.changedFiles === 0}>
                {uncommittedText(git.changedFiles)}
              </Text>
              <Text
                color={git.unpushedCommits !== 0 ? 'warning' : undefined}
                dimColor={git.unpushedCommits === 0}
              >
                {unpushedText(git.unpushedCommits)}
              </Text>
            </Box>
            {/* A stack lists the branch's pull request among the others, so the PR line is left out. */}
            {pr === null && (
              <Box marginTop={1}>
                <Text>PR: None</Text>
              </Box>
            )}
            {pr !== null && chain.length === 0 && (
              <Box flexDirection="row" gap={4} marginTop={1}>
                <Box flexDirection="row" gap={1}>
                  <Link href={pr.url}>
                    <Text underline>
                      PR #{pr.number}
                    </Text>
                  </Link>
                  <Text>
                    into {pr.base} ({pr.status})
                  </Text>
                </Box>
                <Link href={reviewableUrl(pr.url)}>
                  <Text underline>
                    Reviewable
                  </Text>
                </Link>
              </Box>
            )}
            {chain.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text>PR Stack into {chain[0]!.base}</Text>
                {chain.map((s, i) => (
                  <Box key={`s${s.number}`} flexDirection="row" gap={1} paddingLeft={2}>
                    <Text bold={s.number === pr?.number} color={s.number === pr?.number ? 'suggestion' : undefined}>
                      {i + 1}.
                    </Text>
                    <Link href={s.url}>
                      <Text underline bold={s.number === pr?.number} color={s.number === pr?.number ? 'suggestion' : undefined}>
                        #{s.number}
                      </Text>
                    </Link>
                    <Box flexShrink={1}>
                      <Text
                        wrap="truncate-end"
                        bold={s.number === pr?.number}
                        color={s.number === pr?.number ? 'suggestion' : undefined}
                      >
                        {cardWords(s.head) ?? s.head}
                      </Text>
                    </Box>
                    {/* The status opens the pull request's Reviewable page. */}
                    <Box flexShrink={0}>
                      <Link href={reviewableUrl(s.url)}>
                        {/* A draft stands out in the same color as the current pull request. */}
                        <Text
                          underline
                          bold={s.number === pr?.number}
                          color={s.number === pr?.number || s.status === 'draft' ? 'suggestion' : undefined}
                        >
                          ({s.status})
                        </Text>
                      </Link>
                    </Box>
                    {/*
                      Where this machine has the branch checked out, and whether it matches the remote.
                      "worktree" brings Orca to it; when the branch has several, each is named by its folder.
                    */}
                    {worktrees
                      .filter(w => w.remoteBranch === s.head)
                      .map((w, _, here) => (
                        <Box key={`w${w.path}`} flexShrink={0} flexDirection="row" gap={1}>
                          {w.path === git.worktree ? (
                            <Text bold color="suggestion">
                              {'<-- you are here'}
                            </Text>
                          ) : (
                            <Button key={`go${w.path}`} plain onPress={() => goToWorktree($, w.path)}>
                              <Text underline>{here.length > 1 ? (w.path.split(/[\\/]/).pop() ?? w.path) : 'worktree'}</Text>
                            </Button>
                          )}
                          {w.sync !== 'in sync' && <Text color="warning">{w.sync}</Text>}
                          {w.agent !== null && (
                            <Text color={w.agent === 'working' ? 'suggestion' : 'warning'}>
                              {w.agent === 'working' ? 'agent working' : 'agent waiting'}
                            </Text>
                          )}
                        </Box>
                      ))}
                    {/* An open pull request not checked out here can be, beside this worktree. */}
                    {(s.status === 'open' || s.status === 'draft') &&
                      !worktrees.some(w => w.remoteBranch === s.head) &&
                      (beingMade.includes(s.head) ? (
                        <Box flexShrink={0}>
                          <Text dimColor>making worktree…</Text>
                        </Box>
                      ) : (
                        <Box flexShrink={0}>
                          <Button key={`make${s.head}`} plain dimColor onPress={() => createWorktree($, git.worktree, s.head)}>
                            <Text underline>create worktree</Text>
                          </Button>
                        </Box>
                      ))}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}

        {working.length > 0 && (
          <Box flexDirection="column">
            <Text bold dimColor>
              Running Agents
            </Text>
            {working.map(a => (
              <Box key={a.id} paddingLeft={2}>
                <Text dimColor wrap="truncate-end">
                  {a.description} ({a.type})
                </Text>
              </Box>
            ))}
          </Box>
        )}

        {activity !== null && (
          <Text color="suggestion" wrap="truncate-end">
            {activity}
          </Text>
        )}

        {/* Docked, the pane is as tall as its column, and this pushes the prompts and the session's figures to the bottom. */}
        <Box flexGrow={1} />

        <Box flexDirection="column" gap={1}>
          <Text bold dimColor>
            Recent Prompts
          </Text>
          {list.length === 0 && <Text dimColor>No prompts yet.</Text>}
          {list.map((text, i) => (
            <Box key={`p${i}`} paddingLeft={2}>
              {i === newest ? (
                <Text bold color="suggestion" wrap="truncate-end">
                  {text}
                </Text>
              ) : (
                <Text dimColor wrap="truncate-end">
                  {text}
                </Text>
              )}
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text dimColor>
              {top.model ?? '…'}
              {top.effort === null ? '' : ` (${top.effort})`} | context:{' '}
            </Text>
            <Text
              color={percent !== null && percent > CONTEXT_WARNING_PERCENT ? 'error' : undefined}
              dimColor={percent === null || percent <= CONTEXT_WARNING_PERCENT}
            >
              {percent === null ? '…' : `${percent}%`}
            </Text>
          </Text>
          {top.limits.length > 0 && (
            <Text wrap="truncate-end">
              <Text dimColor>usage: </Text>
              {top.limits.map((l, i) => (
                <Text
                  key={l.kind}
                  color={l.percentUsed > LIMIT_WARNING_PERCENT ? 'error' : undefined}
                  dimColor={l.percentUsed <= LIMIT_WARNING_PERCENT}
                >
                  {i > 0 ? ' · ' : ''}
                  {limitLabel(l.kind)} {Math.round(l.percentUsed)}%
                </Text>
              ))}
            </Text>
          )}
        </Box>
        <Box justifyContent="flex-end">
          <Text bold dimColor>
            Awareness Mod
          </Text>
        </Box>
      </Box>
    )
  })
}
