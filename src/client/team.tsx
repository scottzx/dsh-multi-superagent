/** Team page: HR-orchestrator (Bob), business specialists, group conversations, tasks, and chat. */
import { useState } from 'react'
import type { SuperagentRow, TeamDetailView, TeamListView, TeamSummary } from '../app/views/teams.ts'
import { ALL_HANDS_ID } from '../core/model.ts'
import { SessionNavigationError } from '../navigation.ts'
import { usePoll } from './api.ts'
import { ProfileForm, TeamChat } from './chat.tsx'
import { Button, Icon, Input, Modal, Tag } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { errorText, teamName } from './text.ts'
import { PageHead, Section, StageMark, When } from './widgets.tsx'

const AVATAR_COLORS = ['#3b6ea5', '#2f7d6d', '#8a5a2b', '#7a4e8a', '#3f6f4e', '#8a4a4a', '#3e5f8a', '#6e6a32']
const BOB_COLOR = '#1f3a5f'

const TASK_MARKS: Record<TeamDetailView['tasks'][number]['state'],
  { dot: 'idle' | 'warning' | 'ongoing' | 'done' | 'error'; icon: 'queue' | 'clock' | 'running' | 'decision' | 'alert' }> = {
  proposed: { dot: 'idle', icon: 'queue' },
  waiting: { dot: 'warning', icon: 'clock' },
  working: { dot: 'ongoing', icon: 'running' },
  done: { dot: 'done', icon: 'decision' },
  failed: { dot: 'error', icon: 'alert' },
}

function letter(name: string): string {
  return ([...name.trim()][0] ?? '?').toLocaleUpperCase()
}

function color(id: string): string {
  let hash = 0
  for (const char of id) hash = (hash * 33 + char.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!
}

function BobCard({ specialistCount, activeGroupCount }: { specialistCount: number; activeGroupCount: number }) {
  const { t, openSession, notify } = usePanel()
  const { state } = usePanelData()
  const masterId = state?.masterId
  const openBob = () => {
    if (!masterId) return
    void openSession(masterId).catch((error: unknown) => {
      notify(error instanceof SessionNavigationError ? t('sessionNotListed') : errorText(error))
    })
  }
  return <section className="dt-org-bob" aria-label={t('bobName')}>
    <div className="dt-org-bob-head">
      <span className="dt-org-avatar dt-org-avatar-bob" style={{ background: BOB_COLOR }} aria-hidden>{letter(t('bobName'))}</span>
      <div className="dt-org-bob-id">
        <div className="dt-org-bob-title">
          <h3>{t('bobName')}</h3>
          <Tag tone="info">{t('bobRole')}</Tag>
          <Tag tone="quiet">{t('bobOutsideGroups')}</Tag>
        </div>
        <p className="dt-hint">{t('bobBio')}</p>
      </div>
      <div className="dt-org-bob-cta">
        <Button variant="primary" size="sm" icon={<Icon name="session" size={14} />} disabled={!masterId}
          title={t('bobSessionHint')} onClick={openBob}>{t('openMaster')}</Button>
      </div>
    </div>
    <div className="dt-org-bob-foot">
      <div className="dt-org-caps">
        <Tag tone="neutral">{t('bobCapHire')}</Tag>
        <Tag tone="neutral">{t('bobCapGroup')}</Tag>
        <Tag tone="neutral">{t('bobCapHandoff')}</Tag>
        <Tag tone="neutral">{t('bobCapDissolve')}</Tag>
      </div>
      <div className="dt-stats">
        <span className="dt-stat"><span className="dt-stat-value">{specialistCount}</span>{t('bobStatSpecialists')}</span>
        <span className="dt-stat"><span className="dt-stat-value">{activeGroupCount}</span>{t('bobStatGroups')}</span>
      </div>
    </div>
  </section>
}

function CreateSpecialist({ onCreated }: { onCreated: () => void }) {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ id: '', name: '', persona: '', capabilities: '', directory: '', repository: '', feishuCli: '' })
  const create = useAction(async () => {
    await call('POST superagents', { body: { id: draft.id.trim(), name: draft.name.trim(),
      ...draft.persona.trim() ? { persona: draft.persona.trim() } : {},
      ...draft.directory.trim() ? { directory: draft.directory.trim() } : {},
      ...draft.repository.trim() ? { repository: draft.repository.trim() } : {},
      ...draft.feishuCli.trim() ? { feishuCli: draft.feishuCli.trim() } : {},
      ...draft.capabilities.trim() ? { capabilities: draft.capabilities.split(',').map(item => item.trim()).filter(Boolean) } : {} } })
  }, { reload: async () => { onCreated() } })
  const close = () => setOpen(false)
  return <>
    <Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setOpen(true)}>{t('superagentCreate')}</Button>
    <Modal open={open} onClose={close} title={t('superagentCreate')} closeLabel={t('close')}
      footer={<><Button variant="ghost" onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={create.busy} onClick={() => {
          void create.run().then(done => {
            if (done) { setOpen(false); setDraft({ id: '', name: '', persona: '', capabilities: '', directory: '', repository: '', feishuCli: '' }) }
          })
        }}>{t('superagentSave')}</Button></>}>
      <div className="dt-modal-form">
        <label className="dt-field">{t('superagentId')}<Input value={draft.id} onChange={event => setDraft({ ...draft, id: event.target.value })} /></label>
        <label className="dt-field">{t('superagentName')}<Input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="dt-field">{t('superagentCapabilities')}<Input value={draft.capabilities} onChange={event => setDraft({ ...draft, capabilities: event.target.value })} /></label>
        <Field label={t('superagentDirectory')} hint={t('superagentDirectoryHint')}>
          <Input value={draft.directory} onChange={event => setDraft({ ...draft, directory: event.target.value })} />
        </Field>
        <label className="dt-field">{t('superagentRepository')}<Input value={draft.repository} placeholder="owner/name" onChange={event => setDraft({ ...draft, repository: event.target.value })} /></label>
        <label className="dt-field">{t('superagentFeishu')}<Input value={draft.feishuCli} placeholder={t('superagentFeishuHint')} onChange={event => setDraft({ ...draft, feishuCli: event.target.value })} /></label>
        <label className="dt-field">{t('superagentPersona')}<textarea className="dt-textarea" rows={4} value={draft.persona} onChange={event => setDraft({ ...draft, persona: event.target.value })} /></label>
      </div>
    </Modal>
  </>
}

