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
