import type { On, RenderElement, SiteScroll } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { folderUrl, friendlyModelName, parseGitStatus, parsePullRequest } from '../hooks/register'

/** Stands in for the engine beneath the plugin: prompts pass, the pane body is empty. */
const answerBottoms = (on: On) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine' }) as RenderElement
  })
}

// The title draws one Text element, the status line three (the line, its dim
// part, the context figure) and the "Recent Prompts" heading one more; the
// prompts follow.
const HEADER_TEXTS = 5

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
    const rows = (await ui.findAll({ type: 'Text' })).slice(HEADER_TEXTS)
    expect(rows.map(r => r.text)).toEqual(['second line two', 'third', 'fourth'])
    expect(rows[2]?.props.bold).toBe(true)
    expect(rows[0]?.props.dimColor).toBe(true)
    expect(rows[1]?.props.dimColor).toBe(true)
    await ui.unmount()
  }
})

test('says there are no prompts before the first one', async ($, on) => {
  answerBottoms(on)
  const ui = await $.ui.mount({ plugin: 'awareness', surface: 'terminal', ...PANE })
  expect((await ui.findAll({ type: 'Text' }))[0]?.text).toBe('Awareness Mod')
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
    expect(texts[1]?.text).toBe(`Opus 5.5 (1M context) (medium) | context: ${percent}%`)
    const ctx = texts[3]
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
  expect(texts[1]?.text).toBe('Opus 5.5 (1M context) (high) | context: …')
  await ui.unmount()
})

test('reads branch, uncommitted files and unpushed commits from git status', () => {
  const ahead = ['# branch.oid abc', '# branch.head BL-16818-tables', '# branch.upstream origin/BL-16818-tables', '# branch.ab +2 -0', '1 .M N... 100644 100644 100644 a b src/x.ts', '? notes.txt', ''].join('\r\n')
  expect(parseGitStatus(ahead, 'D:/w')).toEqual({ branch: 'BL-16818-tables', worktree: 'D:/w', changedFiles: 2, unpushedCommits: 2 })
  const noUpstream = ['# branch.oid abc', '# branch.head new-branch', ''].join('\n')
  expect(parseGitStatus(noUpstream, 'D:/w')).toEqual({ branch: 'new-branch', worktree: 'D:/w', changedFiles: 0, unpushedCommits: null })
})

test('shows git state, card link, usage and running agents after a refresh', async ($, on) => {
  answerBottoms(on)
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, percent: 10 }, rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }, { kind: 'seven_day', percentUsed: 85 }], cost: { totalUsd: 0 } } }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('session.cwd', () => ({ value: 'D:/BL-16818-tables' }) as never)
  on('process.run', ($, e) => {
    const stdout = (e as unknown as { argv: string[] }).argv[0] === 'gh'
      ? JSON.stringify({ number: 8315, url: 'https://github.com/BloomBooks/BloomDesktop/pull/8315', state: 'OPEN', isDraft: true })
      : '# branch.head BL-16818-tables\n# branch.ab +1 -0\n? a.txt\n'
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('clock.every', () => ({ value: { cancel: () => undefined } }) as never)
  on('agent.list', () => ({ value: [
    { id: 'a1', description: 'Search the tests', type: 'Explore', status: 'running' },
    { id: 'a2', description: 'Old work', type: 'general-purpose', status: 'completed' },
  ] }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('session.start', ($, e) => e as never)
  await $.session.start({ source: 'startup', cwd: 'D:/BL-16818-tables' } as never)

  const ui = await $.ui.mount({ plugin: 'awareness', surface: 'terminal', ...PANE })
  const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(shown).toContain('usage: 5-hour 24% · week 85%')
  expect(shown).toContain('Workspace: BL-16818-tables')
  expect(shown).toContain('1 file uncommitted')
  expect(shown).toContain('1 commit not pushed')
  // Uncommitted files and unpushed commits both turn orange.
  expect((await ui.find({ type: 'Text', text: '1 file uncommitted' }))?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: '1 commit not pushed' }))?.props.color).toBe('warning')
  // Everything else is muted.
  for (const muted of ['Awareness Mod', 'Workspace: BL-16818-tables', 'BL-16818', 'PR #8315', 'Running Agents', 'Search the tests (Explore)', 'Recent Prompts']) {
    const found = (await ui.findAll({ type: 'Text' })).find(t => t.text === muted)
    expect([muted, found?.props.dimColor]).toEqual([muted, true])
  }
  expect(shown).toContain('Search the tests (Explore)')
  expect(shown.some(t => t.includes('Old work'))).toBe(false)
  const links = await ui.findAll({ type: 'Link' })
  expect(links.map(l => l.props.href)).toEqual([
    'file:///D:/BL-16818-tables',
    'https://issues.bloomlibrary.org/youtrack/issue/BL-16818',
    'https://github.com/BloomBooks/BloomDesktop/pull/8315',
  ])
  const underlined = (await ui.findAll({ type: 'Text' })).filter(t => t.props.underline === true)
  expect(underlined.map(t => t.text)).toEqual(['D:/BL-16818-tables', 'BL-16818', 'PR #8315'])
  expect(shown).toContain('(draft)')
  // Above 80% a usage window turns red; below it stays dim.
  expect((await ui.find({ type: 'Text', text: /^ · week 85%$/ }))?.props.color).toBe('error')
  expect((await ui.find({ type: 'Text', text: /^5-hour 24%$/ }))?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('reads the pull request status, a draft as draft', () => {
  const pr = (state: string, isDraft: boolean) => JSON.stringify({ number: 8315, url: 'u', state, isDraft })
  expect(parsePullRequest(pr('OPEN', true))).toEqual({ number: 8315, url: 'u', status: 'draft' })
  expect(parsePullRequest(pr('OPEN', false)).status).toBe('open')
  expect(parsePullRequest(pr('MERGED', false)).status).toBe('merged')
  expect(parsePullRequest(pr('CLOSED', true)).status).toBe('closed')
})

test('every link is underlined and the title is muted and bold', async ($, on) => {
  answerBottoms(on)
  on('session.cwd', () => ({ value: 'D:\\BL-16818-tables' }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '# branch.head BL-16818-tables\n', stderr: '' } }) as never)
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
  const title = (await ui.findAll({ type: 'Text' }))[0]
  expect([title?.text, title?.props.bold, title?.props.dimColor]).toEqual(['Awareness Mod', true, true])
  const links = await ui.findAll({ type: 'Link' })
  expect(links.map(l => l.props.href)).toEqual([
    'file:///D:/BL-16818-tables',
    'https://issues.bloomlibrary.org/youtrack/issue/BL-16818',
  ])
  // Each link's text is underlined, and nothing else is.
  const underlined = (await ui.findAll({ type: 'Text' })).filter(t => t.props.underline === true)
  expect(underlined.map(t => t.text)).toEqual(['D:\\BL-16818-tables', 'BL-16818'])
  await ui.unmount()
})

test('turns a Windows folder into a file URL', () => {
  expect(folderUrl('D:\\BL-16818-tables')).toBe('file:///D:/BL-16818-tables')
  expect(folderUrl('/home/me/work')).toBe('file:///home/me/work')
})