function EditSpecialistModal({ member, onClose, onSaved }: { member: SuperagentRow; onClose: () => void; onSaved: () => void }) {
  const { t, call } = usePanel()
  const [draft, setDraft] = useState({
    name: member.name,
    capabilities: member.capabilities?.join(', ') ?? '',
    directory: member.directory ?? '',
    repository: member.repository ?? '',
    feishuCli: member.feishuCli ?? '',
    persona: member.persona ?? '',
  })
  const save = useAction(async () => {
    const caps = draft.capabilities.split(',').map(item => item.trim()).filter(Boolean)
    await call('POST superagents/:id', { id: member.id, body: {
      name: draft.name.trim() || member.name,
      capabilities: caps.length ? caps : null,
      directory: draft.directory.trim() || null,
      repository: draft.repository.trim() || null,
      feishuCli: draft.feishuCli.trim() || null,
      persona: draft.persona.trim() || null,
    } })
  }, { reload: async () => { onSaved() } })
  return <Modal open onClose={onClose} title={t('superagentEditTitle')} description={`@${member.id}`} closeLabel={t('close')}
    footer={<><Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={save.busy} onClick={() => {
        void save.run().then(done => { if (done) onClose() })
      }}>{t('superagentSave')}</Button></>}>
    <div className="dt-modal-form">
      <label className="dt-field">{t('superagentName')}<Input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="dt-field">{t('superagentCapabilities')}<Input value={draft.capabilities} onChange={event => setDraft({ ...draft, capabilities: event.target.value })} /></label>
      <Field label={t('superagentDirectory')} hint={t('superagentDirectoryHint')}>
        <Input value={draft.directory} onChange={event => setDraft({ ...draft, directory: event.target.value })} />
      </Field>
      <label className="dt-field">{t('superagentRepository')}<Input value={draft.repository} placeholder="owner/name" onChange={event => setDraft({ ...draft, repository: event.target.value })} /></label>
      <label className="dt-field">{t('superagentFeishu')}<Input value={draft.feishuCli} placeholder={t('superagentFeishuHint')} onChange={event => setDraft({ ...draft, feishuCli: event.target.value })} /></label>
      <label className="dt-field">{t('superagentPersona')}<textarea className="dt-textarea" rows={4} value={draft.persona} onChange={event => setDraft({ ...draft, persona: event.target.value })} /></label>
    </div>
  </Modal>
}

