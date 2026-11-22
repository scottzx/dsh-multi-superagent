// @vitest-environment jsdom
import { act, useState, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError, caller, usePoll } from '../src/client/api.ts'
import { GROUP_PANEL_ID, apply } from '../src/client/index.tsx'
import { zh } from '../src/client/locales.ts'
import { keepMark, presenceOf, presenceStore } from '../src/client/presence.ts'
import { SettingsSchema } from '../src/policy.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Entry = { options: { name: string; id?: string; key?: string; order?: number; locale?: string; label?: () => string }; component: ComponentType<Record<string, unknown>> }
const t = ((key: keyof typeof zh) => zh[key] ?? key) as never
function fixture(listed: string[]) {
  const entries: Entry[] = []
  const dictionaries: Record<string, unknown> = {}
  const ctx = {
    slots: { inject: (_name: string, register: () => void) => register(), register: (options: Entry['options'], component: Entry['component']) => { entries.push({ options, component }); return () => {} } },
    locale: { register: (ns: string, value: unknown) => { dictionaries[ns] = value; return () => {} }, bind: () => t },
    effect: (effect: () => unknown) => { effect() },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: Object.fromEntries(listed.map(id => [id, {}])) }), subscribe: () => () => {} }, refresh: vi.fn(async () => {}) },
    uiWorkspace: { openSession: vi.fn() },
    // Omit config form service so Deployment renders read-only; expose a mock layout service for panel selection.
    get: (name: string) => name === 'layout' ? layout : undefined,
  }
  const layout = { selectPanel: vi.fn(), panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} } }
  apply(ctx as never)
  const entry = (name: string, key?: string) => entries.find(item => item.options.name === name && (key === undefined || item.options.key === key))!
  return { ctx, layout, entries, dictionaries, main: entry('main', 'dsh-superagent'), groupMain: entry('main', GROUP_PANEL_ID), nav: entry('sidebar.panellist') }
}
async function render(entry: Entry, props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<entry.component {...props} />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, dispose: () => { act(() => { root.unmount() }); container.remove() } }
}
const openMaster = async (container: HTMLElement) => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === zh.openMaster)!
  await act(async () => { button.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const serve = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
  if (path === 'overview') return Response.json({ problems: [], person: [], executor: { running: 0, queued: 0, maxWorkers: 3, idle: 0 }, flow: { triggers: 0, filtered: 0, judged: 0, accepted: 0, evaluating: 0 }, policyVersion: 'v' })
  if (path === 'state') return Response.json({ masterId: 'master', superagents: [], settings: SettingsSchema.parse({}), revisions: { policy: 0, eval: 0, executor: 0 }, sources: [], policy_version: 'v', health: {}, outgoing: [], load: { running: 0, queued: 0 },
    setup: { machine: { stateDir: '/srv/state', worktreeRoot: '/srv/state/worktrees', blockedCommands: [], promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, problem: null, feishuProblem: null, accounts: null } })
  return Response.json({ error: 'unavailable' }, { status: 503 })
}))
afterEach(() => { vi.unstubAllGlobals() })

it('keeps done until the conversation is opened, and a request outranks work', () => {
  const memory = new Map<string, string>()
  presenceStore({ get: key => memory.get(key) ?? null, set: (key, value) => { memory.set(key, value) } })
  expect(presenceOf({ request: true, running: true, open: false, marked: false })).toBe('request')
  expect(presenceOf({ request: false, running: true, open: false, marked: false })).toBe('working')
  expect(keepMark(false, true, false)).toBe(true)
  expect(presenceOf({ request: false, running: false, open: false, marked: true })).toBe('done')
  expect(presenceOf({ request: false, running: false, open: true, marked: true })).toBe('idle')
  expect(keepMark(true, false, true)).toBe(false)
  presenceStore(undefined)
})

it('registers the management panel, dedicated group chat panel, sidebar entry and Plugin Manager row page, and no settings section', () => {
  const { entries, dictionaries, main, groupMain, nav } = fixture([])
  expect(entries.map(entry => entry.options.name)).toEqual(['main', 'main', 'sidebar.panellist', 'plugins.row.config', 'sidebar.workspaces'])
  expect(entries[3]!.options).toMatchObject({ key: 'dsh-superagent#dsh-superagent', locale: 'dshSuperagent' })
  expect(Object.keys(dictionaries)).toEqual(['dshSuperagent'])
  expect(main.options).toMatchObject({ key: 'dsh-superagent', locale: 'dshSuperagent' })
  expect(groupMain.options).toMatchObject({ key: GROUP_PANEL_ID, locale: 'dshSuperagent' })
  expect(nav.options).toMatchObject({ id: 'dsh-superagent', order: 10, locale: 'dshSuperagent' })
  expect(nav.options.label?.()).toBe('Superagent')
})

it('opens a listed Session through the workspace from the main panel', async () => {
  serve()
  const { ctx, main } = fixture(['master'])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('master')
  view.dispose()
})

