/** The team chat: a group or direct conversation as bubbles, with a mention picker and each superagent's live status. */
import { useEffect, useRef, useState } from 'react'
import type { MemberStatusRow, SuperagentRow, TeamDetailView } from '../app/views/teams.ts'
import { usePoll } from './api.ts'
import { Button, Modal, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { teamName } from './text.ts'
import { MarkdownLite, Section, When } from './widgets.tsx'
import chatStyles from './chat.css?raw'

type MessageRow = TeamDetailView['messages'][number]

const AVATAR_COLORS = ['#3b6ea5', '#2f7d6d', '#8a5a2b', '#7a4e8a', '#3f6f4e', '#8a4a4a', '#3e5f8a', '#6e6a32']
const HUMAN = 'me'

/** The first letter of a name, as the avatar shows it. */
function letter(name: string): string {
  return ([...name.trim()][0] ?? '?').toLocaleUpperCase()
}
/** A stable colour per member, so the same superagent keeps its colour across messages. */
function color(id: string): string {
  let hash = 0
  for (const char of id) hash = (hash * 33 + char.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!
}
function Avatar({ member }: { member: SuperagentRow }) {
  return <span className="dt-chat-avatar" style={{ background: member.role === 'human' ? '#5a6473' : color(member.id) }} aria-hidden>
    {letter(member.name)}
  </span>
}

/** A message as a bubble: the person's own lines align right, everyone else's left. */
function Bubble({ message, members, onReply }: { message: MessageRow; members: SuperagentRow[]; onReply: (message: MessageRow) => void }) {
  const { t } = usePanel()
  const own = message.from === HUMAN
  const member = members.find(item => item.id === message.from)
  if (message.kind === 'notice') return <li className="dt-chat-notice"><span>{message.text}</span></li>
  // A task, a report and a closing decision are cards rather than talk: they carry something the group must see.
  if (message.kind === 'task' || message.kind === 'report' || message.kind === 'decision') {
    return <li className={`dt-chat-card dt-chat-card-${message.kind}`}>
      <div className="dt-chat-card-head"><Tag tone="quiet">{t(`teamMsg.${message.kind}`)}</Tag>
        <span className="dt-chat-card-who">{message.fromName}</span><When at={message.at} /></div>
      <div className="dt-chat-card-body"><MarkdownLite text={message.text} /></div>
      {message.mentions?.length ? <div className="dt-chat-card-foot">{message.mentions.map(id => <At chip key={id}
        name={members.find(item => item.id === id)?.name ?? id} />)}</div> : null}
    </li>
  }
  return <li className={`dt-chat-line${own ? ' dt-chat-line-own' : ''}`}>
    {!own && (member ? <Avatar member={member} /> : <span className="dt-chat-avatar" style={{ background: color(message.from) }} aria-hidden>{letter(message.fromName)}</span>)}
    <div className="dt-chat-bubble">
      <div className="dt-chat-meta"><span className="dt-chat-who">{message.fromName}</span>
        <When at={message.at} />
        <button type="button" className="dt-chat-reply" onClick={() => onReply(message)}>{t('chatReply')}</button></div>
      {message.replyTo && <div className="dt-chat-quoted">{t('chatReplying')}</div>}
      <div className="dt-chat-text"><MarkdownLite text={message.text} /></div>
      {message.mentions?.length ? <div className="dt-chat-mentions">{message.mentions.map(id => <At chip key={id}
        name={members.find(item => item.id === id)?.name ?? id} />)}</div> : null}
    </div>
  </li>
}

/** A mention chip, as the picker and a message render one. */
function At({ name, chip, onRemove }: { name: string; chip?: boolean; onRemove?: () => void }) {
  return <span className={`dt-chat-at${chip ? ' dt-chat-at-chip' : ''}`}>@{name}
    {onRemove && <button type="button" className="dt-chat-at-x" aria-label={`remove @${name}`} onClick={onRemove}>×</button>}
  </span>
}

/** The status line of one superagent: what it is doing, and how many mentions wait for it. */
function StatusPill({ status }: { status?: MemberStatusRow }) {
  const { t } = usePanel()
  const state = status?.state ?? 'idle'
  return <span className="dt-chat-status" data-state={state} title={t(`chatStatus.${state}`)}>
    {state === 'queued' && status?.queued ? t('chatQueued', { count: status.queued }) : t(`chatStatus.${state}`)}
  </span>
}

/**
 * The composer: type a line, and pick the superagents who must answer from a picker that filters as you type. The mentions go
 * out as a structured list, so nothing is ever guessed from the text.
 */
function Composer({ teamId, members, replying, onSent, onCancelReply }: {
  teamId: string; members: SuperagentRow[]; replying?: MessageRow; onSent: () => void; onCancelReply: () => void
}) {
  const { t, call, notify } = usePanel()
  const [text, setText] = useState('')
  const [at, setAt] = useState<string[]>([])
  const [picking, setPicking] = useState(false)
  const [filter, setFilter] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const run = useAction(async () => {
    await call('POST teams/:id/message', { id: teamId, body: { text: text.trim(),
      ...at.length ? { at } : {}, ...replying ? { reply_to: replying.id } : {} } })
  })
  const candidates = members.filter(member => member.role !== 'human' && !at.includes(member.id) && !member.disabled
    && (!filter || member.name.toLowerCase().includes(filter.toLowerCase()) || member.id.toLowerCase().includes(filter.toLowerCase())))
  const submit = () => {
    if (!text.trim()) { notify(t('chatMessageRequired')); return }
    void run.run().then(done => {
      if (!done) return
      setText(''); setAt([]); setFilter(''); setPicking(false)
      onSent()
    })
  }
  return <div className="dt-chat-compose">
    {replying && <div className="dt-chat-replying"><span>{t('chatReplyingTo', { who: replying.fromName })}</span>
      <button type="button" className="dt-chat-at-x" onClick={onCancelReply}>×</button></div>}
    {at.length > 0 && <div className="dt-chat-mentions">{at.map(id => <At key={id} chip
      name={members.find(member => member.id === id)?.name ?? id} onRemove={() => setAt(at.filter(item => item !== id))} />)}</div>}
    {picking && <div className="dt-chat-picker" role="listbox" aria-label={t('chatMention')}>
      <input className="dt-chat-picker-filter" autoFocus value={filter} placeholder={t('chatMentionFilter')}
        onChange={event => setFilter(event.target.value)} aria-label={t('chatMentionFilter')} />
      {candidates.length ? candidates.map(member => <button key={member.id} type="button" role="option" aria-selected={false}
        className="dt-chat-picker-row" onClick={() => { setAt([...at, member.id]); setFilter(''); setPicking(false); field.current?.focus() }}>
        <Avatar member={member} /><span>{member.name}</span>
        {member.role === 'lead' && <Tag tone="quiet">{t('rosterLead')}</Tag>}
      </button>) : <p className="dt-hint">{t('chatNoCandidates')}</p>}
    </div>}
    <div className="dt-chat-input-row">
      <textarea ref={field} className="dt-textarea dt-chat-input" rows={2} maxLength={4000} value={text} spellCheck={false}
        aria-label={t('chatMessage')} placeholder={t('chatPlaceholder')}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() }
        }} />
      <div className="dt-chat-input-actions">
        <Button variant="ghost" size="sm" onClick={() => { setPicking(!picking); setFilter('') }}>@</Button>
        <Button variant="primary" size="sm" disabled={run.busy} onClick={submit}>{t('chatSend')}</Button>
      </div>
    </div>
  </div>
}