function SpecialistsSection({ members, onReload }: { members: SuperagentRow[]; onReload: () => void }) {
  const { t, call, openSession, notify } = usePanel()
  const [profile, setProfile] = useState<SuperagentRow | undefined>()
  const [editing, setEditing] = useState<SuperagentRow | undefined>()
  const toggle = useAction(async (member: SuperagentRow) => {
    await call('POST superagents/:id', { id: member.id, body: { disabled: !member.disabled } })
  }, { reload: async () => { onReload() } })
  const openMember = (member: SuperagentRow) => {
    void openSession(`superagent-${member.id}`).catch((error: unknown) => {
      notify(error instanceof SessionNavigationError ? t('rosterOpenFailed') : errorText(error))
    })
  }
  return <Section title={t('superagentsTitle')} count={members.length} action={<CreateSpecialist onCreated={onReload} />}>
    {members.length ? <ul className="dt-member-grid">{members.map(member =>
      <li key={member.id} className="dt-member-card" data-disabled={member.disabled ? 'true' : undefined}>
        <div className="dt-member-head">
          <span className="dt-org-avatar" style={{ background: color(member.id) }} aria-hidden>{letter(member.name)}</span>
          <div className="dt-member-title">
            <strong>{member.name}</strong>
            <span className="dt-mono dt-member-id">@{member.id}</span>
            {member.builtin && <Tag tone="info">{t('rosterBuiltin')}</Tag>}
            {member.disabled && <Tag tone="quiet">{t('superagentDisabled')}</Tag>}
            {member.feishuCli && <Tag tone="quiet">{t('superagentFeishuTag')}</Tag>}
          </div>
        </div>
        {member.persona && <p className="dt-member-persona">{member.persona}</p>}
        {member.capabilities?.length ? <div className="dt-member-tags">
          {member.capabilities.map(cap => <Tag key={cap} tone="neutral">{cap}</Tag>)}
        </div> : null}
        {(member.directory || member.repository) && <div className="dt-member-meta">
          {member.directory && <span className="dt-lv"><span className="dt-lv-label">{t('superagentWorkspace')} </span><span className="dt-mono">{member.directory}</span></span>}
          {member.repository && <span className="dt-lv"><span className="dt-lv-label">{t('superagentRepo')} </span><span className="dt-mono">{member.repository}</span></span>}
        </div>}
        <div className="dt-member-actions">
          <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />} disabled={!!member.disabled}
            onClick={() => openMember(member)}>{t('superagentOpenChat')}</Button>
          <Button variant="ghost" size="sm" onClick={() => setProfile(member)}>{t('superagentProfile')}</Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(member)}>{t('superagentEdit')}</Button>
          {!member.builtin && <Button variant="ghost" size="sm" disabled={toggle.busy} onClick={() => { void toggle.run(member) }}>
            {member.disabled ? t('superagentEnable') : t('superagentDisable')}
          </Button>}
        </div>
      </li>)}</ul> : <p className="dt-hint">{t('superagentsNone')}</p>}
    {profile && <ProfileForm member={profile} onClose={() => setProfile(undefined)} />}
    {editing && <EditSpecialistModal member={editing} onClose={() => setEditing(undefined)} onSaved={onReload} />}
  </Section>
}