it('reports a Session missing from the catalog in the interface language', async () => {
  serve()
  const { ctx, main } = fixture([])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.sessionNotListed)
  view.dispose()
})

it('polls one request at a time, keeps the data while new dependencies load, and polls less while hidden', async () => {
  vi.useFakeTimers()
  const calls: { limit: number; done: (value: string[]) => void }[] = []
  let shown: { data?: string[]; limit: number } = { limit: 0 }
  let setLimit = (_limit: number) => {}
  function Harness() {
    const [limit, update] = useState(1)
    setLimit = update
    const { data } = usePoll(() => new Promise<string[]>(done => { calls.push({ limit, done }) }), [limit], 1000)
    shown = { ...data ? { data } : {}, limit }
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  expect(calls).toHaveLength(1)
  // A slow response holds the next poll back instead of overlapping.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(1)
  await act(async () => { calls[0]!.done(['a']) })
  expect(shown.data).toEqual(['a'])
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toHaveLength(2)
  await act(async () => { setLimit(2) })
  expect(shown).toEqual({ data: ['a'], limit: 2 })
  await act(async () => { calls[2]!.done(['a', 'b']) })
  expect(shown.data).toEqual(['a', 'b'])
  // A late response to the superseded request must not replace the newer result.
  await act(async () => { calls[1]!.done(['stale']) })
  expect(shown.data).toEqual(['a', 'b'])
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => { calls[3]!.done(['a', 'b']) })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(4)
  hidden.mockRestore()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(calls).toHaveLength(5)
  act(() => { root.unmount() })
  vi.useRealTimers()
})

it('tells a dsh-superagent that does not answer from a record it does not have, and words each failure by what failed', async () => {
  const messages = { offline: 'offline', notRunning: 'not running', serverError: (status: number) => `server ${status}`,
    requestFailed: (status: number) => `request ${status}`, setup: () => 'setup', user: ({ code }: { code: string }) => `user ${code}` }
  const call = caller(() => messages)
  const failure = async (answer: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(answer))
    const error = await call('GET tickets/:id', { id: 't1' }).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    const { message, status, missing, details } = error as ApiError
    return { message, status, missing, unreachable: !!details.unreachable }
  }
  expect(await failure(async () => { throw new TypeError('Failed to fetch') })).toEqual({ message: 'offline', status: 0, missing: false,
    unreachable: true })
  // DSH's web server answers an empty 404 while dsh-superagent's routes are unregistered.
  expect(await failure(async () => new Response(null, { status: 404 }))).toEqual({ message: 'not running', status: 404, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response(null, { status: 502 }))).toEqual({ message: 'server 502', status: 502, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response('<html>Bad request</html>', { status: 400 }))).toEqual({ message: 'request 400',
    status: 400, missing: false, unreachable: false })
  expect(await failure(async () => Response.json({ error: 'Unknown ticket', code: 'unknownTicket' }, { status: 404 }))).toEqual({
    message: 'user unknownTicket', status: 404, missing: true, unreachable: false })
})

it('pins Bob (HR-orchestrator) in the sidebar roster in both wide and rail modes and opens his Session', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    if (path === 'state') return Response.json({ masterId: 'master', superagents: [{ id: 'alice', name: 'Alice', role: 'specialist', builtin: true }],
      settings: SettingsSchema.parse({}), revisions: { policy: 0, eval: 0, executor: 0 }, sources: [], policy_version: 'v', health: {}, outgoing: [], load: { running: 0, queued: 0 },
      setup: { machine: { stateDir: '/srv/state', worktreeRoot: '/srv/state/worktrees', blockedCommands: [], promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, problem: null, feishuProblem: null, accounts: null } })
    if (path === 'superagents') return Response.json({ superagents: [
      { id: 'me', name: 'You', role: 'human' },
      { id: 'alice', name: 'Alice', role: 'specialist', builtin: true },
    ] })
    if (path === 'teams') return Response.json({ teams: [
      { id: 'all-hands', name: 'All-hands', kind: 'group', leadId: 'alice', members: [{ id: 'me', name: 'You', role: 'human' }, { id: 'alice', name: 'Alice', role: 'specialist', builtin: true }], counts: { proposed: 0, waiting: 0, working: 0, done: 0, failed: 0 } },
    ] })
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }))
  const { ctx, entries } = fixture(['master', 'superagent-alice'])
  const workspaces = entries.find(entry => entry.options.name === 'sidebar.workspaces')!
  const wide = await render(workspaces, { wide: true })
  const bobBtn = wide.container.querySelector<HTMLButtonElement>('.dt-roster-bob')
  expect(bobBtn).not.toBeNull()
  expect(bobBtn?.textContent).toContain(zh.bobName)
  expect(bobBtn?.textContent).toContain(zh.bobBadge)
  expect(wide.container.textContent).toContain('Alice')
  expect(wide.container.textContent).not.toContain('You')
  await act(async () => { bobBtn!.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(ctx.uiWorkspace.openSession).toHaveBeenCalledWith('master')
  wide.dispose()

  const rail = await render(workspaces, { wide: false })
  const railBob = rail.container.querySelector<HTMLButtonElement>('.dt-roster-mark-bob')
  expect(railBob).not.toBeNull()
  expect(railBob?.title).toContain(zh.bobName)
  rail.dispose()
})

