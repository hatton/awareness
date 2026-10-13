import type { On, RenderElement, SiteScroll } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { cardId, cardWords, parseCard, parseGitHubStack, parseOrcaAgents, worktreeWarnings, parseTracking, parseWorktrees, stackOf, friendlyModelName, parseDefaultBranch, parseGitStatus, parsePullRequest, parseUpstreamBranch, reviewableUrl, skillTitle, tabLabel, tidySummary, typedSkillName, updatedTasks, vscodeUrl, windowsPath, workingOnText } from '../hooks/register'

/** Stands in for the engine beneath the plugin: prompts pass, the pane body is empty. */
const answerBottoms = (on: On) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine' }) as RenderElement
  })
}

const SCROLL: SiteScroll = { offset: 0, bodyRows: 30 }

const PANE = {
  component: 'Pane',
  requestId: 'awareness',
  props: {
    title: 'Awareness',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: SCROLL,
    view: {},
  },
} as const

test('turns model ids into the names people know', () => {
  expect(friendlyModelName('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M context)')
  expect(friendlyModelName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
  expect(friendlyModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(friendlyModelName('some-other-model')).toBe('some-other-model')
})

test('shows the last three typed prompts, newest highlighted', async ($, on) => {
  answerBottoms(on)
  for (const text of ['first', 'second\nline two', 'third', 'fourth']) {
    await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: true })
  }
  // A prompt not typed by the person must not appear.
  await $.prompt.submit({ text: 'from a plugin', origin: { kind: 'plugin', name: 'other' }, wait: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'awareness', surface, ...PANE })
    const texts = await ui.findAll({ type: 'Text' })
    const heading = texts.findIndex(t => t.text === 'Recent Prompts')
    const rows = texts.slice(heading + 1, heading + 4)
    expect(rows.map(r => r.text)).toEqual(['second line two', 'third', 'fourth'])
    expect(rows[2]?.props.bold).toBe(true)
    expect(rows[0]?.props.dimColor).toBe(true)
    expect(rows[1]?.props.dimColor).toBe(true)
    // Each prompt takes one line, cut short with an ellipsis when it is long.
    expect(rows.map(r => r.props.wrap)).toEqual(['truncate-end', 'truncate-end', 'truncate-end'])
    await ui.unmount()
  }
})

test('says there are no prompts before the first one', async ($, on) => {
  answerBottoms(on)
  const ui = await $.ui.mount({ plugin: 'awareness', surface: 'terminal', ...PANE })
  // The title is the pane's last line.
  expect((await ui.findAll({ type: 'Text' })).at(-1)?.text).toBe('Awareness Mod')
  expect(await ui.find({ type: 'Text', text: 'Recent Prompts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No prompts yet.' })).toBeDefined()
  await ui.unmount()
})

for (const [percent, isRed] of [
  [13, false],
  [51, true],
] as const) {
  test(`shows model, effort and context, red only above 50% (${percent}%)`, async ($, on) => {
    answerBottoms(on)
    on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
    on('session.usage', () => ({ value: {
      startedAt: 0,
      context: { tokens: percent * 10_000, window: 1_000_000, percent },
      rateLimits: [],
      cost: { totalUsd: 0 },
    } }) as never)
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
    })
    const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5[1m]', effort: 'medium', messageCount: 1 })
    // A stream runs only as it is read.
    for await (const _chunk of step) {
    }

    const ui = await $.ui.mount({ plugin: 'awareness', surface: 'terminal', ...PANE })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.find(t => t.text.startsWith('Opus'))?.text).toBe(`Opus 5.5 (1M context) (medium) | context: ${percent}%`)
    const ctx = texts.find(t => t.text === `${percent}%`)
    expect(ctx?.text).toBe(`${percent}%`)
    expect(ctx?.props.color).toBe(isRed ? 'error' : undefined)
    await ui.unmount()
  })
}

test('takes the thinking level from settings before the first request', async ($, on) => {
  answerBottoms(on)
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { totalUsd: 0 } } }) as never)
  on('settings.read', () => ({ value: { effortLevel: 'high' } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('session.start', ($, e) => e as never)
  await $.session.start({ source: 'startup', cwd: 'C:/work' } as never)

  const ui = await $.ui.mount({ plugin: 'awareness', surface: 'terminal', ...PANE })
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.find(t => t.text.startsWith('Opus'))?.text).toBe('Opus 5.5 (1M context) (high) | context: …')
  await ui.unmount()
})

