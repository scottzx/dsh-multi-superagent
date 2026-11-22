/** Left sidebar: HR-orchestrator (Bob), business specialists, and group chats, each with a presence dot and avatar. */
import { useEffect, useState } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SuperagentRow, TeamListView } from '../app/views/teams.ts'
import { ALL_HANDS_ID } from '../core/model.ts'
import { SessionNavigationError } from '../navigation.ts'
import { usePoll } from './api.ts'
import { Button, Input, Modal } from './controls.tsx'
import { isViewing, usePresence, type Presence } from './presence.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { requestTeam } from './route.ts'
import { errorText, teamName } from './text.ts'

const REQUESTS = new Set(['approval', 'plan-review', 'question'])
const AVATAR_COLORS = ['#3b6ea5', '#2f7d6d', '#8a5a2b', '#7a4e8a', '#3f6f4e', '#8a4a4a', '#3e5f8a', '#6e6a32']
const BOB_COLOR = '#1f3a5f'

export interface StatusSource {
  getSnapshot(): ReadonlyMap<string, { pendingInteraction?: { kind: string } }>
  subscribe(listener: () => void): () => void
}

function Create({ onDone }: { onDone: () => void }) {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ id: '', name: '', persona: '', capabilities: '', directory: '', repository: '', feishuCli: '' })
  const create = useAction(async () => {
    await call('POST superagents', { body: { id: draft.id.trim(), name: draft.name.trim(),
      ...draft.persona.trim() ? { persona: draft.persona.trim() } : {},
      ...draft.capabilities.trim() ? { capabilities: draft.capabilities.split(',').map(item => item.trim()).filter(Boolean) } : {},
      ...draft.directory.trim() ? { directory: draft.directory.trim() } : {},
      ...draft.repository.trim() ? { repository: draft.repository.trim() } : {},
      ...draft.feishuCli.trim() ? { feishuCli: draft.feishuCli.trim() } : {} } })
  })
  return <>
    <button type="button" className="dt-roster-add" onClick={() => setOpen(true)}>{t('superagentCreate')}</button>
    <Modal open={open} onClose={() => setOpen(false)} title={t('superagentCreate')} closeLabel={t('close')}
      footer={<><Button variant="ghost" onClick={() => setOpen(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={create.busy} onClick={() => {
          void create.run().then(done => {
            if (done) { setOpen(false); setDraft({ id: '', name: '', persona: '', capabilities: '', directory: '', repository: '', feishuCli: '' }); onDone() }
          })
        }}>{t('superagentSave')}</Button></>}>
      <label className="dt-field">{t('superagentId')}<Input value={draft.id} onChange={event => setDraft({ ...draft, id: event.target.value })} /></label>
      <label className="dt-field">{t('superagentName')}<Input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="dt-field">{t('superagentCapabilities')}<Input value={draft.capabilities} onChange={event => setDraft({ ...draft, capabilities: event.target.value })} /></label>
      <label className="dt-field">{t('superagentDirectory')}<Input value={draft.directory} onChange={event => setDraft({ ...draft, directory: event.target.value })} /></label>
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
function Avatar({ name, id, presence, label, bob }: { name: string; id: string; presence: Presence; label: string; bob?: boolean }) {
  return <span className={bob ? 'dt-roster-avatar dt-roster-avatar-bob' : 'dt-roster-avatar'}
    style={{ background: bob ? BOB_COLOR : color(id) }} aria-hidden>
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
  useEffect(() => typeof source?.subscribe === 'function' ? source.subscribe(() => bump(value => value + 1)) : undefined, [source])
}

/** The HR-orchestrator, specialist, and group list that occupies the sidebar's session-browser seat. */
export function Roster({ wide, sessions, status, openTeam }: {
  wide: boolean; sessions?: Pick<ISessions, 'list'>; status?: StatusSource; openTeam?: () => void
}) {
  const { t, call, openSession, notify } = usePanel()
  useTick(sessions?.list)
  useTick(status)
  const { state } = usePanelData()
  const list = usePoll(() => call('GET superagents'), [])
  const teams = usePoll(() => call('GET teams'), [])
  const masterId = state?.masterId
  const members = list.data?.superagents ?? state?.superagents ?? []
  const groups = ((teams.data as TeamListView | undefined)?.teams ?? [])
    .filter(team => team.kind === 'group')
    .sort((a, b) => Number(b.id === ALL_HANDS_ID) - Number(a.id === ALL_HANDS_ID) || Number(!!a.closed) - Number(!!b.closed))
  const specialists = members
    .filter(member => member.role !== 'human')
    .sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin) || Number(!!a.disabled) - Number(!!b.disabled))
  const sessionId = (member: SuperagentRow) => `superagent-${member.id}`
  const bobRow = rowOf(sessions, masterId)
  const bobKey = masterId ?? 'bob'
  const entries = [
    { id: bobKey, request: requested(status, masterId), running: bobRow?.running === true, open: (bobRow?.retainedBy?.mainView ?? 0) > 0 },
    ...specialists.map(member => {
      const id = sessionId(member)
      const row = rowOf(sessions, id)
      return { id, request: requested(status, id), running: row?.running === true,
        open: (row?.retainedBy?.mainView ?? 0) > 0 }
    }),
    ...groups.map(team => ({ id: `team:${team.id}`, request: false,
      running: !team.closed && team.counts.working + team.counts.waiting + team.counts.proposed > 0,
      open: isViewing(`team:${team.id}`) })),
  ]
  const presence = usePresence(entries)
  const label = (value: Presence) => t(`rosterStatus.${value}`)
  const bobPresence = presence[bobKey] ?? 'idle'
  const openBob = () => {
    if (!masterId) return
    void openSession(masterId).catch((error: unknown) => {
      notify(error instanceof SessionNavigationError ? t('sessionNotListed') : errorText(error))
    })
  }
  const openMember = (member: SuperagentRow) => {
    const id = sessionId(member)
    void openSession(id).catch((error: unknown) => {
      notify(error instanceof SessionNavigationError ? t('rosterOpenFailed') : error instanceof Error ? error.message : t('rosterOpenFailed'))
    })
  }
  if (!wide) return <div className="dt-roster dt-roster-rail" aria-label={t('superagentsTitle')}>
    <button type="button" className="dt-roster-mark dt-roster-mark-bob" title={`${t('bobName')} · ${t('bobRole')}`}
      disabled={!masterId} onClick={openBob}>
      <Avatar name={t('bobName')} id="bob" presence={bobPresence} label={label(bobPresence)} bob />
    </button>
    {specialists.length > 0 && <span className="dt-roster-rail-sep" aria-hidden />}
    {specialists.slice(0, 7).map(member => <button key={member.id} type="button" className="dt-roster-mark" title={member.name}
      disabled={!!member.disabled} onClick={() => openMember(member)}>
      <Avatar name={member.name} id={member.id} presence={presence[sessionId(member)] ?? 'idle'} label={label(presence[sessionId(member)] ?? 'idle')} />
    </button>)}
  </div>
  return <div className="dt-roster">
    <div className="dt-roster-head"><span>{t('rosterOrchestrator')}</span></div>
    <button type="button" className="dt-roster-row dt-roster-bob" disabled={!masterId} title={t('bobSessionHint')} onClick={openBob}>
      <Avatar name={t('bobName')} id="bob" presence={bobPresence} label={label(bobPresence)} bob />
      <span className="dt-roster-copy">
        <span className="dt-roster-name">
          <span>{t('bobName')}</span>
          <span className="dt-roster-badge">{t('bobBadge')}</span>
        </span>
        <span className="dt-roster-role">{bobPresence === 'idle' ? t('bobRole') : `${t('bobRole')} · ${label(bobPresence)}`}</span>
      </span>
    </button>
    <div className="dt-roster-sep" aria-hidden />
    <div className="dt-roster-head">
      <span className="dt-roster-head-title">{t('superagentsTitle')}<span className="dt-roster-count">{specialists.length}</span></span>
      <Create onDone={() => list.reload()} />
    </div>
    {specialists.length ? <ul className="dt-roster-list">{specialists.map(member => {
      const id = sessionId(member)
      const value = presence[id] ?? 'idle'
      return <li key={member.id}>
        <button type="button" className="dt-roster-row" disabled={!!member.disabled} onClick={() => openMember(member)}>
          <Avatar name={member.name} id={member.id} presence={value} label={label(value)} />
          <span className="dt-roster-copy">
            <span className="dt-roster-name">
              <span>{member.name}</span>
              {member.builtin && <span className="dt-roster-pill">{t('rosterBuiltin')}</span>}
            </span>
            <span className="dt-roster-role">{member.disabled ? t('superagentDisabled') : label(value)}</span>
          </span>
        </button>
      </li>
    })}</ul> : <p className="dt-roster-empty">{t('rosterEmpty')}</p>}
    <div className="dt-roster-head dt-roster-head-gap">
      <span className="dt-roster-head-title">{t('rosterGroups')}<span className="dt-roster-count">{groups.length}</span></span>
    </div>
    {groups.length ? <ul className="dt-roster-list">{groups.map(team => {
      const value = presence[`team:${team.id}`] ?? 'idle'
      const name = teamName(t, team)
      const bots = team.members.filter(member => member.role !== 'human')
      return <li key={team.id}>
        <button type="button" className="dt-roster-row" onClick={() => { requestTeam(team.id); openTeam?.() }}>
          <Avatar name={name} id={team.id} presence={value} label={label(value)} />
          <span className="dt-roster-copy">
            <span className="dt-roster-name">{name}</span>
            <span className="dt-roster-role">{bots.map(member => member.name).join(t('listSeparator'))}</span>
          </span>
        </button>
      </li>
    })}</ul> : <p className="dt-roster-empty">{t('rosterGroupsEmpty')}</p>}
  </div>
}
