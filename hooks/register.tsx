import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Header, PullRequest, Recent, Repo, RunningAgent } from '../types'

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

/** Collapses a prompt's whitespace so blank lines in it don't stretch the pane. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

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
    }
    return next(e)
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

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
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
    const newest = list.length - 1
    const percent = top.contextPercent
    const card = git === null ? undefined : /^BL-\d+/i.exec(git.branch)?.[0].toUpperCase()

    return (
      <Box flexDirection="column" gap={1}>
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