test('reads branch, uncommitted files and unpushed commits from git status', () => {
  const ahead = ['# branch.oid abc', '# branch.head BL-16818-tables', '# branch.upstream origin/BL-16818-tables', '# branch.ab +2 -0', '1 .M N... 100644 100644 100644 a b src/x.ts', '? notes.txt', ''].join('\r\n')
  expect(parseGitStatus(ahead, 'D:/w', 'master')).toEqual({ branch: 'BL-16818-tables', defaultBranch: 'master', worktree: 'D:/w', changedFiles: 2, unpushedCommits: 2 })
  const noUpstream = ['# branch.oid abc', '# branch.head new-branch', ''].join('\n')
  expect(parseGitStatus(noUpstream, 'D:/w', null)).toEqual({ branch: 'new-branch', defaultBranch: null, worktree: 'D:/w', changedFiles: 0, unpushedCommits: null })
})

test('reads the default branch from origin/HEAD', () => {
  expect(parseDefaultBranch('origin/master\n')).toBe('master')
  expect(parseDefaultBranch('')).toBe(null)
})

test('takes the card id from the start of the branch name', () => {
  expect(cardId('bl-16818-tables')).toBe('BL-16818')
  expect(cardId('new-branch')).toBe(null)
})

test('shows git state, card link, usage and running agents after a refresh', async ($, on) => {
  answerBottoms(on)
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, percent: 10 }, rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }, { kind: 'seven_day', percentUsed: 85 }], cost: { totalUsd: 0 } } }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  // The session has moved into a subfolder; the pane still shows the worktree's top folder.
  on('session.cwd', () => ({ value: 'D:/BL-16818-tables/src/deep' }) as never)
  mock.env(on, { YOUTRACK_BOT: 'perm-test' })
  on('http.fetch', ($, e) => {
    expect((e as unknown as { url: string }).url).toBe('https://issues.bloomlibrary.org/youtrack/api/issues/BL-16818?fields=summary,customFields(name,value(name))')
    const text = JSON.stringify({ summary: 'Fix all the tables', customFields: [{ name: 'Type', value: { name: 'Bug' } }, { name: 'State', value: { name: 'Ready for Review' } }] })
    return { value: { status: 200, ok: true, headers: {}, text } } as never
  })
  const runs: string[][] = []
  on('process.run', ($, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    runs.push(argv)
    let stdout = '# branch.head BL-16818-tables\n# branch.ab +1 -0\n? a.txt\n'
    if (argv[0] === 'gh') {
      stdout = JSON.stringify({ number: 8315, url: 'https://github.com/BloomBooks/BloomDesktop/pull/8315', baseRefName: 'Version6.5', state: 'OPEN', isDraft: true })
    } else if (argv[2] === '--show-toplevel') {
      stdout = 'D:/BL-16818-tables\n'
    } else if (argv[1] === 'rev-parse') {
      stdout = 'origin/master\n'
    }
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  const clock = mock.clock(on)
  on('agent.list', () => ({ value: [
    { id: 'a1', description: 'Search the tests', type: 'Explore', status: 'running' },
    { id: 'a2', description: 'Old work', type: 'general-purpose', status: 'completed' },
  ] }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('session.start', ($, e) => e as never)
  await $.session.start({ source: 'startup', cwd: 'D:/BL-16818-tables' } as never)
  // The pull request and the card's summary are read unawaited.
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'awareness', surface: 'terminal', ...PANE })
  const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(shown).toContain('usage: 5-hour 24% · week 85%')
  // The pull request's base outranks the repository's default branch.
  expect(shown).toContain('Branch: BL-16818-tables  Parent: Version6.5')
  expect(shown).toContain('into Version6.5 (draft)')
  expect(shown).toContain('Fix all the tables')
  expect(shown).toContain('(Ready for Review)')
  expect(shown).toContain('Worktree:')
  expect(shown).toContain('1 file uncommitted')
  expect(shown).toContain('1 commit not pushed')
  // Uncommitted files and unpushed commits both turn orange.
  expect((await ui.find({ type: 'Text', text: '1 file uncommitted' }))?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: '1 commit not pushed' }))?.props.color).toBe('warning')
  // Everything else is muted.
  for (const muted of ['Awareness Mod', 'Branch: BL-16818-tables  Parent: Version6.5', 'Worktree:', 'Running Agents', 'Search the tests (Explore)', 'Recent Prompts']) {
    const found = (await ui.findAll({ type: 'Text' })).find(t => t.text === muted)
    expect([muted, found?.props.dimColor]).toEqual([muted, true])
  }
  // The issue and PR lines are in the normal text color, not muted.
  for (const plain of ['Issue:', 'BL-16818', 'Fix all the tables', '(Ready for Review)', 'PR #8315', 'into Version6.5 (draft)', 'Reviewable']) {
    const found = (await ui.findAll({ type: 'Text' })).find(t => t.text === plain)
    expect([plain, found === undefined, found?.props.dimColor, found?.props.color]).toEqual([plain, false, undefined, undefined])
  }
  expect(shown).toContain('Search the tests (Explore)')
  expect(shown.some(t => t.includes('Old work'))).toBe(false)
  const links = await ui.findAll({ type: 'Link' })
  expect(links.map(l => l.props.href)).toEqual([
    'https://issues.bloomlibrary.org/youtrack/issue/BL-16818',
    'https://github.com/BloomBooks/BloomDesktop/pull/8315',
    'https://reviewable.io/reviews/BloomBooks/BloomDesktop/8315',
  ])
  const underlined = (await ui.findAll({ type: 'Text' })).filter(t => t.props.underline === true)
  expect(underlined.map(t => t.text)).toEqual(['BL-16818', 'D:\\BL-16818-tables', 'VSCode', 'PR #8315', 'Reviewable'])
  // The folder and VS Code buttons hand the worktree to Explorer.
  await ui.press({ key: 'open-folder' })
  await ui.press({ key: 'open-vscode' })
  expect(runs.filter(a => a[0] === 'explorer.exe')).toEqual([
    ['explorer.exe', 'D:\\BL-16818-tables'],
    ['explorer.exe', 'vscode://file/D:/BL-16818-tables'],
  ])
  // Above 80% a usage window turns red; below it stays dim.
  expect((await ui.find({ type: 'Text', text: /^ · week 85%$/ }))?.props.color).toBe('error')
  expect((await ui.find({ type: 'Text', text: /^5-hour 24%$/ }))?.props.dimColor).toBe(true)
  await ui.unmount()
})