it('opens group chats in a dedicated direct-chat-style panel separate from settings tabs', async () => {
  const posted: { path: string; body: unknown }[] = []
  const team = { id: 'all-hands', name: 'All-hands', kind: 'group', leadId: 'alice',
    members: [{ id: 'me', name: 'You', role: 'human' }, { id: 'alice', name: 'Alice', role: 'specialist', builtin: true }],
    counts: { proposed: 0, waiting: 0, working: 1, done: 0, failed: 0 } }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    if (init?.method === 'POST') {
      posted.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined })
      return Response.json({ ok: true })
    }
    if (path === 'state') return Response.json({ masterId: 'master', superagents: [{ id: 'alice', name: 'Alice', role: 'specialist', builtin: true }],
      settings: SettingsSchema.parse({}), revisions: { policy: 0, eval: 0, executor: 0 }, sources: [], policy_version: 'v', health: {}, outgoing: [], load: { running: 0, queued: 0 },
      setup: { machine: { stateDir: '/srv/state', worktreeRoot: '/srv/state/worktrees', blockedCommands: [], promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, problem: null, feishuProblem: null, accounts: null } })
    if (path === 'superagents') return Response.json({ superagents: team.members })
    if (path === 'teams') return Response.json({ teams: [team] })
    if (path === 'teams/all-hands') return Response.json({
      team,
      tasks: [{ id: 't1', assigneeId: 'alice', assigneeName: 'Alice', text: '准备方案', state: 'working', after: [], outputs: [], createdAt: '2026-09-23T00:00:00Z' }],
      messages: [
        { id: 'm1', from: 'me', fromName: 'You', text: '大家好', at: '2026-09-23T00:00:00Z', kind: 'discussion' },
        { id: 'm2', from: 'alice', fromName: 'Alice', text: '收到，我来跟进。', at: '2026-09-23T00:01:00Z', kind: 'discussion', replyTo: 'm1' },
      ],
      statuses: [{ id: 'alice', state: 'working', queued: 0 }],
    })
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }))
  const { ctx, layout, entries, groupMain } = fixture(['master', 'superagent-alice'])
  const workspaces = entries.find(entry => entry.options.name === 'sidebar.workspaces')!
  const roster = await render(workspaces, { wide: true })
  const groupRow = [...roster.container.querySelectorAll<HTMLButtonElement>('.dt-roster-row')].find(btn => btn.textContent?.includes(zh.teamAllHands))!
  expect(groupRow).toBeDefined()
  await act(async () => { groupRow.click() })
  expect(layout.selectPanel).toHaveBeenCalledWith(GROUP_PANEL_ID)
  roster.dispose()

  const chat = await render(groupMain, { t })
  // Completely separate from the management/settings panel: no tablist!
  expect(chat.container.querySelector('[role="tablist"]')).toBeNull()
  expect(chat.container.querySelector('.dt-gc-title')?.textContent).toBe(zh.teamAllHands)
  expect(chat.container.textContent).toContain('收到，我来跟进。')

  // Open mention picker, select Alice, type and send a message.
  const mentionBtn = chat.container.querySelector<HTMLButtonElement>('.dt-gc-tool-btn')!
  await act(async () => { mentionBtn.click() })
  const option = chat.container.querySelector<HTMLButtonElement>('.dt-gc-picker-row')!
  await act(async () => { option.click() })
  expect(chat.container.querySelectorAll('.dt-gc-composer .dt-gc-at-chip')).toHaveLength(1)
  const textarea = chat.container.querySelector<HTMLTextAreaElement>('.dt-gc-textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(textarea, '看一下这个需求')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const sendBtn = chat.container.querySelector<HTMLButtonElement>('.dt-gc-send')!
  await act(async () => { sendBtn.click() })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(posted.find(req => req.path === 'teams/all-hands/message')?.body).toEqual({ text: '看一下这个需求', at: ['alice'] })

  // Toggle right info drawer: shows members, tasks, and opens Alice's direct chat.
  expect(chat.container.querySelector('.dt-gc-drawer')).toBeNull()
  const toggle = chat.container.querySelector<HTMLButtonElement>('.dt-gc-drawer-toggle')!
  await act(async () => { toggle.click() })
  expect(chat.container.querySelector('.dt-gc-drawer')?.textContent).toContain('准备方案')
  const directBtn = [...chat.container.querySelectorAll<HTMLButtonElement>('.dt-gc-drawer button')]
    .find(btn => btn.textContent?.includes(zh.groupDirectChat))!
  await act(async () => { directBtn.click() })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(ctx.uiWorkspace.openSession).toHaveBeenCalledWith('superagent-alice')
  chat.dispose()
})
