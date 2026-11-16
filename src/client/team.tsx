/** Team page: the list of team conversations, a team's tasks and messages, and closing a round. */
import { useState } from 'react'
import type { TeamDetailView, TeamListView } from '../app/views/teams.ts'
import { usePoll } from './api.ts'
import { Button, Icon, Modal, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { MarkdownLite, PageHead, Section, StageMark, When } from './widgets.tsx'

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
        <button type="button" className="dt-open" onClick={() => onOpen(team.id)}>{team.name}</button>
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

function TeamMessageLine({ message }: { message: TeamDetailView['messages'][number] }) {
  const { t } = usePanel()
  return <li className="dt-row dt-ticket" data-state="idle">
    <div className="dt-ticket-stage">
      <StageMark state={message.kind === 'decision' ? 'done' : message.kind === 'report' ? 'ongoing' : 'idle'}
        icon={message.kind === 'decision' ? 'decision' : message.kind === 'report' ? 'running' : 'message'}
        label={t(`teamMsg.${message.kind}`)} />
    </div>
    <div className="dt-ticket-body">
      <div className="dt-row-title"><span className="dt-row-who">{message.fromName}</span></div>
      <div className="dt-row-meta dt-line"><MarkdownLite text={message.text} /></div>
      <div className="dt-row-meta dt-line"><When at={message.at} /></div>
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

/** The team tab: a list of team conversations, or one team's tasks and messages when a team is open. */
export function TeamPage({ id }: { id?: string }) {
  const { t, call, navigate } = usePanel()
  const list = usePoll(() => call('GET teams'), [])
  const detail = usePoll<TeamDetailView | undefined>(() => id === undefined ? Promise.resolve(undefined) : call('GET teams/:id', { id }), [id])
  if (id === undefined) {
    if (!list.data) return <p className="dt-error" role="alert">{list.error?.message ?? t('loading')}</p>
    const data = list.data as TeamListView
    return <Section title={t('teamsTitle')} count={data.teams.length}>
      {data.teams.length ? <ul className="dt-list dt-cards">{data.teams.map(team => <TeamLine key={team.id} team={team}
        onOpen={teamId => navigate({ page: 'team', id: teamId })} />)}</ul> : <p className="dt-hint">{t('teamsNone')}</p>}
    </Section>
  }
  if (!detail.data) return <p className="dt-error" role="alert">{detail.error?.message ?? t('loading')}</p>
  const data = detail.data as TeamDetailView
  return <>
    <PageHead title={data.team.name}>
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
    <Section title={t('teamMessagesTitle')} count={data.messages.length}>
      <ul className="dt-list dt-cards">{data.messages.map(message => <TeamMessageLine key={message.id} message={message} />)}</ul>
    </Section>
  </>
}