test("reads a card's summary and the name of its State field", () => {
  const card = (fields: unknown) => JSON.stringify({ summary: 'inline images', customFields: fields })
  expect(parseCard('BL-16822', card([{ name: 'Severity', value: { name: 'Normal' } }, { name: 'State', value: { name: 'Ready For Code Review' } }]))).toEqual({ id: 'BL-16822', summary: 'inline images', state: 'Ready For Code Review' })
  expect(parseCard('BL-16822', card([{ name: 'State', value: null }])).state).toBe(null)
  expect(parseCard('BL-16822', card([])).state).toBe(null)
})

test('warns about a worktree whose PR is done or whose folder is not named for its branch', () => {
  expect(worktreeWarnings('D:\\BL-16822-inline-3-model', 'BL-16822-inline-3-model', 'open')).toEqual([])
  // Orca names a second worktree of a branch with a suffix; that still counts as named for it.
  expect(worktreeWarnings('D:\\canvas-refit-2', 'canvas-refit', 'draft')).toEqual([])
  expect(worktreeWarnings('D:/BL16822-1', 'BL-16822-inline-2-book-css', 'merged')).toEqual([
    'PR merged; this worktree can be removed',
    'folder name is not the branch (BL-16822-inline-2-book-css)',
  ])
  expect(worktreeWarnings('C:\\upd6', '(detached)', null)).toEqual([])
})

test('reads what the agents in each Orca worktree are doing', () => {
  const ps = JSON.stringify({ result: { worktrees: [
    { path: 'D:/BL16822-1', agents: [{ state: 'done' }, { state: 'working' }] },
    { path: 'D:/asks', agents: [{ state: 'blocked' }] },
    { path: 'D:/finished', agents: [{ state: 'done' }] },
    { path: 'D:/none' },
  ] } })
  expect([...parseOrcaAgents(ps).entries()]).toEqual([
    ['d:\\bl16822-1', 'working'],
    ['d:\\asks', 'waiting'],
  ])
})

