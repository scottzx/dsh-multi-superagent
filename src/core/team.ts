/** Teams: the team of superagents — identities, conversations, tasks, and the dispatch state machine. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { ALICE_ID, ALL_HANDS_ID, TEAM_BOT_LIMIT, TEAM_HOP_LIMIT, TEAM_MENTION_LIMIT, openTeam, superagentActive } from './model.ts'
import type { InboxItem, Superagent, SuperagentTurn, Team, TeamMessage, TeamMessageKind, TeamTask } from './model.ts'
import type { Reason } from './reasons.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { SuperagentRunner } from './ports.ts'
import type { Tickets } from './tickets.ts'

const busy = (team: Team, tasks: TeamTask[], memberId: string): boolean =>
  tasks.some(task => task.assigneeId === memberId && task.state === 'working' && task.turn && task.turn.state !== 'ended')
/** A SuperagentRunner that does nothing, for an Engine that never dispatches a team. */
const NOOP_SUPERAGENT: SuperagentRunner = { start() {}, deliver() {}, stop() {} }
/** The fixed id of the person in a team chat; there is one, and it runs no Session. */
export const HUMAN_ID = 'me'
/** The name the standing all-hands group is stored under; the panel shows its own wording for it. */
export const ALL_HANDS_NAME = 'All-hands'
/** Who Alice is until someone renames her. Bob hires everyone else; she is already here. */
const ALICE_PERSONA = '你是 Alice，本部署默认的业务 superagent，和之后招募的业务成员同一位置。Bob 建群并把一件事交给群主；你在任何所在群里都可以发言，当群主时还负责加人、踢人、拆任务和派任务。你不能建群，也不能解散群。'

/**
 * The `Teams` part owns the team of superagents.
 *
 * A `Team` is a conversation between superagents: a group of several or a direct conversation between two. A `TeamMessage` is
 * one line on it. A `TeamTask` is a piece of work the lead assigned to one member, with the members it waits on and the
 * deliverables it declares. The part runs the dispatch state machine (`proposed → waiting → working → done/failed`), detects
 * cycles in the dependency graph, routes messages to the members' turns, and delegates concrete work to a worker by creating a
 * Ticket under a team mandate. It writes every team record itself; the `SuperagentRunner` only reports facts about turns back.
 */
