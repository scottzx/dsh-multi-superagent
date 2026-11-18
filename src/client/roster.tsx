/** Left sidebar: specialists and group chats, each with a presence dot and a letter avatar. */
import { useEffect, useState } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SuperagentRow, TeamListView } from '../app/views/teams.ts'
import { SessionNavigationError } from '../navigation.ts'
import { usePoll } from './api.ts'
import { Button, Input, Modal } from './controls.tsx'
import { isViewing, usePresence, type Presence } from './presence.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { requestTeam } from './route.ts'
import { teamName } from './text.ts'

const REQUESTS = new Set(['approval', 'plan-review', 'question'])
const AVATAR_COLORS = ['#3b6ea5', '#2f7d6d', '#8a5a2b', '#7a4e8a', '#3f6f4e', '#8a4a4a', '#3e5f8a', '#6e6a32']

export interface StatusSource {
  getSnapshot(): ReadonlyMap<string, { pendingInteraction?: { kind: string } }>
  subscribe(listener: () => void): () => void
}

function Create({ onDone }: { onDone: () => void }) {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ id: '', name: '', persona: '', capabilities: '', repository: '', feishuCli: '' })
  const create = useAction(async () => {
    await call('POST superagents', { body: { id: draft.id.trim(), name: draft.name.trim(),
      ...draft.persona.trim() ? { persona: draft.persona.trim() } : {},
      ...draft.capabilities.trim() ? { capabilities: draft.capabilities.split(',').map(item => item.trim()).filter(Boolean) } : {},
      ...draft.repository.trim() ? { repository: draft.repository.trim() } : {},
      ...draft.feishuCli.trim() ? { feishuCli: draft.feishuCli.trim() } : {} } })
  })
  return <>
    <button type="button" className="dt-roster-add" onClick={() => setOpen(true)}>{t('superagentCreate')}</button>
    <Modal open={open} onClose={() => setOpen(false)} title={t('superagentCreate')} closeLabel={t('close')}
      footer={<><Button variant="ghost" onClick={() => setOpen(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={create.busy} onClick={() => { void create.run().then(done => { if (done) { setOpen(false); onDone() } }) }}>{t('superagentSave')}</Button></>}>
      <label className="dt-field">{t('superagentId')}<Input value={draft.id} onChange={event => setDraft({ ...draft, id: event.target.value })} /></label>
      <label className="dt-field">{t('superagentName')}<Input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="dt-field">{t('superagentCapabilities')}<Input value={draft.capabilities} onChange={event => setDraft({ ...draft, capabilities: event.target.value })} /></label>
      <label className="dt-field">{t('superagentRepository')}<Input value={draft.repository} placeholder="owner/name" onChange={event => setDraft({ ...draft, repository: event.target.value })} /></label>
      <label className="dt-field">{t('superagentFeishu')}<Input value={draft.feishuCli} placeholder={t('superagentFeishuHint')} onChange={event => setDraft({ ...draft, feishuCli: event.target.value })} /></label>
      <label className="dt-field">{t('superagentPersona')}<textarea className="dt-textarea" rows={4} value={draft.persona} onChange={event => setDraft({ ...draft, persona: event.target.value })} /></label>
    </Modal>
  </>
}

function letter(name: string): string {
  const first = [...name.trim()][0] ?? '?'
  return first.toLocaleUpperCase()
}
function color(id: string): string {
  let hash = 0
  for (const char of id) hash = (hash * 33 + char.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!
}
function Avatar({ name, id, presence, label }: { name: string; id: string; presence: Presence; label: string }) {
  return <span className="dt-roster-avatar" style={{ background: color(id) }} aria-hidden>
    {letter(name)}
    <span className="dt-roster-presence" data-state={presence} title={label} />
  </span>
}

function rowOf(sessions: Pick<ISessions, 'list'> | undefined, id: string | undefined) {
  if (!sessions || !id) return undefined
  return sessions.list.getSnapshot().byId[id as SessionId] as { running?: boolean; retainedBy?: { mainView?: number } } | undefined
}
function requested(status: StatusSource | undefined, id: string | undefined): boolean {
  const kind = id ? status?.getSnapshot().get(id)?.pendingInteraction?.kind : undefined
  return kind !== undefined && REQUESTS.has(kind)
}

function useTick(source: { subscribe(listener: () => void): () => void } | undefined): void {
  const [, bump] = useState(0)
  useEffect(() => source?.subscribe(() => bump(value => value + 1)), [source])
}

/** The specialist and group list that occupies the sidebar's session-browser seat. */
export function Roster({ wide, sessions, status, openTeam }: {
  wide: boolean; sessions?: Pick<ISessions, 'list'>; status?: StatusSource; openTeam?: () => void
}) {
  const { t, call, openSession, notify } = usePanel()
  useTick(sessions?.list)
  useTick(status)
  const { state } = usePanelData()
  const list = usePoll(() => call('GET superagents'), [])
  const teams = usePoll(() => call('GET teams'), [])
  const members = list.data?.superagents ?? state?.superagents ?? []
  const groups = ((teams.data as TeamListView | undefined)?.teams ?? []).filter(team => team.kind === 'group')
  const lead = members.find(member => member.role === 'lead')
  const specialists = members.filter(member => member.role !== 'lead')
  const sessionId = (member: SuperagentRow) => member.role === 'lead' ? state?.masterId : `superagent-${member.id}`
  const entries = [
    ...members.map(member => {
      const id = sessionId(member)
      const row = rowOf(sessions, id)
      return { id: id ?? member.id, request: requested(status, id), running: row?.running === true,
        open: (row?.retainedBy?.mainView ?? 0) > 0 }
    }),
    ...groups.map(team => ({ id: `team:${team.id}`, request: false,
      running: !team.closed && team.counts.working + team.counts.waiting + team.counts.proposed > 0,
      open: isViewing(`team:${team.id}`) })),
  ]
  const presence = usePresence(entries)
  const label = (value: Presence) => t(`rosterStatus.${value}`)
  const openMember = (member: SuperagentRow) => {
    const id = sessionId(member)
    if (!id) return
    void openSession(id).catch((error: unknown) => {
      notify(error instanceof SessionNavigationError ? t('rosterOpenFailed') : error instanceof Error ? error.message : t('rosterOpenFailed'))
    })
  }
  if (!wide) return <div className="dt-roster dt-roster-rail" aria-label={t('superagentsTitle')}>
    {[...lead ? [lead] : [], ...specialists].slice(0, 8).map(member => <button key={member.id} type="button" className="dt-roster-mark" title={member.name}
      onClick={() => openMember(member)}>
      <Avatar name={member.name} id={member.id} presence={presence[sessionId(member) ?? member.id] ?? 'idle'} label={label(presence[sessionId(member) ?? member.id] ?? 'idle')} />
    </button>)}
  </div>
  return <div className="dt-roster">
    <div className="dt-roster-head"><span>{t('superagentsTitle')}</span><Create onDone={() => list.reload()} /></div>
    {lead && <button type="button" className="dt-roster-row" onClick={() => openMember(lead)}>
      <Avatar name={lead.name} id={lead.id} presence={presence[state?.masterId ?? lead.id] ?? 'idle'} label={label(presence[state?.masterId ?? lead.id] ?? 'idle')} />
      <span className="dt-roster-copy"><span className="dt-roster-name">{lead.name}</span><span className="dt-roster-role">{t('rosterLead')}</span></span>
    </button>}
    {specialists.length ? <ul className="dt-roster-list">{specialists.map(member => {
      const id = sessionId(member)!
      const value = presence[id] ?? 'idle'
      return <li key={member.id}>
        <button type="button" className="dt-roster-row" disabled={!!member.disabled} onClick={() => openMember(member)}>
          <Avatar name={member.name} id={member.id} presence={value} label={label(value)} />
          <span className="dt-roster-copy">
            <span className="dt-roster-name">{member.name}</span>
            <span className="dt-roster-role">{member.disabled ? t('superagentDisabled') : label(value)}</span>
          </span>
        </button>
      </li>
    })}</ul> : <p className="dt-roster-empty">{t('rosterEmpty')}</p>}
    <div className="dt-roster-head"><span>{t('rosterGroups')}</span></div>
    {groups.length ? <ul className="dt-roster-list">{groups.map(team => {
      const value = presence[`team:${team.id}`] ?? 'idle'
      const name = teamName(t, team)
      return <li key={team.id}>
        <button type="button" className="dt-roster-row" onClick={() => { requestTeam(team.id); openTeam?.() }}>
          <Avatar name={name} id={team.id} presence={value} label={label(value)} />
          <span className="dt-roster-copy">
            <span className="dt-roster-name">{name}</span>
            <span className="dt-roster-role">{team.members.map(member => member.name).join(t('listSeparator'))}</span>
          </span>
        </button>
      </li>
    })}</ul> : <p className="dt-roster-empty">{t('rosterGroupsEmpty')}</p>}
  </div>
}