test('reads which branch each worktree has checked out, leaving out detached ones', () => {
  const porcelain = ['worktree D:/bloom', 'HEAD 1', 'branch refs/heads/master', '', 'worktree C:/upd6', 'HEAD 2', 'detached', '', 'worktree D:/w8321', 'HEAD 3', 'branch refs/heads/BL-1-part-4', ''].join('\n')
  expect(parseWorktrees(porcelain)).toEqual([
    { path: 'D:\\bloom', branch: 'master' },
    { path: 'D:\\w8321', branch: 'BL-1-part-4' },
  ])
})

test('reads how each branch stands against its upstream', () => {
  const refs = ['in-sync\torigin/in-sync\t', 'mine\torigin/theirs\t[ahead 3, behind 5]', 'ahead\torigin/ahead\t[ahead 2]', 'behind\torigin/behind\t[behind 1]', 'gone\torigin/gone\t[gone]', 'local-only\t\t'].join('\n')
  const tracking = parseTracking(refs)
  expect([...tracking.entries()]).toEqual([
    ['in-sync', { remoteBranch: 'in-sync', sync: 'in sync' }],
    ['mine', { remoteBranch: 'theirs', sync: 'diverged' }],
    ['ahead', { remoteBranch: 'ahead', sync: 'ahead' }],
    ['behind', { remoteBranch: 'behind', sync: 'behind' }],
    ['gone', { remoteBranch: 'gone', sync: 'not pushed' }],
  ])
})

test("reads GitHub's stack in position order, merged pull requests included", () => {
  const entry = (position: number, number: number, state: string, isDraft = false) => ({ position, pullRequest: { number, url: `u${number}`, headRefName: `part-${position}`, baseRefName: 'x', state, isDraft } })
  const answer = (stack: unknown) => JSON.stringify({ data: { repository: { pullRequest: { stack } } } })
  const found = parseGitHubStack(answer({ entries: { nodes: [entry(2, 8319, 'OPEN'), entry(1, 8318, 'MERGED'), entry(3, 8320, 'OPEN', true)] } }))
  expect(found?.map(s => [s.number, s.head, s.status])).toEqual([[8318, 'part-1', 'merged'], [8319, 'part-2', 'open'], [8320, 'part-3', 'draft']])
  expect(parseGitHubStack(answer(null))).toBe(null)
})

test('finds the stack of open pull requests a branch is in, in merge order', () => {
  const pr = (number: number, head: string, base: string, isDraft = false) => ({ number, url: `u${number}`, headRefName: head, baseRefName: base, state: 'OPEN', isDraft })
  const open = JSON.stringify([
    pr(3, 'part-3', 'part-2', true),
    pr(1, 'part-1', 'master'),
    pr(2, 'part-2', 'part-1'),
    pr(9, 'other', 'master'),
  ])
  expect(stackOf(open, 'part-2').map(s => [s.number, s.status])).toEqual([[1, 'open'], [2, 'open'], [3, 'draft']])
  expect(stackOf(open, 'part-3').map(s => s.number)).toEqual([1, 2, 3])
  // A pull request with nothing chained to it is no stack.
  expect(stackOf(open, 'other')).toEqual([])
  expect(stackOf(open, 'missing')).toEqual([])
  // Two pull requests on the same branch: the stack stops below the fork.
  const forked = JSON.stringify([pr(1, 'a', 'master'), pr(2, 'b', 'a'), pr(3, 'c', 'a')])
  expect(stackOf(forked, 'a')).toEqual([])
  expect(stackOf(forked, 'b').map(s => s.number)).toEqual([1, 2])
})

test('reads the pull request status, a draft as draft', () => {
  const pr = (state: string, isDraft: boolean) => JSON.stringify({ number: 8315, url: 'u', baseRefName: 'master', state, isDraft })
  expect(parsePullRequest(pr('OPEN', true))).toEqual({ number: 8315, url: 'u', base: 'master', status: 'draft' })
  expect(parsePullRequest(pr('OPEN', false)).status).toBe('open')
  expect(parsePullRequest(pr('MERGED', false)).status).toBe('merged')
  expect(parsePullRequest(pr('CLOSED', true)).status).toBe('closed')
})

