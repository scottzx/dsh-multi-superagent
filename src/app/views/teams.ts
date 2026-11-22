/** Team views: the list of team conversations and one team's tasks and messages. */
import type { Team, TeamMessage, TeamMessageKind, TeamTask, TeamTaskState } from '../../core/index.ts'
import type { Store } from '../store.ts'

/** A superagent identity as the panel shows it. */
export interface SuperagentRow { id: string; name: string; role: string; builtin?: boolean; /** Its bound project directory, when one was set. */ directory?: string;
  capabilities?: string[]; persona?: string; skills?: string[]; repository?: string; feishuCli?: string; disabled?: { at: string; by: string } }
/** A team's tasks by state, for the list row's counts. */
export interface TeamCounts { proposed: number; waiting: number; working: number; done: number; failed: number }
/** A team as the panel lists it. */
export interface TeamSummary {
  id: string
  name: string
  kind: Team['kind']
  members: SuperagentRow[]
  leadId?: string
  closed?: { at: string; by: string; summary: string }
  counts: TeamCounts
  /** Why the group stopped waking members, when it did. */
  paused?: { at: string; reason: 'hops' | 'manual' }
  /** How many times the bots have mentioned each other since the person last spoke. */
  hops?: number
}
/** A team task as the panel shows it. */
export interface TeamTaskRow {
  id: string
  assigneeId: string
  assigneeName: string
  text: string
  state: TeamTaskState
  /** The member ids this task waits on. */
  after: string[]
  outputs: string[]
  report?: string
  reason?: string
  createdAt: string
  updatedAt?: string
}
/** A team message as the panel shows it. */
export interface TeamMessageRow { id: string; from: string; fromName: string; text: string; at: string; kind: TeamMessageKind; taskId?: string;
  /** The superagents this message woke, which is what makes it different from a line nobody must answer. */
  mentions?: string[]; replyTo?: string }
/** The messages of one team after a point, for the chat's incremental pull. */
export interface TeamMessagesView { messages: TeamMessageRow[] }
/** What a member is doing, as the chat shows it beside its name. */
export interface MemberStatusRow { id: string; state: 'idle' | 'queued' | 'working'; /** The mentions waiting for it, which is what `queued` counts. */ queued: number }
/** The list of a deployment's team conversations. */
export interface TeamListView { teams: TeamSummary[] }
/** One team's state: its summary, its tasks, its messages, and what each of its superagents is doing. */
export interface TeamDetailView { team: TeamSummary; tasks: TeamTaskRow[]; messages: TeamMessageRow[]; statuses: MemberStatusRow[] }

/** The superagent identity's display name, recognizing Bob (the HR orchestrator outside groups) and falling back to its id. */
const name = (store: Store, id: string): string => store.team.superagents.get(id)?.name ?? (id === 'bob' ? 'Bob' : id)
/** A superagent as the panel lists it, keeping only the fields it shows. */
function superagentRow(store: Store, id: string): SuperagentRow {
  const superagent = store.team.superagents.get(id)
  return { id, name: name(store, id), role: superagent?.role ?? 'specialist', ...superagent?.builtin ? { builtin: true } : {},
    ...superagent?.directory ? { directory: superagent.directory } : {},
    ...superagent?.capabilities?.length ? { capabilities: superagent.capabilities } : {}, ...superagent?.persona ? { persona: superagent.persona } : {},
    ...superagent?.skills?.length ? { skills: superagent.skills } : {}, ...superagent?.repository ? { repository: superagent.repository } : {},
    ...superagent?.feishuCli ? { feishuCli: superagent.feishuCli } : {}, ...superagent?.disabled ? { disabled: superagent.disabled } : {} }
}
/** Every superagent identity, oldest first. */
export function superagentList(store: Store): { superagents: SuperagentRow[] } {
  return { superagents: store.team.superagents.list().map(superagent => superagentRow(store, superagent.id)) }
}

function summary(store: Store, team: Team): TeamSummary {
  const counts: TeamCounts = { proposed: 0, waiting: 0, working: 0, done: 0, failed: 0 }
  for (const task of store.team.tasks.list(team.id)) counts[task.state]++
  return { id: team.id, name: team.name, kind: team.kind, members: team.memberIds.map(id => superagentRow(store, id)),
    ...team.leadId ? { leadId: team.leadId } : {}, ...team.closed ? { closed: team.closed } : {}, counts,
    ...team.paused ? { paused: team.paused } : {}, ...team.hops ? { hops: team.hops } : {} }
}

/** Builds the list of a deployment's team conversations, oldest first, with their task counts. */
export function teamList(store: Store): TeamListView {
  return { teams: store.team.teams.list().map(team => summary(store, team)) }
}

/** Builds one team's detail view: its summary, its tasks oldest first and its messages oldest first. */
export function teamDetail(store: Store, id: string): TeamDetailView | undefined {
  const team = store.team.teams.get(id)
  if (!team) return undefined
  return { team: summary(store, team),
    tasks: store.team.tasks.list(team.id).map((task: TeamTask): TeamTaskRow => ({ id: task.id, assigneeId: task.assigneeId,
      assigneeName: name(store, task.assigneeId), text: task.text, state: task.state, after: task.after, outputs: task.outputs,
      ...task.report ? { report: task.report } : {}, ...task.reason ? { reason: task.reason } : {}, createdAt: task.createdAt,
      ...task.updatedAt ? { updatedAt: task.updatedAt } : {} })),
    messages: store.team.messages.list(team.id).map(message => messageRow(store, message)),
    statuses: memberStatuses(store, team.id) }
}

/** One message as the chat shows it. */
function messageRow(store: Store, message: TeamMessage): TeamMessageRow {
  return { id: message.id, from: message.from, fromName: name(store, message.from), text: message.text, at: message.at, kind: message.kind,
    ...message.taskId ? { taskId: message.taskId } : {}, ...message.mentions?.length ? { mentions: message.mentions } : {},
    ...message.replyTo ? { replyTo: message.replyTo } : {} }
}

/** Builds the messages of one team that came after `after`, oldest first, which is how a chat pulls only what it lacks. */
export function teamMessages(store: Store, id: string, after?: string, limit = 200): TeamMessagesView | undefined {
  if (!store.team.teams.get(id)) return undefined
  const messages = store.team.messages.list(id).filter(message => !after || message.at > after)
  return { messages: messages.slice(-limit).map(message => messageRow(store, message)) }
}

/**
 * What each member of a team is doing: a member with a running task is `working`, one with mentions waiting is `queued` with the
 * number waiting, and the rest are `idle`. The person has no Session, so it is left out.
 */
export function memberStatuses(store: Store, id: string): MemberStatusRow[] {
  const team = store.team.teams.get(id)
  if (!team) return []
  return team.memberIds.map(memberId => {
    const superagent = store.team.superagents.get(memberId)
    if (superagent?.role === 'human') return undefined
    const working = store.team.tasks.list(id).some(task => task.assigneeId === memberId && task.state === 'working'
      && !!task.turn && task.turn.state !== 'ended')
    const queued = store.team.inbox.list(memberId, 'pending').length
    return { id: memberId, state: working ? 'working' as const : queued ? 'queued' as const : 'idle' as const, queued }
  }).filter((row): row is MemberStatusRow => row !== undefined)
}