function CreateTeam({ specialists, onCreated }: { specialists: SuperagentRow[]; onCreated: () => void }) {
  const { t, call, notify } = usePanel()
  const active = specialists.filter(member => !member.disabled)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [ownerId, setOwnerId] = useState('')
  const create = useAction(async () => {
    await call('POST teams', { body: { name: name.trim(), member_ids: selected, kind: 'group', lead_id: ownerId } })
  }, { reload: async () => { onCreated() } })
  const openModal = () => {
    const defaults = active.slice(0, Math.min(2, active.length)).map(member => member.id)
    setName('')
    setSelected(defaults)
    setOwnerId(defaults[0] ?? '')
    setOpen(true)
  }
  const toggleMember = (id: string) => {
    const next = selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id]
    setSelected(next)
    if (!next.includes(ownerId)) setOwnerId(next[0] ?? '')
  }
  const submit = () => {
    if (!name.trim()) { notify(t('teamNameRequired')); return }
    if (!selected.length) { notify(t('teamMembersRequired')); return }
    if (!ownerId || !selected.includes(ownerId)) { notify(t('teamOwnerRequired')); return }
    void create.run().then(done => { if (done) setOpen(false) })
  }
  return <>
    <Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />} disabled={!active.length}
      onClick={openModal}>{t('teamCreate')}</Button>
    <Modal open={open} onClose={() => setOpen(false)} title={t('teamCreateTitle')} description={t('teamCreateHint')} closeLabel={t('close')}
      footer={<><Button variant="ghost" onClick={() => setOpen(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={create.busy} onClick={submit}>{t('confirm')}</Button></>}>
      <div className="dt-modal-form">
        <label className="dt-field">{t('teamName')}
          <Input value={name} placeholder={t('teamNamePlaceholder')} onChange={event => setName(event.target.value)} />
        </label>
        <div className="dt-field">
          <span>{t('teamMembers')}</span>
          <div className="dt-picker-checks">
            {active.map(member => <label key={member.id} className="dt-picker-check">
              <input type="checkbox" checked={selected.includes(member.id)} onChange={() => toggleMember(member.id)} />
              <span>{member.name}</span>
            </label>)}
          </div>
        </div>
        <label className="dt-field">{t('teamLead')}
          <select className="dt-select" value={ownerId} disabled={!selected.length}
            onChange={event => setOwnerId(event.target.value)}>
            {active.filter(member => selected.includes(member.id)).map(member =>
              <option key={member.id} value={member.id}>{member.name}</option>)}
          </select>
        </label>
      </div>
    </Modal>
  </>
}

function TeamLine({ team, onOpen }: { team: TeamSummary; onOpen: (id: string) => void }) {
  const { t } = usePanel()
  const busy = team.counts.working + team.counts.waiting + team.counts.proposed
  const bots = team.members.filter(member => member.role !== 'human')
  const ownerName = team.leadId ? (team.members.find(member => member.id === team.leadId)?.name ?? team.leadId) : undefined
  const standing = team.id === ALL_HANDS_ID
  return <li className="dt-row dt-link dt-ticket" data-state={team.closed ? 'idle' : 'ongoing'}>
    <div className="dt-ticket-stage">
      <StageMark state={team.closed ? 'idle' : 'ongoing'} icon={team.closed ? 'decision' : 'running'}
        label={team.closed ? t('teamClosed') : t('teamOpen')} />
    </div>
    <div className="dt-ticket-body">
      <div className="dt-row-title">
        <button type="button" className="dt-open" onClick={() => onOpen(team.id)}>{teamName(t, team)}</button>
        {standing && <Tag tone="info">{t('teamStanding')}</Tag>}
      </div>
      <div className="dt-row-meta dt-line">
        <Tag tone="quiet">{t(`teamKind.${team.kind}`)}</Tag>
        {ownerName && <span>{t('teamOwnerLabel', { name: ownerName })}</span>}
        <span>{(bots.length ? bots : team.members).map(member => member.name).join(t('listSeparator'))}</span>
        {busy > 0 && <span className="dt-lv"><span className="dt-lv-label">{t('teamTasksTitle')}</span>{' '}
          <span className="dt-lv-value">{busy}</span></span>}
        <When at={team.closed?.at} />
      </div>
      {standing && <p className="dt-hint">{t('teamAllHandsHint')}</p>}
    </div>
  </li>
}

function TeamTaskLine({ task }: { task: TeamDetailView['tasks'][number] }) {
  const { t } = usePanel()
  const mark = TASK_MARKS[task.state]
  return <li className="dt-row dt-ticket" data-state={mark.dot}>
    <div className="dt-ticket-stage"><StageMark state={mark.dot} icon={mark.icon} label={t(`teamState.${task.state}`)} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title">{task.text}</div>
      <div className="dt-row-meta dt-line">
        <span className="dt-lv"><span className="dt-lv-label">{t('teamAssignee')}</span>{' '}
          <span className="dt-lv-value">{task.assigneeName}</span></span>
        {task.after.length > 0 && <span className="dt-lv"><span className="dt-lv-label">{t('teamWaits')}</span>{' '}
          <span className="dt-lv-value">{task.after.join(t('listSeparator'))}</span></span>}
        {task.outputs.length > 0 && <span className="dt-lv"><span className="dt-lv-label">{t('teamOutputs')}</span>{' '}
          <span className="dt-lv-value">{task.outputs.length}</span></span>}
        {task.report && <span className="dt-line-text">{task.report}</span>}
        {task.reason && <span className="dt-line-text dt-error-text">{task.reason}</span>}
        <When at={task.updatedAt ?? task.createdAt} />
      </div>
    </div>
  </li>
}

function ChangeOwner({ team, onChanged }: { team: TeamSummary; onChanged: () => void }) {
  const { t, call, notify } = usePanel()
  const candidates = team.members.filter(member => member.role !== 'human' && !member.disabled)
  const [open, setOpen] = useState(false)
  const [ownerId, setOwnerId] = useState(team.leadId ?? candidates[0]?.id ?? '')
  const run = useAction(async () => {
    await call('POST teams/:id/owner', { id: team.id, body: { owner_id: ownerId } })
  }, { reload: async () => { onChanged() } })
  if (candidates.length < 2) return null
  const openModal = () => { setOwnerId(team.leadId ?? candidates[0]?.id ?? ''); setOpen(true) }
  const submit = () => {
    if (!ownerId) return
    void run.run().then(done => { if (done) { setOpen(false); notify(t('teamOwnerChanged')) } })
  }
  return <>
    <Button variant="outline" size="sm" icon={<Icon name="user" size={14} />} onClick={openModal}>{t('teamChangeOwner')}</Button>
    <Modal open={open} onClose={() => setOpen(false)} title={t('teamChangeOwnerTitle')} description={t('teamChangeOwnerHint')}
      closeLabel={t('close')}
      footer={<><Button variant="ghost" onClick={() => setOpen(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={run.busy || !ownerId || ownerId === team.leadId} onClick={submit}>{t('confirm')}</Button></>}>
      <label className="dt-field">{t('teamLead')}
        <select className="dt-select" value={ownerId} onChange={event => setOwnerId(event.target.value)}>
          {candidates.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select>
      </label>
    </Modal>
  </>
}

function CloseTeam({ teamId, onClosed }: { teamId: string; onClosed: () => void }) {
  const { t, call, notify } = usePanel()
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState('')
  const run = useAction(async () => { await call('POST teams/:id/close', { id: teamId, body: { summary } }) }, { reload: () => Promise.resolve(onClosed()) })
  const submit = () => {
    if (!summary.trim()) { notify(t('teamCloseSummaryRequired')); return }
    void run.run().then(done => { if (done) { setOpen(false); setSummary('') } })
  }
  return <>
    <Button variant="outline" size="sm" icon={<Icon name="decision" size={14} />} onClick={() => setOpen(true)}>{t('teamClose')}</Button>
    <Modal open={open} onClose={() => setOpen(false)} title={t('teamCloseTitle')} closeLabel={t('close')}
      description={t('teamCloseHint')}
      footer={<><Button variant="ghost" onClick={() => setOpen(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={run.busy} onClick={submit}>{t('confirm')}</Button></>}>
      <textarea className="dt-textarea" rows={4} maxLength={4000} value={summary} spellCheck={false}
        aria-label={t('teamCloseSummary')} onChange={event => setSummary(event.target.value)} />
    </Modal>
  </>
}

function TeamHome() {
  const { t, call, navigate } = usePanel()
  const teams = usePoll(() => call('GET teams'), [])
  const superagents = usePoll(() => call('GET superagents'), [])
  if (!teams.data) return <p className="dt-error" role="alert">{teams.error?.message ?? t('loading')}</p>
  const list = (teams.data as TeamListView).teams.slice()
    .sort((a, b) => Number(b.id === ALL_HANDS_ID) - Number(a.id === ALL_HANDS_ID) || Number(!!a.closed) - Number(!!b.closed))
  const specialists = ((superagents.data as { superagents: SuperagentRow[] } | undefined)?.superagents ?? [])
    .filter(member => member.role !== 'human')
    .sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin) || Number(!!a.disabled) - Number(!!b.disabled))
  const activeGroups = list.filter(team => !team.closed).length
  return <>
    <BobCard specialistCount={specialists.filter(member => !member.disabled).length} activeGroupCount={activeGroups} />
    <SpecialistsSection members={specialists} onReload={() => superagents.reload()} />
    <Section title={t('teamsTitle')} count={list.length} action={<CreateTeam specialists={specialists} onCreated={() => teams.reload()} />}>
      {list.length ? <ul className="dt-list dt-cards">{list.map(team => <TeamLine key={team.id} team={team}
        onOpen={teamId => navigate({ page: 'team', id: teamId })} />)}</ul> : <p className="dt-hint">{t('teamsNone')}</p>}
    </Section>
  </>
}

function TeamDetail({ id }: { id: string }) {
  const { t, call, navigate } = usePanel()
  const detail = usePoll<TeamDetailView>(() => call('GET teams/:id', { id }), [id])
  if (!detail.data) return <p className="dt-error" role="alert">{detail.error?.message ?? t('loading')}</p>
  const data = detail.data
  const standing = id === ALL_HANDS_ID
  const bots = data.team.members.filter(member => member.role !== 'human')
  return <>
    <PageHead title={teamName(t, data.team)}>
      {!data.team.closed && <div className="dt-actions">
        <ChangeOwner team={data.team} onChanged={() => detail.reload()} />
        {!standing && <CloseTeam teamId={id} onClosed={() => navigate({ page: 'team' })} />}
      </div>}
    </PageHead>
    <Section title={t('teamInfo')}>
      <div className="dt-kv">
        <div style={{ display: 'contents' }}><dt>{t('teamKind')}</dt><dd className="dt-actions">
          <Tag tone="quiet">{t(`teamKind.${data.team.kind}`)}</Tag>
          {standing && <Tag tone="info">{t('teamStanding')}</Tag>}
        </dd></div>
        <div style={{ display: 'contents' }}><dt>{t('teamMembers')}</dt>
          <dd>{(bots.length ? bots : data.team.members).map(member => member.name).join(t('listSeparator'))}</dd></div>
        <div style={{ display: 'contents' }}><dt>{t('teamWorkspace')}</dt>
          <dd>{data.team.members.filter(member => member.directory).map(member => `${member.name}：${member.directory}`).join(t('listSeparator')) || t('teamWorkspaceNone')}</dd></div>
        {data.team.leadId && <div style={{ display: 'contents' }}><dt>{t('teamLead')}</dt>
          <dd>{data.team.members.find(member => member.id === data.team.leadId)?.name ?? data.team.leadId}</dd></div>}
        {data.team.closed && <div style={{ display: 'contents' }}><dt>{t('teamClosedAt')}</dt>
          <dd>{t('teamClosedBy', { by: data.team.closed.by })}</dd></div>}
      </div>
    </Section>
    <Section title={t('teamTasksTitle')} count={data.tasks.length}>
      <ul className="dt-list dt-cards">{data.tasks.map(task => <TeamTaskLine key={task.id} task={task} />)}</ul>
    </Section>
    <TeamChat team={data.team} detail={data} onReload={() => detail.reload()} />
  </>
}

/** The team tab: Bob (HR-orchestrator), business specialists, group list, or one group's tasks and chat. */
export function TeamPage({ id }: { id?: string }) {
  return id === undefined ? <TeamHome /> : <TeamDetail id={id} />
}
