/** Dedicated full-height Group Chat workspace mirroring DSH's native direct-chat layout, separate from the settings/management panel. */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { MemberStatusRow, SuperagentRow, TeamDetailView, TeamListView } from '../app/views/teams.ts'
import { ALL_HANDS_ID } from '../core/model.ts'
import { SessionNavigationError } from '../navigation.ts'
import { usePoll } from './api.ts'
import { ProfileForm } from './chat.tsx'
import { Button, Dot, Icon, Tag } from './controls.tsx'
import { clearViewing, viewing } from './presence.ts'
import { useAction, usePanel } from './provider.tsx'
import { ChangeOwner, CloseTeam, TASK_MARKS } from './team.tsx'
import { errorText, teamName } from './text.ts'
import { MarkdownLite, When } from './widgets.tsx'
import groupChatStyles from './group-chat.css?raw'

type MessageRow = TeamDetailView['messages'][number]

const AVATAR_COLORS = ['#3b6ea5', '#2f7d6d', '#8a5a2b', '#7a4e8a', '#3f6f4e', '#8a4a4a', '#3e5f8a', '#6e6a32']
const HUMAN = 'me'

function letter(name: string): string {
  return ([...name.trim()][0] ?? '?').toLocaleUpperCase()
}

function color(id: string): string {
  let hash = 0
  for (const char of id) hash = (hash * 33 + char.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!
}

function Avatar({ id, name, human, className = 'dt-gc-avatar' }: { id: string; name: string; human?: boolean; className?: string }) {
  return <span className={className} style={{ background: human ? '#5a6473' : color(id) }} aria-hidden>{letter(name)}</span>
}

function statusText(t: ReturnType<typeof usePanel>['t'], status?: MemberStatusRow): string {
  const state = status?.state ?? 'idle'
  return state === 'queued' && status?.queued ? t('chatQueued', { count: status.queued }) : t(`chatStatus.${state}`)
}

function MentionChip({ name, onRemove }: { name: string; onRemove?: () => void }) {
  return <span className="dt-gc-at-chip">@{name}
    {onRemove && <button type="button" className="dt-gc-at-x" aria-label={`remove @${name}`} onClick={onRemove}>×</button>}
  </span>
}

function MessageTurn({ message, quoted, members, ownerId, onReply }: {
  message: MessageRow; quoted?: MessageRow; members: SuperagentRow[]; ownerId?: string; onReply: (message: MessageRow) => void
}) {
  const { t } = usePanel()
  const own = message.from === HUMAN
  const member = members.find(item => item.id === message.from)
  const nameOf = (id: string) => members.find(item => item.id === id)?.name ?? id

  if (message.kind === 'notice') {
    if (message.from === 'bob') return <li className="dt-gc-notice dt-gc-notice-bob">
      <Tag tone="info">{t('bobHandoffLabel')}</Tag><span>{message.text}</span>
    </li>
    return <li className="dt-gc-notice"><span>{message.text}</span></li>
  }

  if (message.kind === 'task' || message.kind === 'report' || message.kind === 'decision') {
    return <li className={`dt-gc-card dt-gc-card-${message.kind}`}>
      <div className="dt-gc-card-head">
        <Tag tone={message.kind === 'decision' ? 'success' : message.kind === 'task' ? 'info' : 'quiet'}>{t(`teamMsg.${message.kind}`)}</Tag>
        <span className="dt-gc-who">{message.fromName}</span>
        <When at={message.at} />
      </div>
      <div className="dt-gc-card-body"><MarkdownLite text={message.text} /></div>
      {message.mentions?.length ? <div className="dt-gc-mentions">
        {message.mentions.map(id => <MentionChip key={id} name={nameOf(id)} />)}
      </div> : null}
    </li>
  }

  const quotePreview = message.replyTo ? (quoted ? `${quoted.fromName}: ${quoted.text.replace(/\s+/g, ' ').slice(0, 80)}` : t('chatReplying')) : undefined

  return <li className={`dt-gc-turn${own ? ' dt-gc-turn-own' : ''}`}>
    {!own && <Avatar id={member?.id ?? message.from} name={member?.name ?? message.fromName} human={member?.role === 'human'} />}
    <div className="dt-gc-turn-body">
      <div className="dt-gc-turn-head">
        {!own && <span className="dt-gc-who">{message.fromName}</span>}
        {!own && ownerId === message.from && <span className="dt-gc-owner-pill">{t('rosterOwner')}</span>}
        <When at={message.at} />
        <button type="button" className="dt-gc-reply-btn" onClick={() => onReply(message)}>{t('chatReply')}</button>
      </div>
      {quotePreview && <div className="dt-gc-quote">{quotePreview}</div>}
      <div className={own ? 'dt-gc-bubble-own' : 'dt-gc-prose'}>
        <MarkdownLite text={message.text} />
      </div>
      {message.mentions?.length ? <div className="dt-gc-mentions">
        {message.mentions.map(id => <MentionChip key={id} name={nameOf(id)} />)}
      </div> : null}
    </div>
  </li>
}

/** Detect an inline `@query` trigger at the cursor position (at start or after whitespace). */
function inlineMentionAt(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret)
  const match = /(?:^|\s)@([^\s@]{0,40})$/.exec(before)
  if (!match) return undefined
  const atIndex = before.lastIndexOf('@')
  return atIndex >= 0 ? { start: atIndex, query: match[1] ?? '' } : undefined
}