test('every link is underlined and the title is muted and bold', async ($, on) => {
  answerBottoms(on)
  on('session.cwd', () => ({ value: 'D:\\BL-16818-tables' }) as never)
  // Outside a git checkout's top folder answer, the session's directory stands in.
  on('process.run', ($, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    const exitCode = argv[2] === '--show-toplevel' ? 1 : 0
    return { value: { exitCode, stdout: '# branch.head BL-16818-tables\n', stderr: '' } } as never
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1 }, rateLimits: [] } }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('clock.every', () => ({ value: { cancel: () => undefined } }) as never)
  on('session.start', ($, e) => e as never)
  await $.session.start({ source: 'startup', cwd: 'D:\\BL-16818-tables' } as never)

  const ui = await $.ui.mount({ plugin: 'awareness', surface: 'terminal', ...PANE })
  const title = (await ui.findAll({ type: 'Text' })).at(-1)
  expect([title?.text, title?.props.bold, title?.props.dimColor]).toEqual(['Awareness Mod', true, true])
  const links = await ui.findAll({ type: 'Link' })
  expect(links.map(l => l.props.href)).toEqual(['https://issues.bloomlibrary.org/youtrack/issue/BL-16818'])
  // A branch with no pull request still says so.
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('PR: None')
  // Each link's text is underlined, and nothing else is.
  const underlined = (await ui.findAll({ type: 'Text' })).filter(t => t.props.underline === true)
  expect(underlined.map(t => t.text)).toEqual(['BL-16818', 'D:\\BL-16818-tables', 'VSCode'])
  await ui.unmount()
})

test('reads the name a branch has on its remote', () => {
  expect(parseUpstreamBranch('origin/canvas-refit\n')).toBe('canvas-refit')
  expect(parseUpstreamBranch('fork/BL-16818-tables/part-2\n')).toBe('BL-16818-tables/part-2')
  expect(parseUpstreamBranch('')).toBe(null)
})

test('finds the pull request by the tracked branch when the local name differs', async ($, on) => {
  answerBottoms(on)
  on('session.cwd', () => ({ value: 'D:/canvas-refit-3' }) as never)
  const ghCalls: string[][] = []
  on('process.run', ($, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    if (argv[0] === 'gh') {
      ghCalls.push(argv)
      // gh cannot tell where canvas-refit-3 pushes, so a bare `gh pr view` finds nothing.
      if (argv[3] !== 'canvas-refit') return { value: { exitCode: 1, stdout: '', stderr: 'no pull requests found' } } as never
      const stdout = JSON.stringify({ number: 8312, url: 'https://github.com/BloomBooks/BloomDesktop/pull/8312', baseRefName: 'master', state: 'OPEN', isDraft: true })
      return { value: { exitCode: 0, stdout, stderr: '' } } as never
    }
    let stdout = '# branch.head canvas-refit-3\n'
    if (argv[3] === '@{upstream}') stdout = 'origin/canvas-refit\n'
    else if (argv[2] === '--show-toplevel') stdout = 'D:/canvas-refit-3\n'
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1 }, rateLimits: [] } }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  const clock = mock.clock(on)
  on('session.start', ($, e) => e as never)
  await $.session.start({ source: 'startup', cwd: 'D:/canvas-refit-3' } as never)
  await clock.settle()

  expect(ghCalls.filter(a => a[2] === 'view').map(a => a[3])).toEqual(['--json', 'canvas-refit'])
  const ui = await $.ui.mount({ plugin: 'awareness', surface: 'terminal', ...PANE })
  const links = await ui.findAll({ type: 'Link' })
  expect(links.map(l => l.props.href)).toContain('https://github.com/BloomBooks/BloomDesktop/pull/8312')
  await ui.unmount()
})

test('writes a git drive path the Windows way', () => {
  expect(windowsPath('D:/BL-16818-tables')).toBe('D:\\BL-16818-tables')
  expect(windowsPath('/home/me/work')).toBe('/home/me/work')
})

test('turns a Windows folder into a VS Code URL', () => {
  expect(vscodeUrl('D:\\BL-16818-tables')).toBe('vscode://file/D:/BL-16818-tables')
  expect(vscodeUrl('/home/me/work')).toBe('vscode://file/home/me/work')
})

test('turns a pull request URL into its Reviewable page', () => {
  expect(reviewableUrl('https://github.com/BloomBooks/BloomDesktop/pull/8315')).toBe('https://reviewable.io/reviews/BloomBooks/BloomDesktop/8315')
})