export class Teams extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets) { super(options) }

  // Superagents and teams

  /** Register a superagent identity. @throws UserError when the id is taken. */
  addSuperagent(superagent: Superagent): Superagent {
    const at = this.now()
    if (this.repo.team.superagents.get(superagent.id)) throw new UserError('superagentExists')
    const value = { ...superagent, createdAt: superagent.createdAt || at }
    this.repo.team.superagents.save(value)
    this.emit('superagent.added', { superagentId: value.id })
    // A new business member joins the standing all-hands group. Bob is not a superagent, so he never joins it.
    if (value.role !== 'human') this.ensureAllHands()
    return value
  }
  /**
   * Alice, the business superagent a deployment starts with. Created once; a later start keeps the name and persona someone
   * gave her and only restores the protection that she cannot be disabled. She is the first owner of the all-hands group.
   */
  ensureAlice(directory?: string): Superagent {
    const existing = this.repo.team.superagents.get(ALICE_ID)
    if (existing) {
      const next: Superagent = { ...existing, role: 'specialist', builtin: true, ...existing.directory || !directory ? {} : { directory } }
      this.repo.team.superagents.save(next)
      this.ensureAllHands()
      return next
    }
    return this.addSuperagent({ id: ALICE_ID, name: 'Alice', role: 'specialist', builtin: true, persona: ALICE_PERSONA,
      ...directory ? { directory } : {}, createdAt: '' })
  }
  /**
   * The standing all-hands group: every business superagent belongs to it, and the person does too. Bob does not. Its owner
   * stays whoever it already has, when that member is still in it; otherwise Alice, or the first business member. Hiring
   * joins the group. It is not a group its owner edits, and it is not dissolved.
   */
  ensureAllHands(): Team | undefined {
    const bots = this.superagents().filter(superagent => superagent.role === 'specialist')
    if (!bots.length) return undefined
    const memberIds = [...bots.map(superagent => superagent.id), ...this.humanIds()]
    const preferred = bots.find(superagent => superagent.id === ALICE_ID)?.id ?? bots[0]!.id
    const current = this.repo.team.teams.get(ALL_HANDS_ID)
    if (!current) {
      const value: Team = { id: ALL_HANDS_ID, name: ALL_HANDS_NAME, kind: 'group', memberIds, leadId: preferred, createdAt: this.now() }
      this.repo.team.teams.save(value)
      this.emit('team.created', { teamId: value.id })
      return value
    }
    const kept = current.memberIds.filter(id => memberIds.includes(id))
    const added = memberIds.filter(id => !kept.includes(id))
    const leadId = current.leadId && kept.includes(current.leadId) ? current.leadId : preferred
    if (!added.length && leadId === current.leadId && kept.length === current.memberIds.length) return current
    const next: Team = { ...current, memberIds: [...kept, ...added], leadId }
    this.repo.team.teams.save(next)
    if (added.length) this.emit('team.members.added', { teamId: next.id, memberIds: added })
    return next
  }
  /**
   * Change a superagent's persona, skills, directory or disabled state. A field left out is kept; `null` clears it.
   * @throws UserError when the superagent is unknown.
   */
  updateSuperagent(id: string, change: SuperagentChange): Superagent {
    const current = this.repo.team.superagents.get(id)
    if (!current) throw new UserError('unknownSuperagent', { superagent: id })
    const next = { ...current }
    if (change.name !== undefined) next.name = change.name
    if (change.capabilities === null) delete next.capabilities
    else if (change.capabilities) next.capabilities = [...change.capabilities]
    if (change.persona === null) delete next.persona
    else if (change.persona !== undefined) next.persona = change.persona
    if (change.skills === null) delete next.skills
    else if (change.skills) next.skills = [...change.skills]
    if (change.directory === null) delete next.directory
    else if (change.directory !== undefined) next.directory = change.directory
    if (change.repository === null) delete next.repository
    else if (change.repository !== undefined) next.repository = change.repository
    if (change.feishuCli === null) delete next.feishuCli
    else if (change.feishuCli !== undefined) next.feishuCli = change.feishuCli
    if (change.disabled && next.builtin) throw new UserError('builtinProtected')
    if (change.disabled === null) delete next.disabled
    else if (change.disabled) next.disabled = change.disabled
    this.repo.team.superagents.save(next)
    this.emit('superagent.updated', { superagentId: id })
    return next
  }
  /** Every superagent identity, oldest first. */
  superagents(): Superagent[] { return this.repo.team.superagents.list() }
  /**
   * Create a team conversation. A group needs an owner among its members, and that owner is a business superagent: the person
   * can speak in any group but is not its owner, and Bob is not a member. A group may hold at most `TEAM_BOT_LIMIT` bots; the
   * person is added to every new team, so it can be spoken to in it.
   * @throws UserError when the id is taken, a member is unknown, a group has no owner in it, or a group has too many bots.
   */
  addTeam(team: Team): Team {
    const at = this.now()
    if (this.repo.team.teams.get(team.id)) throw new UserError('teamExists')
    for (const memberId of team.memberIds) if (!this.repo.team.superagents.get(memberId)) throw new UserError('unknownSuperagent', { superagent: memberId })
    if (team.kind === 'group' && (team.leadId === undefined || !team.memberIds.includes(team.leadId) || this.isHuman(team.leadId))) throw new UserError('teamLeadMissing')
    const bots = team.memberIds.filter(memberId => this.repo.team.superagents.get(memberId)?.role !== 'human')
    // The standing all-hands group holds every bot of the deployment, so the bot limit does not apply to it.
    if (team.id !== ALL_HANDS_ID && bots.length > TEAM_BOT_LIMIT) throw new UserError('teamTooLarge', { limit: String(TEAM_BOT_LIMIT) })
    const members = [...team.memberIds, ...this.humanIds().filter(id => !team.memberIds.includes(id))]
    const value = { ...team, memberIds: members, createdAt: team.createdAt || at }
    this.repo.team.teams.save(value)
    this.emit('team.created', { teamId: value.id })
    return value
  }
  /**
   * Name a group's owner. The new owner is already a member, and is not the person. Bob calls this; the owner cannot.
   * @throws UserError when the team is unknown, not a group, or the owner is not a business member of it.
   */
  setOwner(teamId: string, ownerId: string): Team {
    const team = this.teamOf(teamId)
    if (!openTeam(team)) throw new UserError('teamClosed')
    if (team.kind !== 'group') throw new UserError('notAGroup')
    const owner = this.superagent(ownerId)
    if (!owner || owner.role === 'human' || !team.memberIds.includes(ownerId)) throw new UserError('teamLeadMissing')
    const next = { ...team, leadId: ownerId }
    this.repo.team.teams.save(next)
    return next
  }
  /**
   * The owner adds a business superagent to this group. The all-hands group is not edited this way: hiring joins it.
   * @throws UserError when the caller is not the owner, or the group cannot take another member.
   */
  addMember(teamId: string, by: string, memberId: string): Team {
    const team = this.ownedGroup(teamId, by)
    const member = this.superagent(memberId)
    if (!member || member.role === 'human') throw new UserError('unknownSuperagent', { superagent: memberId })
    if (team.memberIds.includes(memberId)) return team
    const memberIds = [...team.memberIds, memberId]
    const bots = memberIds.filter(id => this.superagent(id)?.role === 'specialist')
    if (bots.length > TEAM_BOT_LIMIT) throw new UserError('teamTooLarge', { limit: String(TEAM_BOT_LIMIT) })
    const next = { ...team, memberIds }
    this.repo.team.teams.save(next)
    this.emit('team.members.added', { teamId, memberIds: [memberId] })
    return next
  }
  /**
   * The owner removes a member other than themselves. The person stays, and so does the owner.
   * @throws UserError when the caller is not the owner, or the member is the owner or the person.
   */
  removeMember(teamId: string, by: string, memberId: string): Team {
    const team = this.ownedGroup(teamId, by)
    if (memberId === by || memberId === team.leadId) throw new UserError('cannotRemoveSelf')
    if (this.isHuman(memberId)) throw new UserError('notAMember', { member: memberId })
    if (!team.memberIds.includes(memberId)) throw new UserError('notAMember', { member: memberId })
    const next = { ...team, memberIds: team.memberIds.filter(id => id !== memberId) }
    this.repo.team.teams.save(next)
    return next
  }
  /**
   * Dissolve a group. Bob calls this; an owner cannot, and the all-hands group cannot be dissolved. Running turns stop.
   * The record stays, so the person speaking in it can open it again.
   */
  dissolve(teamId: string, summary: string): Team {
    const team = this.teamOf(teamId)
    if (team.id === ALL_HANDS_ID) throw new UserError('allHandsStanding')
    if (!openTeam(team)) throw new UserError('teamClosed')
    const at = this.now()
    const closed: Team = { ...team, closed: { at, by: 'bob', summary } }
    this.repo.team.teams.save(closed)
    this.repo.team.messages.save({ id: key('team-message', teamId, 'system', at, 'dissolve', summary), teamId, from: 'system',
      text: summary, at, kind: 'notice' })
    for (const task of this.tasks(teamId)) if (task.turn && task.turn.state !== 'ended') this.runner().stop(closed, task, 'The group was dissolved')
    this.emit('team.closed', { teamId, by: 'bob' })
    return closed
  }
  /**
   * Deliver a request to a group's owner without Bob joining the group or speaking in it. The owner reads it from the inbox.
   * @throws UserError when the team is unknown, closed, or has no owner.
   */
  handOff(teamId: string, text: string): TeamMessage {
    const team = this.teamOf(teamId)
    if (!openTeam(team)) throw new UserError('teamClosed')
    const owner = team.leadId
    if (!owner || !team.memberIds.includes(owner)) throw new UserError('teamLeadMissing')
    const at = this.now()
    const message: TeamMessage = { id: key('team-message', teamId, 'bob', at, 'handoff', text), teamId, from: 'bob', text, at,
      kind: 'notice', mentions: [owner] }
    this.repo.team.messages.save(message)
    this.repo.team.inbox.save({ botId: owner, messageId: message.id, teamId, at, state: 'pending' })
    this.emit('team.message', { messageId: message.id, teamId })
    this.runner().wake?.(owner)
    return message
  }
  /** A group its owner may edit. The all-hands group is not one of them. */
  private ownedGroup(teamId: string, by: string): Team {
    const team = this.teamOf(teamId)
    if (!openTeam(team)) throw new UserError('teamClosed')
    if (team.kind !== 'group') throw new UserError('notAGroup')
    if (team.id === ALL_HANDS_ID) throw new UserError('allHandsStanding')
    if (team.leadId !== by) throw new UserError('notGroupOwner')
    return team
  }
  /**
   * The person's identity, created once at startup so a group can always include it. The person runs no Session: it stands
   * for whoever is typing in the panel, and its messages are what wake the bots and resume a paused group.
   */
  ensureHuman(): Superagent {
    const existing = this.repo.team.superagents.get(HUMAN_ID)
    if (existing) { this.joinTeams(existing.id); return existing }
    const at = this.now()
    const human: Superagent = { id: HUMAN_ID, name: 'You', role: 'human', createdAt: at }
    this.repo.team.superagents.save(human)
    this.emit('superagent.added', { superagentId: human.id })
    this.joinTeams(human.id)
    return human
  }
  /**
   * Add the person to every team that lacks it, so a team created before the person existed can still be spoken to. Nothing else
   * about the team changes, and a team that already has it is left alone.
   */
  private joinTeams(humanId: string): void {
    for (const team of this.repo.team.teams.list()) {
      if (team.memberIds.includes(humanId)) continue
      this.repo.team.teams.save({ ...team, memberIds: [...team.memberIds, humanId] })
    }
  }
  /** Whether `id` is the person, who runs no Session. */
  isHuman(id: string): boolean { return this.repo.team.superagents.get(id)?.role === 'human' }
  private humanIds(): string[] { return this.repo.team.superagents.list().filter(member => member.role === 'human').map(member => member.id) }
  /** The superagent `id`, or undefined when it is unknown. */
  superagent(id: string): Superagent | undefined { return this.repo.team.superagents.get(id) }
  /** The team `id`, or undefined when it is unknown. */
  team(id: string): Team | undefined { return this.repo.team.teams.get(id) }
  /** The open teams, oldest first. */
  openTeams(): Team[] { return this.repo.team.teams.list().filter(openTeam) }
  /** The tasks of a team, oldest first. */
  tasks(teamId: string): TeamTask[] { return this.repo.team.tasks.list(teamId) }
  /** The messages of a team, oldest first. */
  messages(teamId: string): TeamMessage[] { return this.repo.team.messages.list(teamId) }

  // Messages

  /**
   * Record a message on a team and put it in the inbox of every member it mentions. A mention is the only thing that wakes a
   * member: naming someone in `text` wakes nobody, because the text is never searched. A message that mentions nobody is
   * recorded for the record and read by whoever reads the group next; it starts no turn.
   *
   * The person speaking resumes a group that paused itself, and clears the hop count, which counts what the bots said to each
   * other since the person last spoke.
   *
   * @throws UserError when the team or sender is unknown, the sender is not a member, a mention names a non-member or the
   * sender, more than `TEAM_MENTION_LIMIT` members are mentioned, or the team is closed.
   */
  sendMessage(teamId: string, from: string, text: string, kind: TeamMessageKind, options: SendOptions = {}): TeamMessage {
    const found = this.teamOf(teamId)
    // A close ends a round, not the conversation: the person speaking again starts the next round, and the same group goes on.
    // A bot never reopens a closed team, so the lead's close still stops its members from starting work.
    const reopened = !openTeam(found) && this.isHuman(from) ? this.reopen(found) : found
    const team = reopened
    if (!openTeam(team)) throw new UserError('teamClosed')
    if (!team.memberIds.includes(from)) throw new UserError('notAMember', { member: from })
    const sender = this.superagent(from)
    if (sender && !superagentActive(sender)) throw new UserError('superagentDisabled', { superagent: from })
    const mentions = this.checkedMentions(team, from, options.mentions ?? [])
    if (options.replyTo !== undefined && !this.messages(teamId).some(message => message.id === options.replyTo)) {
      throw new UserError('unknownMessage', { message: options.replyTo })
    }
    const at = this.now()
    const message: TeamMessage = { id: key('team-message', teamId, from, at, kind, text, ...options.taskId ? [options.taskId] : [],
      ...mentions.length ? [mentions.join(',')] : []), teamId, from, text, at, kind,
      ...mentions.length ? { mentions } : {}, ...options.replyTo ? { replyTo: options.replyTo } : {},
      ...options.taskId ? { taskId: options.taskId } : {}, ...options.triggerId ? { triggerId: options.triggerId } : {} }
    this.repo.team.messages.save(message)
    this.emit('team.message', { messageId: message.id, teamId })
    this.heard(team, from, at)
    for (const memberId of mentions) this.repo.team.inbox.save({ botId: memberId, messageId: message.id, teamId, at, state: 'pending' })
    // A group that is paused, or that pauses itself on this mention, records the message and wakes nobody: nothing is lost,
    // and the chain stops where it is until the person speaks or resumes the group.
    if (!this.hop(teamId, from, mentions)) this.wake(teamId, mentions)
    return message
  }
  /**
   * The person spoke: resume a group that paused itself, and reset the mention chain the bots have run since the person last
   * spoke. A manual pause is not lifted by speaking, only by `resume`.
   */
  private heard(team: Team, from: string, at: string): void {
    if (this.superagent(from)?.role !== 'human') return
    const change: Team = { ...team, hops: 0 }
    if (team.paused?.reason === 'hops') delete change.paused
    this.repo.team.teams.save(change)
    if (team.paused?.reason === 'hops') this.emit('team.resumed', { teamId: team.id })
    this.repo.team.cursors.save({ teamId: team.id, memberId: from, readAt: at })
  }
  /**
   * Check the members a message names: each is a member of the team, is not the sender, and is not disabled; a message names
   * at most `TEAM_MENTION_LIMIT` members. @throws UserError naming the first mention that is not allowed.
   */
  private checkedMentions(team: Team, from: string, mentions: readonly string[]): string[] {
    const unique = [...new Set(mentions)]
    if (unique.length > TEAM_MENTION_LIMIT) throw new UserError('tooManyMentions', { limit: String(TEAM_MENTION_LIMIT) })
    for (const memberId of unique) {
      if (memberId === from) throw new UserError('mentionSelf')
      if (!team.memberIds.includes(memberId)) throw new UserError('notAMember', { member: memberId })
      const member = this.superagent(memberId)
      if (!member) throw new UserError('unknownSuperagent', { superagent: memberId })
      if (!superagentActive(member)) throw new UserError('superagentDisabled', { superagent: memberId })
    }
    return unique
  }
  /** Open a closed group again for a new round, keeping its messages, tasks and members. */
  private reopen(team: Team): Team {
    const next: Team = { ...team, hops: 0 }
    delete next.closed
    delete next.paused
    this.repo.team.teams.save(next)
    this.repo.team.messages.save({ id: key('team-message', team.id, 'notice', this.now(), 'reopen'), teamId: team.id, from: 'system',
      text: 'The person spoke again, so this group starts a new round.', at: this.now(), kind: 'notice' })
    this.emit('team.resumed', { teamId: team.id })
    return next
  }
  /**
   * Hand the mentions to their members: a member whose turn is running in this group reads the line with its task; any other
   * member goes to its inbox, and the runner wakes it when it is free. The person has no Session, so it is skipped.
   */
  private wake(teamId: string, mentions: readonly string[]): void {
    const runner = this.runner()
    const team = this.teamOf(teamId)
    for (const memberId of mentions) {
      if (this.superagent(memberId)?.role === 'human') continue
      const task = this.currentTask(teamId, memberId)
      if (task) runner.deliver(team, task)
      else runner.wake?.(memberId)
    }
  }
  /**
   * Count one bot-to-bot mention against the group, and pause the group when the chain reaches `TEAM_HOP_LIMIT`. Speaking by
   * the person resets the count, and the person's own mentions are never suppressed: a manual pause is meant to stop the bots,
   * not the person, who can always name someone.
   * @returns whether the mention wakes nobody, because the group is paused.
   */
  private hop(teamId: string, from: string, mentions: readonly string[]): boolean {
    const team = this.teamOf(teamId)
    // The person is what the hop chain is measured from, and can name anyone even while the group is paused.
    if (this.superagent(from)?.role === 'human') return false
    if (team.paused) return true
    if (!mentions.some(memberId => this.superagent(memberId)?.role !== 'human')) return false
    const hops = (team.hops ?? 0) + 1
    if (hops < TEAM_HOP_LIMIT) { this.repo.team.teams.save({ ...team, hops }); return false }
    const at = this.now()
    const paused = { ...team, hops, paused: { at, reason: 'hops' as const } }
    this.repo.team.teams.save(paused)
    this.repo.team.messages.save({ id: key('team-message', teamId, 'notice', at, 'hops'), teamId, from: 'system',
      text: `The bots have mentioned each other ${hops} times without you speaking, so this group is paused. Say something to continue.`,
      at, kind: 'notice' })
    this.emit('team.paused', { teamId, reason: 'hops' })
    return true
  }
  /** Pause a group by hand: its messages are still recorded, but its mentions wake nobody until it is resumed. */
  pause(teamId: string): Team {
    const team = this.teamOf(teamId)
    if (team.paused) return team
    const paused = { ...team, paused: { at: this.now(), reason: 'manual' as const } }
    this.repo.team.teams.save(paused)
    this.emit('team.paused', { teamId, reason: 'manual' })
    return paused
  }
  /** Resume a paused group, whichever way it paused, and clear its mention chain. @throws UserError when no such team exists. */
  resume(teamId: string): Team {
    const team = this.teamOf(teamId)
    if (!team.paused) return { ...team, hops: 0 }
    const resumed: Team = { ...team, hops: 0 }
    delete resumed.paused
    this.repo.team.teams.save(resumed)
    this.emit('team.resumed', { teamId })
    return resumed
  }
  /**
   * The mentions waiting for a bot, oldest first, and the ones its last batch already carried. What the runner reads to build
   * one batch, and what the panel shows as "queued".
   */
  inbox(botId: string, state: 'pending' | 'delivered' = 'pending'): InboxItem[] { return this.repo.team.inbox.list(botId, state) }
  /**
   * Take a bot's pending mentions as one batch: read them, group them by team, and mark them delivered. The runner then
   * prompts the bot once with the batch, rather than once per message.
   *
   * @returns the batch, or undefined when nothing is waiting.
   */
  takeBatch(botId: string): InboxBatch | undefined { return this.batchOf(botId) }
  /**
   * Mark a batch's mentions delivered, and advance the bot's read cursor in each group to the newest message it carried.
   * @throws UserError when the batch is empty.
   */
  deliverBatch(botId: string, batch: InboxBatch): void {
    const at = this.now()
    for (const group of batch.teams) {
      for (const item of group.mentions) {
        const item_ = this.repo.team.inbox.list(botId, 'pending').find(pending => pending.messageId === item.id)
        if (item_) this.repo.team.inbox.save({ ...item_, state: 'delivered', batchId: batch.batchId })
      }
      const newest = group.context.at(-1)?.at ?? group.mentions.at(-1)?.at
      if (newest) this.repo.team.cursors.save({ teamId: group.teamId, memberId: botId, readAt: newest })
    }
    this.emit('team.inbox.delivered', { botId, batchId: batch.batchId, messageIds: batch.teams.flatMap(group => group.mentions.map(item => item.id)) })
  }
  /** Whether a member has a running turn, and the task it runs. */
  private currentTask(teamId: string, memberId: string): TeamTask | undefined {
    return this.tasks(teamId).find(task => task.assigneeId === memberId && task.state === 'working' && task.turn && task.turn.state !== 'ended')
  }

  // The dispatch state machine

  /**
   * Record a proposed division: one task per member, each with its text, the members it waits on, and the deliverables it
   * declares. Tasks are `proposed`, not yet dispatched. @throws UserError when the team is unknown or closed, or a task names an
   * unknown or non-member assignee.
   */
  propose(teamId: string, specs: readonly { assigneeId: string; text: string; after?: string[]; outputs?: string[] }[]): TeamTask[] {
    const team = this.teamOf(teamId)
    if (!openTeam(team)) throw new UserError('teamClosed')
    const at = this.now()
    const tasks = specs.map(spec => {
      if (!team.memberIds.includes(spec.assigneeId)) throw new UserError('notAMember', { member: spec.assigneeId })
      const after = (spec.after ?? []).filter(id => id !== spec.assigneeId && team.memberIds.includes(id))
      return { id: key('team-task', teamId, spec.assigneeId, at, spec.text), teamId, assigneeId: spec.assigneeId, text: spec.text,
        state: 'proposed' as const, after, outputs: [...(spec.outputs ?? [])], createdAt: at }
    })
    for (const task of tasks) this.repo.team.tasks.save(task)
    this.emit('team.tasks.proposed', { teamId, taskIds: tasks.map(task => task.id) })
    return tasks
  }
  /**
   * Move a team's proposed tasks to `waiting` or `working` and start the ones ready: a task with no `after` starts now, one
   * with `after` waits, and a cycle in the dependency graph fails at once rather than waiting forever. A member already
   * running a task queues behind it. @throws UserError when the team is unknown or closed, or has no proposed tasks.
   */
  dispatch(teamId: string): TeamTask[] {
    const team = this.teamOf(teamId)
    if (!openTeam(team)) throw new UserError('teamClosed')
    const tasks = this.tasks(teamId)
    const open = tasks.filter(task => task.state === 'proposed' || task.state === 'waiting')
    if (!open.length) throw new UserError('noProposedTasks')
    const cyclic = inCycle(open)
    for (const task of open.filter(task => cyclic.has(task.id))) {
      this.fail(teamId, task.id, 'The division has tasks waiting on each other')
    }
    const rest = open.filter(task => !cyclic.has(task.id))
    for (const task of rest) if (task.state === 'proposed' && task.after.length) this.set(teamId, task.id, { state: 'waiting' })
    for (const task of rest) if (task.state === 'proposed' && !task.after.length) this.start(team, task)
    this.advance(team, tasks)
    return this.tasks(teamId)
  }
  /**
   * Start the waiting tasks whose `after` tasks are all done, and the queued tasks whose member is free. It repeats until
   * nothing more can start.
   */
  private advance(team: Team, tasks: TeamTask[]): void {
    for (;;) {
      const current = this.tasks(team.id)
      let moved = false
      for (const task of current) {
        if (task.state !== 'waiting') continue
        const waitingOn = current.filter(item => task.after.includes(item.assigneeId))
        if (waitingOn.some(item => item.state === 'failed')) { this.fail(team.id, task.id, `It waited on a task that failed`); moved = true; continue }
        if (waitingOn.some(item => item.state !== 'done')) continue
        if (busy(team, current, task.assigneeId)) continue
        this.start(team, task); moved = true
      }
      if (!moved) return
    }
  }
  /** Start a task's superagent turn: create the turn, queue the launch, and emit `team.task.dispatched`. */
  private start(team: Team, task: TeamTask): void {
    const at = this.now()
    const turn: SuperagentTurn = { id: key('superagent-turn', task.id), state: 'pending', createdAt: at }
    this.set(team.id, task.id, { state: 'working', turn })
    this.emit('team.task.dispatched', { teamId: team.id, taskId: task.id })
    this.runner().start(team, this.requireTask(team.id, task.id))
  }
  /** The runner's fact that a task's turn runs. */
  superagentStarted(teamId: string, taskId: string): void {
    const task = this.requireTask(teamId, taskId)
    if (!task.turn || task.turn.state !== 'pending') return
    task.turn.state = 'running'
    task.turn.startedAt = this.now()
    this.save(teamId, task)
  }
  /** The runner's fact that a team's messages reached a running turn. */
  superagentDelivered(teamId: string, taskId: string): void {
    const task = this.requireTask(teamId, taskId)
    if (!task.turn || task.turn.state === 'ended') return
    task.turn.deliveredAt ??= this.now()
    this.save(teamId, task)
  }
  /** The runner's fact that a task's turn ended without a report. */
  superagentTurnEnded(teamId: string, taskId: string): void {
    const task = this.requireTask(teamId, taskId)
    if (!task.turn || task.turn.state === 'ended') return
    task.turn.state = 'ended'
    task.turn.endedAt = this.now()
    this.save(teamId, task)
  }
  /** The runner's fact that a task's turn failed; the task fails with the error. */
  superagentFailed(teamId: string, taskId: string, error: string): void {
    this.fail(teamId, taskId, error)
  }
  /**
   * Record a task's outcome from its assignee: `done` with its declared outputs, or `failed` with a reason. Ends the turn,
   * advances the team, and emits the outcome. @throws UserError when the task is unknown, ended, or not working.
   */
  report(taskId: string, report: { state: 'done' | 'failed' | 'waiting'; summary: string; outputs?: string[] }): TeamTask {
    const task = this.taskOf(taskId)
    if (task.state !== 'working' || !task.turn || task.turn.state === 'ended') throw new UserError('taskNotWorking')
    if (report.state !== 'waiting' && task.outputs.length && !report.outputs?.length) throw new UserError('outputsMissing')
    const at = this.now()
    task.turn.state = 'ended'; task.turn.endedAt = at
    task.turn.report = { state: report.state, summary: report.summary, at }
    if (report.state === 'waiting') { this.save(task.teamId, task); return task }
    task.state = report.state
    task.report = report.summary
    if (report.state === 'done' && report.outputs) task.outputs = [...report.outputs]
    if (report.state === 'failed') task.reason = report.summary
    this.save(task.teamId, task)
    this.emit(report.state === 'done' ? 'team.task.done' : 'team.task.failed', { teamId: task.teamId, taskId, ...report.state === 'failed' ? { reason: report.summary } : {} })
    this.advance(this.teamOf(task.teamId)!, this.tasks(task.teamId))
    return task
  }
  /** Mark a task failed with `reason`, ending its turn if it runs. */
  private fail(teamId: string, taskId: string, reason: string): void {
    const task = this.requireTask(teamId, taskId)
    if (task.state === 'done' || task.state === 'failed') return
    if (task.turn && task.turn.state !== 'ended') { task.turn.state = 'ended'; task.turn.endedAt = this.now() }
    task.state = 'failed'; task.reason = reason
    this.save(teamId, task)
    this.emit('team.task.failed', { teamId, taskId, reason })
  }

  // Closing

  /**
   * Close a round: the lead records its closing decision, the team closes, and its turn ends. @throws UserError when the team
   * is unknown or already closed.
   */
  close(teamId: string, by: string, summary: string): TeamMessage {
    const team = this.teamOf(teamId)
    if (!openTeam(team)) throw new UserError('teamClosed')
    const at = this.now()
    const message = this.sendMessage(teamId, by, summary, 'decision')
    const closed = { ...team, closed: { at, by, summary } }
    this.repo.team.teams.save(closed)
    for (const task of this.tasks(teamId)) if (task.turn && task.turn.state !== 'ended') this.runner().stop(closed, task, 'The team closed')
    this.emit('team.closed', { teamId, by })
    return message
  }

  // Delegation

  /**
   * Delegate concrete implementation to a worker by creating a Ticket under a team mandate. The mandate names the team, the
   * task and the lead who authorized it; it holds while the team is open and the task belongs to it. @throws UserError when
   * the team or task is unknown, the task is not working, the team is closed, or the lead is unknown.
   */
  delegate(teamId: string, taskId: string, text: string, name: string, outputs?: string[]): { ticketId: string; outputs: string[] } {
    const team = this.teamOf(teamId)
    if (!openTeam(team)) throw new UserError('teamClosed')
    const task = this.requireTask(teamId, taskId)
    if (task.state !== 'working') throw new UserError('taskNotWorking')
    const lead = team.leadId === undefined ? undefined : this.superagent(team.leadId)
    if (!lead) throw new UserError('unknownSuperagent', { superagent: team.leadId ?? '' })
    const basis = { via: 'team' as const, team: team.id, task: task.id, lead: { source: 'team', id: lead.id } }
    const at = this.now()
    const ticketId = key('ticket', 'team', team.id, task.id, at)
    const delegation = { team: team.id, task: task.id, lead: lead.id, name, text, outputs: [...(outputs ?? [])], at }
    const ticket = this.tickets.createDelegated(ticketId, { strength: 'explicit' as const, policyVersion: this.policy().version,
      basis, actor: { source: 'team', id: lead.id }, scope: text }, delegation, at)
    this.emit('ticket.created', { ticketId, decisionId: '', strength: 'explicit' })
    return { ticketId, outputs: delegation.outputs }
  }

  // Helpers

  /**
   * Build the batch of mentions waiting for a bot: everything pending, oldest first, cut at `BATCH_MENTIONS`, grouped by the
   * group it came from, with the talk each group had since the bot last read it so a mention arrives with its context.
   * @returns the batch, or undefined when nothing is waiting.
   */
  private batchOf(botId: string): InboxBatch | undefined {
    const pending = this.repo.team.inbox.list(botId, 'pending')
    if (!pending.length) return undefined
    const batchId = key('team-batch', botId, pending[0]!.at, String(pending.length))
    const byTeam = new Map<string, InboxItem[]>()
    for (const item of pending.slice(0, BATCH_MENTIONS)) byTeam.set(item.teamId, [...(byTeam.get(item.teamId) ?? []), item])
    const teams = [...byTeam].map(([teamId, items]) => {
      const team = this.repo.team.teams.get(teamId)
      const readAt = this.repo.team.cursors.get(teamId, botId)?.readAt ?? ''
      const unread = this.repo.team.messages.list(teamId).filter(message => message.at > readAt && !items.some(item => item.messageId === message.id))
      const omitted = Math.max(0, unread.length - BATCH_CONTEXT)
      const context = unread.slice(-BATCH_CONTEXT)
      return { teamId, teamName: team?.name ?? teamId, ...omitted ? { omitted } : {}, context,
        mentions: items.map(item => this.repo.team.messages.get(item.messageId)).filter((message): message is TeamMessage => message !== undefined) }
    }).filter(group => group.mentions.length)
    return teams.length ? { botId, batchId, teams } : undefined
  }
  private runner(): SuperagentRunner { return this.options.superagent ?? NOOP_SUPERAGENT }
  private teamOf(teamId: string): Team { const team = this.repo.team.teams.get(teamId); if (!team) throw new UserError('unknownTeam'); return team }
  private taskOf(taskId: string): TeamTask { const task = this.repo.team.tasks.get(taskId); if (!task) throw new UserError('unknownTask'); return task }
  private requireTask(teamId: string, taskId: string): TeamTask {
    const task = this.repo.team.tasks.get(taskId)
    if (!task || task.teamId !== teamId) throw new UserError('unknownTask')
    return task
  }
  private save(teamId: string, task: TeamTask): void { task.updatedAt ??= this.now(); this.repo.team.tasks.save(task) }
  private set(teamId: string, taskId: string, change: Partial<TeamTask>): void {
    const task = this.requireTask(teamId, taskId)
    this.repo.team.tasks.save({ ...task, ...change })
  }
}