/**
 * The chat of one team. It polls for new messages and the members' status, so a superagent's line appears while the page is
 * open, and it keeps its own scroll at the newest message unless the person scrolled up to read.
 */
export function TeamChat({ team, detail, onReload }: {
  team: TeamDetailView['team']; detail: TeamDetailView; onReload: () => void
}) {
  const { t, call, notify } = usePanel()
  const [statuses, setStatuses] = useState<MemberStatusRow[]>([])
  const [replying, setReplying] = useState<MessageRow | undefined>()
  const [profile, setProfile] = useState<SuperagentRow | undefined>()
  const bottom = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  // The status poll is what makes "queued 2" and "working" visible without a page reload.
  useEffect(() => {
    let live = true
    const load = () => { void call('GET teams/:id', { id: team.id }).then(view => { if (live) setStatuses((view as TeamDetailView).statuses ?? []) }).catch(() => {}) }
    load()
    const timer = setInterval(load, 3000)
    return () => { live = false; clearInterval(timer) }
  }, [team.id, call])
  useEffect(() => {
    // A test environment and an old browser may lack scrollIntoView; scrolling is a convenience, never a requirement.
    if (stick.current && typeof bottom.current?.scrollIntoView === 'function') bottom.current.scrollIntoView({ block: 'end' })
  }, [detail.messages.length])
  const pause = useAction(async () => { await call('POST teams/:id/pause', { id: team.id, body: { paused: !team.paused } }) },
    { reload: () => Promise.resolve(onReload()) })
  return <>
    <style>{chatStyles}</style>
    <Section title={teamName(t, team)} count={detail.messages.length}
    action={<div className="dt-chat-head-actions">
      {team.paused && <Tag tone="warning">{t('chatPaused')}</Tag>}
      <Button variant="outline" size="sm" disabled={pause.busy} onClick={() => { void pause.run().then(done => { if (done) notify(t('chatPauseToggled')) }) }}>
        {team.paused ? t('chatResume') : t('chatPause')}
      </Button>
    </div>}>
    <StatusStrip members={team.members} statuses={statuses} onProfile={setProfile} />
    {profile && <ProfileForm member={profile} onClose={() => setProfile(undefined)} />}
    {team.paused && <p className="dt-hint">{team.paused.reason === 'hops' ? t('chatPausedHops') : t('chatPausedManual')}</p>}
    <ul className="dt-chat" onScroll={event => {
      const element = event.currentTarget
      stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
    }}>
      {detail.messages.length ? detail.messages.map(message => <Bubble key={message.id} message={message} members={team.members}
        onReply={setReplying} />) : <li className="dt-chat-empty">{t('chatEmpty')}</li>}
      <div ref={bottom} />
    </ul>
    {!team.closed && <Composer teamId={team.id} members={team.members} replying={replying}
      onSent={() => { setReplying(undefined); onReload() }} onCancelReply={() => setReplying(undefined)} />}
    </Section>
  </>
}

