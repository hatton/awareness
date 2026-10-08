import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Header, PullRequest, Recent, Repo, RunningAgent, WorkingOn } from '../types'

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
export const parseGitStatus = (stdout: string, worktree: string): NonNullable<Repo> => {
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
  return { branch, worktree, changedFiles, unpushedCommits }
}

/** Turns a folder path such as `D:\work` into a `file:///D:/work` URL that opens it. */
export const folderUrl = (path: string) => `file:///${path.replace(/\\/g, '/').replace(/^\/+/, '')}`

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

/** Reads the worktree's branch, uncommitted files and unpushed commits. */
const refreshRepo = async ($: EngineInterface) => {
  const worktree = await $.session.cwd()
  const { exitCode, stdout } = await $.process.run(['git', 'status', '--porcelain=v2', '--branch'], {
    timeoutMs: 10_000,
  })
  const state: Repo = exitCode === 0 ? parseGitStatus(stdout, worktree) : null
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
 * Reads `gh pr view --json number,url,state,isDraft` output into the pull
 * request's state: a draft reads `draft`, otherwise the state in lower case.
 */
export const parsePullRequest = (stdout: string): NonNullable<PullRequest> => {
  const pr = JSON.parse(stdout) as { number: number; url: string; state: string; isDraft: boolean }
  const status = pr.isDraft && pr.state === 'OPEN' ? 'draft' : pr.state.toLowerCase()
  return { number: pr.number, url: pr.url, status }
}

/** Reads the current branch's pull request through the GitHub CLI. */
const refreshPullRequest = async ($: EngineInterface) => {
  const { exitCode, stdout } = await $.process.run(
    ['gh', 'pr', 'view', '--json', 'number,url,state,isDraft'],
    { timeoutMs: 20_000 },
  )
  const state: PullRequest = exitCode === 0 ? parsePullRequest(stdout) : null
  await update($, pullRequest, () => state)
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
const refreshAll = async ($: EngineInterface) => {
  await Promise.allSettled([refreshHeader($), refreshRepo($), refreshAgents($)])
}

export const register: Register = on => {
  // Claude Code docks the pane beside the transcript in the fullscreen layout
  // from 110 columns; elsewhere it seats it above the prompt.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'awareness',
      description: 'Show the Awareness pane: model, git state, usage, agents and your last three prompts',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    await Promise.allSettled([refreshAll($), readEffortSetting($)])
    void refreshPullRequest($).catch(() => undefined)
    $.clock.every(REFRESH_MS, () => refreshAll($))
    $.clock.every(PULL_REQUEST_REFRESH_MS, () => refreshPullRequest($).catch(() => undefined))

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
    void refreshPullRequest($).catch(() => undefined)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const list = await read($, recent)
    const top = await read($, header)
    const git = await read($, repo)
    const pr = await read($, pullRequest)
    const working = await read($, agents)
    const activity = workingOnText(await read($, workingOn))
    const newest = list.length - 1
    const percent = top.contextPercent
    const card = git === null ? undefined : /^BL-\d+/i.exec(git.branch)?.[0].toUpperCase()

    return (
      <Box flexDirection="column" gap={1} paddingLeft={2}>
        <Text bold dimColor>
          Awareness Mod
        </Text>
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

        {git !== null && (
          <Box flexDirection="column">
            <Text bold dimColor wrap="truncate-end">
              Workspace: {git.branch}
            </Text>
            <Link href={folderUrl(git.worktree)}>
              <Text dimColor underline wrap="truncate-middle">
                {git.worktree}
              </Text>
            </Link>
            {(card !== undefined || pr !== null) && (
              <Box flexDirection="row" gap={2}>
                {card !== undefined && (
                  <Link href={`${YOUTRACK_ISSUE_URL}${card}`}>
                    <Text dimColor underline>
                      {card}
                    </Text>
                  </Link>
                )}
                {pr !== null && (
                  <Box flexDirection="row" gap={1}>
                    <Link href={pr.url}>
                      <Text dimColor underline>
                        PR #{pr.number}
                      </Text>
                    </Link>
                    <Link href={reviewableUrl(pr.url)}>
                      <Text dimColor underline>
                        Reviewable
                      </Text>
                    </Link>
                    <Text dimColor>({pr.status})</Text>
                  </Box>
                )}
              </Box>
            )}
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

        <Box flexDirection="column" gap={1}>
          <Text bold dimColor>
            Recent Prompts
          </Text>
          {list.length === 0 && <Text dimColor>No prompts yet.</Text>}
          {list.map((text, i) => (
            <Box key={`p${i}`} paddingLeft={2}>
              {i === newest ? (
                <Text bold color="suggestion">
                  {text}
                </Text>
              ) : (
                <Text dimColor>{text}</Text>
              )}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