/**
 * The ids of the tasks of a division that wait on each other in a cycle. A task's `after` names the members it waits on, so a
 * member maps to the one task of a division that member carries. A task that only waits on a task in a cycle is not itself in
 * one; it fails when the task it waits on fails, in `Teams.advance`.
 */
export function inCycle(tasks: readonly TeamTask[]): Set<string> {
  const byMember = new Map(tasks.map(task => [task.assigneeId, task]))
  const inCycleIds = new Set<string>()
  const visiting = new Set<string>()
  const visit = (task: TeamTask, path: string[]): void => {
    if (inCycleIds.has(task.id)) return
    if (visiting.has(task.id)) { for (const id of path.slice(path.indexOf(task.id))) inCycleIds.add(id); return }
    visiting.add(task.id)
    const next = path.concat(task.id)
    for (const memberId of task.after) {
      const after = byMember.get(memberId)
      if (after && after.id !== task.id) visit(after, next)
    }
    visiting.delete(task.id)
  }
  for (const task of tasks) visit(task, [])
  return inCycleIds
}

/** The reason a team task failed, as a `Reason` the panel can word. */
export const taskReason = (reason: string): Reason => ({ code: 'teamTaskFailed', values: { reason } })
/** A change to a superagent: a field left out is kept, and `null` clears an optional one. */
export interface SuperagentChange { name?: string; capabilities?: string[] | null; persona?: string | null;
  skills?: string[] | null; directory?: string | null; repository?: string | null; feishuCli?: string | null;
  disabled?: { at: string; by: string } | null }
/** What a `sendMessage` may carry besides its text and kind. */
export interface SendOptions { mentions?: readonly string[]; replyTo?: string; taskId?: string; triggerId?: string }
/** The most mentions one batch carries; the rest wait for the next batch, oldest first. */
export const BATCH_MENTIONS = 40
/** The most messages of a group's talk a batch brings as context around that group's mentions. */
export const BATCH_CONTEXT = 15
/** One group's part of a batch: what it said since the bot last read it, and the messages that mentioned the bot. */
export interface InboxBatchGroup { teamId: string; teamName: string; omitted?: number; context: TeamMessage[]; mentions: TeamMessage[] }
/** Everything waiting for one bot, taken together so one bot reads one batch whatever happened across its groups. */
export interface InboxBatch { botId: string; batchId: string; teams: InboxBatchGroup[] }
