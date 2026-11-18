/** Team page: the list of team conversations, a team's tasks and messages, and closing a round. */
import { useState } from 'react'
import type { SuperagentRow, TeamDetailView, TeamListView } from '../app/views/teams.ts'
import { usePoll } from './api.ts'
import { Button, Icon, Input, Modal, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { teamName } from './text.ts'
import { MarkdownLite, PageHead, Section, StageMark, When } from './widgets.tsx'
import { TeamChat } from './chat.tsx'

const TASK_MARKS: Record<TeamDetailView['tasks'][number]['state'],
  { dot: 'idle' | 'warning' | 'ongoing' | 'done' | 'error'; icon: 'queue' | 'clock' | 'running' | 'decision' | 'alert' }> = {
  proposed: { dot: 'idle', icon: 'queue' },
  waiting: { dot: 'warning', icon: 'clock' },
  working: { dot: 'ongoing', icon: 'running' },
  done: { dot: 'done', icon: 'decision' },
  failed: { dot: 'error', icon: 'alert' },
}

function TeamLine({ team, onOpen }: { team: TeamListView['teams'][number]; onOpen: (id: string) => void }) {
  const { t } = usePanel()
  const busy = team.counts.working + team.counts.waiting + team.counts.proposed
  return <li className="dt-row dt-link dt-ticket" data-state={team.closed ? 'idle' : 'ongoing'}>
    <div className="dt-ticket-stage">
      <StageMark state={team.closed ? 'idle' : 'ongoing'} icon={team.closed ? 'decision' : 'running'}
        label={team.closed ? t('teamClosed') : t('teamOpen')} />
    </div>
    <div className="dt-ticket-body">
      <div className="dt-row-title">
        <button type="button" className="dt-open" onClick={() => onOpen(team.id)}>{teamName(t, team)}</button>
      </div>
      <div className="dt-row-meta dt-line">
        <Tag tone="quiet">{t(`teamKind.${team.kind}`)}</Tag>
        <span>{team.members.map(member => member.name).join(t('listSeparator'))}</span>
        {busy > 0 && <span className="dt-lv"><span className="dt-lv-label">{t('teamTasksTitle')}</span>
          <span className="dt-lv-value">{busy}</span></span>}
        <When at={team.closed?.at} />
      </div>
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
        <span className="dt-lv"><span className="dt-lv-label">{t('teamAssignee')}</span>
          <span className="dt-lv-value">{task.assigneeName}</span></span>
        {task.after.length > 0 && <span className="dt-lv"><span className="dt-lv-label">{t('teamWaits')}</span>
          <span className="dt-lv-value">{task.after.join(t('listSeparator'))}</span></span>}
        {task.outputs.length > 0 && <span className="dt-lv"><span className="dt-lv-label">{t('teamOutputs')}</span>
          <span className="dt-lv-value">{task.outputs.length}</span></span>}
        {task.report && <span className="dt-line-text">{task.report}</span>}
        {task.reason && <span className="dt-line-text dt-error-text">{task.reason}</span>}
        <When at={task.updatedAt ?? task.createdAt} />
      </div>
    </div>
  </li>
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

function Roster() {
  const { t, call } = usePanel()
  const list = usePoll(() => call('GET superagents'), [])
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ id: '', name: '', persona: '', capabilities: '', directory: '' })
  const create = useAction(async () => {
    await call('POST superagents', { body: { id: draft.id.trim(), name: draft.name.trim(),
      ...draft.persona.trim() ? { persona: draft.persona.trim() } : {},
      ...draft.directory.trim() ? { directory: draft.directory.trim() } : {},
      ...draft.capabilities.trim() ? { capabilities: draft.capabilities.split(',').map(item => item.trim()).filter(Boolean) } : {} } })
  }, { reload: async () => { list.reload() } })
  const toggle = useAction(async (member: SuperagentRow) => {
    await call('POST superagents/:id', { id: member.id, body: { disabled: !member.disabled } })
  }, { reload: async () => { list.reload() } })
  if (!list.data) return null
  const members = (list.data as { superagents: SuperagentRow[] }).superagents
  return <Section title={t('superagentsTitle')} count={members.length}
    action={<Button variant="outline" size="sm" onClick={() => setOpen(true)}>{t('superagentCreate')}</Button>}>
    {members.length ? <ul className="dt-list dt-cards">{members.map(member => <li key={member.id} className="dt-row dt-ticket" data-state={member.disabled ? 'idle' : 'ongoing'}>
      <div className="dt-ticket-body">
        <div className="dt-row-title">{member.name}{member.disabled && <Tag tone="quiet">{t('superagentDisabled')}</Tag>}</div>
        <div className="dt-row-meta dt-line">
          {member.capabilities && <span>{member.capabilities.join(t('listSeparator'))}</span>}
          {member.persona && <span className="dt-line-text">{member.persona}</span>}
          <Button variant="ghost" size="sm" disabled={toggle.busy} onClick={() => { void toggle.run(member) }}>
            {member.disabled ? t('superagentEnable') : t('superagentDisable')}</Button>
        </div>
      </div>
    </li>)}</ul> : <p className="dt-hint">{t('superagentsNone')}</p>}
    <Modal open={open} onClose={() => setOpen(false)} title={t('superagentCreate')} closeLabel={t('close')}
      footer={<><Button variant="ghost" onClick={() => setOpen(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={create.busy} onClick={() => { void create.run().then(done => { if (done) setOpen(false) }) }}>{t('superagentSave')}</Button></>}>
      <label className="dt-field">{t('superagentId')}<Input value={draft.id} onChange={event => setDraft({ ...draft, id: event.target.value })} /></label>
      <label className="dt-field">{t('superagentName')}<Input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="dt-field">{t('superagentCapabilities')}<Input value={draft.capabilities} onChange={event => setDraft({ ...draft, capabilities: event.target.value })} /></label>
      <Field label={t('superagentDirectory')} hint={t('superagentDirectoryHint')}>
        <Input value={draft.directory} onChange={event => setDraft({ ...draft, directory: event.target.value })} />
      </Field>
      <label className="dt-field">{t('superagentPersona')}<textarea className="dt-textarea" rows={4} value={draft.persona} onChange={event => setDraft({ ...draft, persona: event.target.value })} /></label>
    </Modal>
  </Section>
}

/** The team tab: a list of team conversations, or one team's tasks and messages when a team is open. */
export function TeamPage({ id }: { id?: string }) {
  const { t, call, navigate } = usePanel()
  const list = usePoll(() => call('GET teams'), [])
  const detail = usePoll<TeamDetailView | undefined>(() => id === undefined ? Promise.resolve(undefined) : call('GET teams/:id', { id }), [id])
  if (id === undefined) {
    if (!list.data) return <p className="dt-error" role="alert">{list.error?.message ?? t('loading')}</p>
    const data = list.data as TeamListView
    return <><Roster /><Section title={t('teamsTitle')} count={data.teams.length}>
      {data.teams.length ? <ul className="dt-list dt-cards">{data.teams.map(team => <TeamLine key={team.id} team={team}
        onOpen={teamId => navigate({ page: 'team', id: teamId })} />)}</ul> : <p className="dt-hint">{t('teamsNone')}</p>}
    </Section></>
  }
  if (!detail.data) return <p className="dt-error" role="alert">{detail.error?.message ?? t('loading')}</p>
  const data = detail.data as TeamDetailView
  return <>
    <PageHead title={teamName(t, data.team)}>
      {!data.team.closed && <CloseTeam teamId={id} onClosed={() => navigate({ page: 'team' })} />}
    </PageHead>
    <Section title={t('teamInfo')}>
      <div className="dt-kv">
        <div style={{ display: 'contents' }}><dt>{t('teamKind')}</dt><dd><Tag tone="quiet">{t(`teamKind.${data.team.kind}`)}</Tag></dd></div>
        <div style={{ display: 'contents' }}><dt>{t('teamMembers')}</dt>
          <dd>{data.team.members.map(member => member.name).join(t('listSeparator'))}</dd></div>
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