test('builds the Working on line from the skill and the step', () => {
  const tasks = { '1': { doing: 'Fixing Devin bugs', status: 'in_progress' as const } }
  expect(workingOnText({ skill: 'Preflight', tasks, todo: null })).toBe('Working on: Preflight, fixing Devin bugs')
  expect(workingOnText({ skill: 'Preflight', tasks: {}, todo: null })).toBe('Working on: Preflight')
  expect(workingOnText({ skill: null, tasks, todo: null })).toBe('Working on: Fixing Devin bugs')
  expect(workingOnText({ skill: 'Preflight', tasks: {}, todo: 'Merging in master' })).toBe('Working on: Preflight, merging in master')
  expect(workingOnText({ skill: 'Preflight', tasks: {}, todo: 'CI is running' })).toBe('Working on: Preflight, CI is running')
  expect(workingOnText({ skill: null, tasks: {}, todo: null })).toBeNull()
  // A finished task is no longer the step.
  expect(workingOnText({ skill: 'Preflight', tasks: { '1': { doing: 'Fixing Devin bugs', status: 'completed' } }, todo: null })).toBe('Working on: Preflight')
})

test('names skills and reads them from typed slash commands', () => {
  expect(skillTitle('preflight')).toBe('Preflight')
  expect(skillTitle('youtrack-fix')).toBe('Youtrack fix')
  expect(skillTitle('vercel:deploy')).toBe('Deploy')
  expect(typedSkillName('/preflight thorough review')).toBe('preflight')
  expect(typedSkillName('<command-name>/preflight</command-name>\n<command-args></command-args>')).toBe('preflight')
  expect(typedSkillName('please run preflight')).toBeUndefined()
})

test('follows a task through the task list', () => {
  let tasks = updatedTasks({}, { taskId: '7', subject: 'Fix Devin bugs' })
  expect(tasks).toEqual({ '7': { doing: 'Fix Devin bugs', status: 'pending' } })
  tasks = updatedTasks(tasks, { taskId: '7', status: 'in_progress', activeForm: 'Fixing Devin bugs' })
  expect(tasks).toEqual({ '7': { doing: 'Fixing Devin bugs', status: 'in_progress' } })
  tasks = updatedTasks(tasks, { taskId: '7', status: 'deleted' })
  expect(tasks).toEqual({})
})