/**
 * A superagent's profile: the brief it works under and the skills it can read. The brief is `AGENTS.md` in its working
 * directory, which DSH injects into every request, so a change here reaches the next turn rather than the next deploy.
 */
function ProfileForm({ member, onClose }: { member: SuperagentRow; onClose: () => void }) {
  const { t, call, notify } = usePanel()
  const profile = usePoll(() => call('GET superagents/:id/profile', { id: member.id }), [member.id])
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [skill, setSkill] = useState<{ name: string; content: string } | undefined>(undefined)
  const save = useAction(async () => {
    const view = profile.data
    if (!view) return
    await call('PUT superagents/:id/agents-md', { id: member.id, body: { content: draft ?? '', baseMtime: view.agentsMd?.mtime ?? 0 } })
  }, { reload: async () => { profile.reload() } })
  const view = profile.data
  if (profile.error) return <Modal open onClose={onClose} title={member.name} closeLabel={t('close')}>
    <p className="dt-error" role="alert">{profile.error.message}</p>
  </Modal>
  if (!view) return <Modal open onClose={onClose} title={member.name} closeLabel={t('close')}><p className="dt-hint">{t('loading')}</p></Modal>
  const text = draft ?? view.agentsMd?.content ?? ''
  const dirty = draft !== undefined && draft !== (view.agentsMd?.content ?? '')
  const openSkill = (name: string) => { void call('GET superagents/:id/skills/:name', { id: member.id, name }).then(row => setSkill(row)).catch(() => {}) }
  return <Modal open onClose={onClose} title={member.name} closeLabel={t('close')} description={view.directory}
    footer={<><Button variant="ghost" onClick={onClose}>{t('close')}</Button>
      <Button variant="primary" disabled={save.busy || !dirty} onClick={() => {
        void save.run().then(done => { if (done) { notify(t('profileSaved')); setDraft(undefined) } })
      }}>{t('profileSave')}</Button></>}>
    <div className="dt-profile">
      <label className="dt-field">{t('profileAgentsMd')}
        <textarea className="dt-textarea dt-profile-text" rows={12} value={text} spellCheck={false}
          aria-label={t('profileAgentsMd')} placeholder={t('profileAgentsMdEmpty')}
          onChange={event => setDraft(event.target.value)} /></label>
      <p className="dt-hint">{t('profileAgentsMdHint')}</p>
      <div className="dt-profile-skills">
        <div className="dt-subhead">{t('profileSkills')}</div>
        {view.skills.length ? <ul className="dt-list">{view.skills.map(row => <li key={row.name} className="dt-row">
          <button type="button" className="dt-open" onClick={() => openSkill(row.name)}>{row.name}</button>
          <span className="dt-row-meta dt-line"><span>{row.description}</span><Tag tone="quiet">{t(`profileSkillSource.${row.source}`)}</Tag></span>
        </li>)}</ul> : <p className="dt-hint">{t('profileSkillsNone')}</p>}
        {skill && <div className="dt-profile-skill"><div className="dt-subhead">{skill.name}</div>
          <pre className="dt-profile-pre">{skill.content}</pre></div>}
      </div>
    </div>
  </Modal>
}

/** The chat's status strip, which is also the way into each superagent's profile. */
export function StatusStrip({ members, statuses, onProfile }: {
  members: SuperagentRow[]; statuses: MemberStatusRow[]; onProfile: (member: SuperagentRow) => void
}) {
  return <div className="dt-chat-statuses">{members.filter(member => member.role !== 'human').map(member =>
    <button key={member.id} type="button" className="dt-chat-status-item dt-chat-status-button" onClick={() => onProfile(member)}>
      <Avatar member={member} />
      <span className="dt-chat-status-name">{member.name}</span>
      <StatusPill status={statuses.find(row => row.id === member.id)} />
    </button>)}</div>
}

export { ProfileForm }