function GroupComposer({ team, statuses, replying, pendingMention, onConsumeMention, onSent, onCancelReply, onResume }: {
  team: TeamDetailView['team']
  statuses: MemberStatusRow[]
  replying?: MessageRow
  pendingMention?: { id: string; nonce: number }
  onConsumeMention: () => void
  onSent: () => void
  onCancelReply: () => void
  onResume: () => void
}) {
  const { t, call, notify } = usePanel()
  const [text, setText] = useState('')
  const [at, setAt] = useState<string[]>([])
  const [pickerMode, setPickerMode] = useState<'closed' | 'button' | 'inline'>('closed')
  const [filter, setFilter] = useState('')
  const [inlineRange, setInlineRange] = useState<{ start: number; end: number } | undefined>()
  const [activeIndex, setActiveIndex] = useState(0)
  const field = useRef<HTMLTextAreaElement>(null)
  const run = useAction(async () => {
    await call('POST teams/:id/message', { id: team.id, body: { text: text.trim(),
      ...at.length ? { at } : {}, ...replying ? { reply_to: replying.id } : {} } })
  })

  // Apply quick-mention chip from empty state.
  useEffect(() => {
    if (!pendingMention) return
    setAt(prev => prev.includes(pendingMention.id) ? prev : [...prev, pendingMention.id])
    onConsumeMention()
    field.current?.focus()
  }, [pendingMention, onConsumeMention])

  // Auto-size textarea like native direct chat.
  useEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 40), 180)}px`
  }, [text])

  const candidates = useMemo(() => team.members.filter(member => member.role !== 'human' && !at.includes(member.id) && !member.disabled
    && (!filter || member.name.toLowerCase().includes(filter.toLowerCase()) || member.id.toLowerCase().includes(filter.toLowerCase()))),
    [team.members, at, filter])

  useEffect(() => { setActiveIndex(0) }, [filter, pickerMode, candidates.length])

  const pickMember = useCallback((member: SuperagentRow) => {
    setAt(prev => prev.includes(member.id) ? prev : [...prev, member.id])
    if (pickerMode === 'inline' && inlineRange) {
      const next = `${text.slice(0, inlineRange.start)}${text.slice(inlineRange.end)}`
      setText(next)
    }
    setFilter('')
    setInlineRange(undefined)
    setPickerMode('closed')
    requestAnimationFrame(() => field.current?.focus())
  }, [pickerMode, inlineRange, text])

  const submit = () => {
    if (!text.trim()) { notify(t('chatMessageRequired')); return }
    void run.run().then(done => {
      if (!done) return
      setText(''); setAt([]); setFilter(''); setInlineRange(undefined); setPickerMode('closed')
      onSent()
    })
  }

  const onTextChange = (value: string, caret: number) => {
    setText(value)
    const trigger = inlineMentionAt(value, caret)
    if (trigger) {
      setPickerMode('inline')
      setFilter(trigger.query)
      setInlineRange({ start: trigger.start, end: caret })
    } else if (pickerMode === 'inline') {
      setPickerMode('closed')
      setFilter('')
      setInlineRange(undefined)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (pickerMode !== 'closed' && candidates.length > 0) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(index => (index + 1) % candidates.length); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(index => (index - 1 + candidates.length) % candidates.length); return }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pickMember(candidates[activeIndex]!); return }
      if (event.key === 'Escape') { event.preventDefault(); setPickerMode('closed'); setFilter(''); return }
    } else if (pickerMode !== 'closed' && event.key === 'Escape') {
      event.preventDefault(); setPickerMode('closed'); setFilter(''); return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const nameOf = (id: string) => team.members.find(member => member.id === id)?.name ?? id
  const busyStatus = statuses.find(item => item.state === 'working' || item.state === 'queued')
  const busyName = busyStatus ? nameOf(busyStatus.id) : undefined

  if (team.closed) {
    return <div className="dt-gc-composer-wrap"><div className="dt-gc-closed-bar">{t('groupClosedNotice')}</div></div>
  }

  return <div className="dt-gc-composer-wrap">
    {team.paused && <div className="dt-gc-paused-bar">
      <span>{team.paused.reason === 'hops' ? t('chatPausedHops') : t('chatPausedManual')}</span>
      <Button variant="outline" size="sm" onClick={onResume}>{t('chatResume')}</Button>
    </div>}
    <div className="dt-gc-composer">
      {pickerMode !== 'closed' && <div className="dt-gc-picker" role="listbox" aria-label={t('chatMention')}>
        {pickerMode === 'button' && <input className="dt-gc-picker-filter" autoFocus value={filter} placeholder={t('chatMentionFilter')}
          aria-label={t('chatMentionFilter')} onChange={event => setFilter(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); setPickerMode('closed'); field.current?.focus() }
            else if (event.key === 'Enter' && candidates[activeIndex]) { event.preventDefault(); pickMember(candidates[activeIndex]!) }
          }} />}
        {candidates.length ? candidates.map((member, index) => <button key={member.id} type="button" role="option"
          aria-selected={index === activeIndex} className="dt-gc-picker-row"
          onMouseEnter={() => setActiveIndex(index)} onClick={() => pickMember(member)}>
          <Avatar id={member.id} name={member.name} className="dt-gc-avatar-mini" />
          <span>{member.name}</span>
          {team.leadId === member.id && <Tag tone="quiet">{t('rosterOwner')}</Tag>}
          <span className="dt-gc-picker-meta">{statusText(t, statuses.find(item => item.id === member.id))}</span>
        </button>) : <p className="dt-hint" style={{ padding: '4px 8px' }}>{t('chatNoCandidates')}</p>}
      </div>}
      {(replying || at.length > 0) && <div className="dt-gc-compose-top">
        {replying && <span className="dt-gc-replying">
          <span className="dt-gc-replying-text">{t('chatReplyingTo', { who: replying.fromName })}</span>
          <button type="button" className="dt-gc-at-x" aria-label={t('close')} onClick={onCancelReply}>×</button>
        </span>}
        {at.map(id => <MentionChip key={id} name={nameOf(id)} onRemove={() => setAt(prev => prev.filter(item => item !== id))} />)}
      </div>}
      <textarea ref={field} className="dt-gc-textarea" rows={1} maxLength={4000} value={text} spellCheck={false}
        aria-label={t('chatMessage')} placeholder={t('chatPlaceholder')}
        onChange={event => onTextChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
        onKeyDown={onKeyDown} />
      <div className="dt-gc-composer-bar">
        <div className="dt-gc-composer-tools">
          <button type="button" className="dt-gc-tool-btn" aria-expanded={pickerMode !== 'closed'}
            onClick={() => { setPickerMode(mode => mode === 'button' ? 'closed' : 'button'); setFilter(''); setInlineRange(undefined) }}>
            <span>@</span><span>{t('groupMentionAction')}</span>
          </button>
          <span className="dt-gc-composer-hint">
            {busyName && busyStatus ? t('groupBusySummary', { name: busyName, state: statusText(t, busyStatus) }) : t('groupComposerHint')}
          </span>
        </div>
        <button type="button" className="dt-gc-send" aria-label={t('chatSend')} title={t('chatSend')}
          disabled={run.busy || !text.trim()} onClick={submit}>
          <Icon name="arrow-up" size={16} />
        </button>
      </div>
    </div>
  </div>
}

function InfoDrawer({ detail, statuses, onReload, onOpenProfile, onOpenManage }: {
  detail: TeamDetailView
  statuses: MemberStatusRow[]
  onReload: () => void
  onOpenProfile: (member: SuperagentRow) => void
  onOpenManage?: () => void
}) {
  const { t, call, openSession, notify } = usePanel()
  const { team, tasks } = detail
  const bots = team.members.filter(member => member.role !== 'human')
  const standing = team.id === ALL_HANDS_ID
  const pause = useAction(async () => { await call('POST teams/:id/pause', { id: team.id, body: { paused: !team.paused } }) },
    { reload: async () => { onReload() } })

  const openDirect = (member: SuperagentRow) => {
    void openSession(`superagent-${member.id}`).catch((error: unknown) => {
      notify(error instanceof SessionNavigationError ? t('rosterOpenFailed') : errorText(error))
    })
  }

  return <aside className="dt-gc-drawer" aria-label={t('groupInfoToggle')}>
    <section className="dt-gc-drawer-sec">
      <div className="dt-gc-drawer-head">
        <span>{t('teamMembers')}</span>
        <span className="dt-count">{bots.length}</span>
      </div>
      <ul className="dt-gc-member-list">
        {bots.map(member => {
          const status = statuses.find(item => item.id === member.id)
          const state = status?.state ?? 'idle'
          return <li key={member.id} className="dt-gc-member-item">
            <div className="dt-gc-member-top">
              <Avatar id={member.id} name={member.name} className="dt-gc-avatar-mini" />
              <span className="dt-gc-member-name">{member.name}</span>
              {team.leadId === member.id && <Tag tone="quiet">{t('rosterOwner')}</Tag>}
              <span className="dt-gc-member-status" data-state={state}>{statusText(t, status)}</span>
            </div>
            <div className="dt-gc-member-btns">
              <Button variant="ghost" size="sm" icon={<Icon name="session" size={13} />} disabled={!!member.disabled}
                onClick={() => openDirect(member)}>{t('groupDirectChat')}</Button>
              <Button variant="ghost" size="sm" onClick={() => onOpenProfile(member)}>{t('superagentProfile')}</Button>
            </div>
          </li>
        })}
      </ul>
    </section>

    <section className="dt-gc-drawer-sec">
      <div className="dt-gc-drawer-head">
        <span>{t('teamTasksTitle')}</span>
        <span className="dt-count">{tasks.length}</span>
      </div>
      {tasks.length ? <ul className="dt-gc-task-list">
        {tasks.map(task => {
          const mark = TASK_MARKS[task.state]
          return <li key={task.id} className="dt-gc-task-item">
            <div className="dt-gc-task-top">
              <Dot state={mark.dot} />
              <span>{task.text}</span>
            </div>
            <div className="dt-gc-task-meta">
              <span>{task.assigneeName}</span>
              <span>·</span>
              <span>{t(`teamState.${task.state}`)}</span>
              <When at={task.updatedAt ?? task.createdAt} />
            </div>
            {task.report && <p className="dt-hint" style={{ fontSize: 12 }}>{task.report}</p>}
            {task.reason && <p className="dt-error" style={{ fontSize: 12 }}>{task.reason}</p>}
          </li>
        })}
      </ul> : <p className="dt-hint">{t('groupTasksEmpty')}</p>}
    </section>

    <section className="dt-gc-drawer-sec">
      <div className="dt-gc-drawer-head"><span>{t('groupActions')}</span></div>
      <div className="dt-gc-drawer-actions">
        {!team.closed && <>
          <Button variant="outline" size="sm" icon={<Icon name={team.paused ? 'play' : 'pause'} size={13} />} disabled={pause.busy}
            onClick={() => { void pause.run().then(done => { if (done) notify(t('chatPauseToggled')) }) }}>
            {team.paused ? t('chatResume') : t('chatPause')}
          </Button>
          <ChangeOwner team={team} onChanged={onReload} />
          {!standing && <CloseTeam teamId={team.id} onClosed={onReload} />}
        </>}
        {onOpenManage && <Button variant="ghost" size="sm" icon={<Icon name="settings" size={13} />} onClick={onOpenManage}>
          {t('groupOpenSettings')}
        </Button>}
      </div>
    </section>
  </aside>
}

/** Dedicated Group Chat page: mirrors DSH's direct-chat layout, completely separate from the settings/management tabs. */
export function GroupChatPage({ teamId, onOpenManage }: { teamId?: string; onOpenManage?: () => void }) {
  const { t, call, notify } = usePanel()
  const list = usePoll<TeamListView>(() => call('GET teams'), [])
  const fallbackId = useMemo(() => {
    const groups = (list.data?.teams ?? []).filter(item => item.kind === 'group')
    return groups.find(item => item.id === ALL_HANDS_ID)?.id ?? groups.find(item => !item.closed)?.id ?? groups[0]?.id
  }, [list.data])
  const activeId = teamId ?? fallbackId
  const detail = usePoll<TeamDetailView | undefined>(() => activeId ? call('GET teams/:id', { id: activeId }) : Promise.resolve(undefined),
    [activeId], 2500)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [replying, setReplying] = useState<MessageRow | undefined>()
  const [profile, setProfile] = useState<SuperagentRow | undefined>()
  const [pendingMention, setPendingMention] = useState<{ id: string; nonce: number } | undefined>()
  const [scrolledUp, setScrolledUp] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // Reset per-group UI state and mark group as viewed to clear sidebar unread/done dots.
  useEffect(() => {
    setReplying(undefined)
    setScrolledUp(false)
    stick.current = true
    if (!activeId) return undefined
    viewing(`team:${activeId}`)
    return () => clearViewing(`team:${activeId}`)
  }, [activeId])

  const messageCount = detail.data?.messages.length ?? 0
  useEffect(() => {
    if (stick.current && typeof bottom.current?.scrollIntoView === 'function') bottom.current.scrollIntoView({ block: 'end' })
  }, [messageCount, activeId])

  const consumeMention = useCallback(() => setPendingMention(undefined), [])

  const resume = useAction(async () => {
    if (!activeId) return
    await call('POST teams/:id/pause', { id: activeId, body: { paused: false } })
  }, { reload: async () => { detail.reload() } })

  if (!activeId) {
    return <div className="dt-gc-shell">
      <style>{groupChatStyles}</style>
      <div className="dt-gc-empty-wrap">
        <Icon name="users" size={32} />
        <p className="dt-gc-empty-hint">{list.data ? t('groupSelectHint') : t('loading')}</p>
      </div>
    </div>
  }

  if (!detail.data) {
    return <div className="dt-gc-shell">
      <style>{groupChatStyles}</style>
      <div className="dt-gc-empty-wrap">
        <p className={detail.error ? 'dt-error' : 'dt-gc-empty-hint'} role={detail.error ? 'alert' : undefined}>
          {detail.error?.message ?? t('loading')}
        </p>
      </div>
    </div>
  }

  const data = detail.data
  const { team } = data
  const statuses = data.statuses ?? []
  const bots = team.members.filter(member => member.role !== 'human')
  const ownerName = team.leadId ? (team.members.find(member => member.id === team.leadId)?.name ?? team.leadId) : undefined
  const activeTasks = data.tasks.filter(task => task.state === 'proposed' || task.state === 'waiting' || task.state === 'working').length
  const busy = statuses.find(item => item.state === 'working' || item.state === 'queued')
  const busyName = busy ? (team.members.find(member => member.id === busy.id)?.name ?? busy.id) : undefined
  const byId = new Map(data.messages.map(item => [item.id, item]))
  const title = teamName(t, team)
  const standing = team.id === ALL_HANDS_ID

  const jumpToBottom = () => {
    stick.current = true
    setScrolledUp(false)
    if (typeof bottom.current?.scrollIntoView === 'function') bottom.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }

  return <div className="dt-gc-shell">
    <style>{groupChatStyles}</style>
    <header className="dt-gc-header">
      <div className="dt-gc-header-left">
        <Avatar id={team.id} name={title} />
        <div className="dt-gc-header-copy">
          <div className="dt-gc-title-row">
            <h1 className="dt-gc-title">{title}</h1>
            {standing && <Tag tone="info">{t('teamStanding')}</Tag>}
            {team.paused && <Tag tone="warning">{t('chatPaused')}</Tag>}
            {team.closed && <Tag tone="quiet">{t('teamClosed')}</Tag>}
          </div>
          <span className="dt-gc-subtitle">
            {ownerName ? `${t('teamOwnerLabel', { name: ownerName })} · ` : ''}
            {t('groupMembersCount', { count: bots.length })}
          </span>
        </div>
      </div>
      <div className="dt-gc-header-right">
        {busy && busyName && <button type="button" className="dt-gc-busy-pill" onClick={() => setDrawerOpen(true)}>
          <span className="dt-gc-busy-dot" aria-hidden />
          <span>{t('groupBusySummary', { name: busyName, state: statusText(t, busy) })}</span>
        </button>}
        <button type="button" className="dt-gc-drawer-toggle" aria-expanded={drawerOpen} title={t('groupInfoToggle')}
          onClick={() => setDrawerOpen(open => !open)}>
          <span className="dt-gc-avatar-stack" aria-hidden>
            {bots.slice(0, 3).map(member => <Avatar key={member.id} id={member.id} name={member.name} className="dt-gc-avatar-mini" />)}
          </span>
          {activeTasks > 0 && <span className="dt-gc-badge-count">{activeTasks}</span>}
          <Icon name="sidebar" size={15} />
        </button>
        {onOpenManage && <Button variant="ghost" size="sm" icon={<Icon name="settings" size={15} />}
          aria-label={t('groupOpenSettings')} title={t('groupOpenSettings')} onClick={onOpenManage} />}
      </div>
    </header>

    <div className="dt-gc-body">
      <div className="dt-gc-main">
        <div className="dt-gc-scroll" onScroll={event => {
          const el = event.currentTarget
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
          stick.current = nearBottom
          setScrolledUp(!nearBottom)
        }}>
          {data.messages.length ? <ul className="dt-gc-track">
            {data.messages.map(message => <MessageTurn key={message.id} message={message}
              quoted={message.replyTo ? byId.get(message.replyTo) : undefined}
              members={team.members} ownerId={team.leadId} onReply={setReplying} />)}
            <div ref={bottom} />
          </ul> : <div className="dt-gc-empty-wrap">
            <Avatar id={team.id} name={title} className="dt-gc-empty-avatar" />
            <h2 className="dt-gc-empty-title">{title}</h2>
            <p className="dt-gc-empty-hint">{t('groupQuickMention')}</p>
            {!team.closed && bots.length > 0 && <div className="dt-gc-quick-list">
              {bots.filter(member => !member.disabled).map(member => <button key={member.id} type="button" className="dt-gc-quick-chip"
                onClick={() => setPendingMention({ id: member.id, nonce: Date.now() })}>
                <Avatar id={member.id} name={member.name} className="dt-gc-avatar-mini" />
                <span>@{member.name}</span>
              </button>)}
            </div>}
            <div ref={bottom} />
          </div>}
        </div>

        {scrolledUp && <button type="button" className="dt-gc-jump" onClick={jumpToBottom}>
          <Icon name="arrow-down" size={13} /><span>{t('groupScrollBottom')}</span>
        </button>}

        <GroupComposer team={team} statuses={statuses} replying={replying}
          pendingMention={pendingMention} onConsumeMention={consumeMention}
          onSent={() => { setReplying(undefined); stick.current = true; setScrolledUp(false); detail.reload() }}
          onCancelReply={() => setReplying(undefined)}
          onResume={() => { void resume.run().then(done => { if (done) notify(t('chatPauseToggled')) }) }} />
      </div>

      {drawerOpen && <InfoDrawer detail={data} statuses={statuses} onReload={() => detail.reload()}
        onOpenProfile={setProfile} onOpenManage={onOpenManage} />}
    </div>

    {profile && <ProfileForm member={profile} onClose={() => setProfile(undefined)} />}
  </div>
}