test('shows the skill the model starts and the task it is on', async ($, on) => {
  answerBottoms(on)
  on('tool.call', ($, e) => {
    if (e.tool === 'Skill') {
      return { result: { success: true, commandName: 'preflight' } } as never
    }
    if (e.tool === 'TaskCreate') {
      return { result: { task: { id: '1', subject: 'Fix Devin bugs' } } } as never
    }
    return { result: {} } as never
  })
  on('session.cwd', () => ({ value: 'D:/w' }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('agent.list', () => ({ value: [] }) as never)

  await $.tool.call({ tool: 'Skill', skill: 'preflight' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Fix Devin bugs', description: 'd', activeForm: 'Fixing Devin bugs' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as never)

  const ui = await $.ui.mount({ plugin: 'awareness', surface: 'terminal', ...PANE })
  const texts = await ui.findAll({ type: 'Text' })
  const line = texts.findIndex(t => t.text.startsWith('Working on'))
  expect(texts[line]?.text).toBe('Working on: Preflight, fixing Devin bugs')
  // It sits just above the "Recent Prompts" heading, in the newest prompt's colour.
  expect(texts[line + 1]?.text).toBe('Recent Prompts')
  expect(texts[line]?.props.color).toBe('suggestion')
  await ui.unmount()
})

test('takes the skill from a typed slash command, but not a built-in one', async ($, on) => {
  answerBottoms(on)
  on('command.list', () => ({ value: [
    { name: 'preflight', description: '', source: 'user' },
    { name: 'clear', description: '', source: 'builtin' },
  ] }) as never)

  await $.prompt.submit({ text: '/clear', origin: { kind: 'composer' }, wait: true })
  let ui = await $.ui.mount({ plugin: 'awareness', surface: 'terminal', ...PANE })
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text.startsWith('Working on'))).toBe(false)
  await ui.unmount()

  await $.prompt.submit({ text: '/preflight', origin: { kind: 'composer' }, wait: true })
  ui = await $.ui.mount({ plugin: 'awareness', surface: 'terminal', ...PANE })
  expect((await ui.findAll({ type: 'Text' })).find(t => t.text.startsWith('Working on'))?.text).toBe('Working on: Preflight')
  await ui.unmount()
})

test('ignores an update for a task it never saw that names nothing', () => {
  const tasks = { '1': { doing: 'Fixing Devin bugs', status: 'in_progress' as const } }
  expect(updatedTasks(tasks, { taskId: '9', status: 'in_progress' })).toEqual(tasks)
  expect(updatedTasks({}, { taskId: '9', status: 'in_progress', activeForm: 'Merging in master' })).toEqual({
    '9': { doing: 'Merging in master', status: 'in_progress' },
  })
})

test('clears the Working on line when the main conversation goes idle, not when a subagent does', async ($, on) => {
  answerBottoms(on)
  on('tool.call', () => ({ result: { success: true, commandName: 'preflight' } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.cwd', () => ({ value: 'D:/w' }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  const workingLine = async () => {
    const ui = await $.ui.mount({ plugin: 'awareness', surface: 'terminal', ...PANE })
    const line = (await ui.findAll({ type: 'Text' })).find(t => t.text.startsWith('Working on'))?.text
    await ui.unmount()
    return line
  }

  await $.tool.call({ tool: 'Skill', skill: 'preflight' } as never)
  expect(await workingLine()).toBe('Working on: Preflight')

  await $.turn.complete({ turnId: 't1', reason: 'completed', answer: '', agentId: 'sub-1' } as never)
  expect(await workingLine()).toBe('Working on: Preflight')

  await $.turn.complete({ turnId: 't2', reason: 'completed', answer: '' } as never)
  expect(await workingLine()).toBeUndefined()
})

test('takes the words after the card id from a branch name', () => {
  expect(cardWords('BL-15958-crop-marks')).toBe('crop marks')
  expect(cardWords('bl-17002-gallery_visuals')).toBe('gallery visuals')
  expect(cardWords('pull-latest-changes')).toBe(null)
  expect(cardWords('master')).toBe(null)
})

test('tidies a model reply into a short label', () => {
  expect(tidySummary('"Contentful sponsors."\nmore')).toBe('Contentful sponsors')
  expect(tidySummary('one two three four five')).toBe('one two three four')
})

test('labels the tab with the task, the card words standing in until there is one', () => {
  expect(tabLabel('crop marks', 'Awareness mod changes')).toBe('Awareness mod changes')
  expect(tabLabel('crop marks', null)).toBe('crop marks')
  expect(tabLabel(null, 'Contentful sponsors')).toBe('Contentful sponsors')
  expect(tabLabel(null, null)).toBe(null)
})

/** Runs a main-conversation turn end inside Orca on a card branch and returns the tab renames it asked for. */
const tabRenamesAfterTurn = async ($: Parameters<TestBody>[0], on: On) => {
  answerBottoms(on)
  mock.env(on, { ORCA_TERMINAL_HANDLE: 'term_me' })
  const renames: string[][] = []
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.cwd', () => ({ value: 'D:/BL-15958-crop-marks' }) as never)
  on('session.turns', () => ({ value: 3 }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  // The conversation is about something other than the worktree's card.
  on('model.fork', () => ({ value: { isAnswered: true, text: 'Awareness mod changes.' } }) as never)
  on('process.run', ($, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    if (argv[0] === 'orca' && argv[2] === 'rename') {
      renames.push(argv)
    }
    const stdout = argv[0] === 'git' && argv[1] === 'rev-parse' ? 'BL-15958-crop-marks\n' : ''
    return { value: { exitCode: argv[0] === 'gh' ? 1 : 0, stdout, stderr: '' } } as never
  })
  await $.turn.complete({ turnId: 't1', reason: 'completed', answer: '' } as never)
  await new Promise(resolve => setTimeout(resolve, 50))
  return renames
}

test('labels the Orca tab with what the conversation is working on, not the card, when a turn ends', async ($, on) => {
  expect(await tabRenamesAfterTurn($, on)).toEqual([['orca', 'terminal', 'rename', '--terminal', 'term_me', '--title', 'Awareness mod changes']])
})

test('leaves the Orca tab alone when the option is off', { options: { labelOrcaTab: false } }, async ($, on) => {
  expect(await tabRenamesAfterTurn($, on)).toEqual([])
})
