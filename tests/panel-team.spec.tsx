// @vitest-environment jsdom
// The Team tab: the list of team conversations, one team's tasks and messages, and closing a round.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, click, field, mount, tab, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('lists the team conversations with their kind, members and task counts', async () => {
  await mount()
  await click(tab(zh['tab.team']))
  expect(text()).toContain('文案团队')
  expect(text()).toContain('群聊')
  expect(text()).toContain('Lead')
  expect(text()).toContain('Writer')
  // proposed + waiting + working is the count of work not yet done.
  expect(text()).toContain('任务')
  expect(all('.dt-row.dt-link').length).toBe(1)
})

it('opens a team to its tasks and messages and closes the round', async () => {
  await mount()
  await click(tab(zh['tab.team']))
  await click('文案团队')
  // The detail shows the team, its tasks with their states, and its messages.
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('文案团队')
  expect(text()).toContain('改文案')
  expect(text()).toContain('审阅')
  expect(text()).toContain('执行中')
  expect(text()).toContain('等待')
  expect(text()).toContain('分一下工')
  expect(text()).toContain('已开工')
  // The team shows each member's bound project directory.
  expect(text()).toContain(zh.teamWorkspace)
  expect(text()).toContain('/Users/scott/projects/copy')
  // Closing records the lead's decision and returns to the list.
  await click(zh.teamClose)
  await type(field<HTMLTextAreaElement>(zh.teamCloseSummary), '定：文案已改完')
  await click(zh.confirm)
  expect(document.querySelector('.dt-page-title h2')).toBeNull()
  expect(text()).toContain('文案团队')
  expect(text()).toContain('已收口')
  const close = server.requests.find(request => request.method === 'POST' && request.path.includes('teams/team1/close'))
  expect(close?.body).toEqual({ summary: '定：文案已改完' })
})

it('refuses to close a team with no summary', async () => {
  await mount()
  await click(tab(zh['tab.team']))
  await click('文案团队')
  await click(zh.teamClose)
  await click(zh.confirm)
  // The modal stays open and the request is not sent.
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(server.requests.some(request => request.method === 'POST')).toBe(false)
})

it('speaks in the group with a mention picked from the list, and never from the text', async () => {
  await mount()
  await click(tab(zh['tab.team']))
  await click('文案团队')
  // A person's line is a bubble in the chat; the composer is the way in.
  expect(document.querySelector('.dt-chat')).not.toBeNull()
  // Typing @ in the text is not a mention: only the picker adds one.
  await type(field<HTMLTextAreaElement>(zh.chatMessage), '@Writer 请看一下')
  expect(document.querySelectorAll('.dt-chat-at-chip').length).toBe(0)
  await click('@')
  expect(document.querySelector('.dt-chat-picker')).not.toBeNull()
  // The person is never a candidate: it is already in the conversation.
  const picker = [...document.querySelectorAll('.dt-chat-picker-row')].map(row => row.textContent ?? '')
  expect(picker.some(label => label.includes('Writer'))).toBe(true)
  await click(document.querySelectorAll('.dt-chat-picker-row')[0] as HTMLElement)
  expect(document.querySelectorAll('.dt-chat-at-chip').length).toBe(1)
  await click(zh.chatSend)
  const sent = server.requests.find(request => request.method === 'POST' && request.path.includes('teams/team1/message'))
  expect(sent?.body).toMatchObject({ text: '@Writer 请看一下', at: ['lead'] })
})

it('shows what each superagent is doing, including the mentions waiting for it', async () => {
  await mount()
  await click(tab(zh['tab.team']))
  await click('文案团队')
  const statuses = [...document.querySelectorAll('.dt-chat-status')].map(node => node.textContent ?? '')
  expect(statuses).toContain('空闲')
  expect(statuses).toContain('执行中')
  expect(statuses.some(label => label.includes('排队'))).toBe(true)
})

it('opens a superagent\'s profile, shows its AGENTS.md and skills, and saves the brief', async () => {
  await mount()
  await click(tab(zh['tab.team']))
  await click('文案团队')
  // The status strip is the way in: clicking a member opens its profile.
  const member = [...document.querySelectorAll('.dt-chat-status-button')].find(node => node.textContent?.includes('Writer'))
  expect(member).toBeDefined()
  await click(member as HTMLElement)
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  const box = field<HTMLTextAreaElement>(zh.profileAgentsMd)
  expect(box.value).toContain('Writer')
  await type(box, '# Writer\n\nYou keep the house voice.')
  await click(zh.profileSave)
  const saved = server.requests.find(request => request.method === 'PUT' && request.path.includes('superagents/writer/agents-md'))
  expect(saved?.body).toMatchObject({ content: '# Writer\n\nYou keep the house voice.', baseMtime: 1 })
})

it('shows a conflict when AGENTS.md changed while it was being edited', async () => {
  await mount()
  await click(tab(zh['tab.team']))
  await click('文案团队')
  const member = [...document.querySelectorAll('.dt-chat-status-button')].find(node => node.textContent?.includes('Writer'))
  await click(member as HTMLElement)
  // Someone else saved first: the version the editor holds is no longer the file on disk.
  const mtime = server.profiles.writer?.agentsMd?.mtime ?? 1
  server.profiles.writer = { id: 'writer', name: 'Writer', directory: '/state/superagents/writer', skills: [],
    agentsMd: { path: '/state/superagents/writer/AGENTS.md', content: '# Writer\n\nChanged elsewhere.', mtime: mtime + 1 } }
  await type(field<HTMLTextAreaElement>(zh.profileAgentsMd), 'mine')
  await click(zh.profileSave)
  await new Promise(resolve => setTimeout(resolve, 0))
  // The save is refused rather than overwriting; the editor keeps the person's text.
  expect(field<HTMLTextAreaElement>(zh.profileAgentsMd).value).toBe('mine')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})
