/** Team views: the list of team conversations and one team's tasks and messages. */
import type { Team, TeamMessage, TeamMessageKind, TeamTask, TeamTaskState } from '../../core/index.ts'
import type { Store } from '../store.ts'

/** A superagent identity as the panel shows it. */
export interface SuperagentRow { id: string; name: string; role: string; /** Its bound project directory, when the lead set one. */ directory?: string;
  capabilities?: string[]; persona?: string; skills?: string[]; disabled?: { at: string; by: string } }
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
export interface TeamMessageRow { id: string; from: string; fromName: string; text: string; at: string; kind: TeamMessageKind; taskId?: string }
/** The list of a deployment's team conversations. */
export interface TeamListView { teams: TeamSummary[] }
/** One team's state: its summary, its tasks and its messages. */
export interface TeamDetailView { team: TeamSummary; tasks: TeamTaskRow[]; messages: TeamMessageRow[] }

/** The superagent identity's display name, falling back to its id. */
const name = (store: Store, id: string): string => store.team.superagents.get(id)?.name ?? id
/** A superagent as the panel lists it, keeping only the fields it shows. */
function superagentRow(store: Store, id: string): SuperagentRow {
  const superagent = store.team.superagents.get(id)
  return { id, name: name(store, id), role: superagent?.role ?? 'specialist', ...superagent?.directory ? { directory: superagent.directory } : {},
    ...superagent?.capabilities?.length ? { capabilities: superagent.capabilities } : {}, ...superagent?.persona ? { persona: superagent.persona } : {},
    ...superagent?.skills?.length ? { skills: superagent.skills } : {}, ...superagent?.disabled ? { disabled: superagent.disabled } : {} }
}
/** Every superagent identity, oldest first. */
export function superagentList(store: Store): { superagents: SuperagentRow[] } {
  return { superagents: store.team.superagents.list().map(superagent => superagentRow(store, superagent.id)) }
}

function summary(store: Store, team: Team): TeamSummary {
  const counts: TeamCounts = { proposed: 0, waiting: 0, working: 0, done: 0, failed: 0 }
  for (const task of store.team.tasks.list(team.id)) counts[task.state]++
  return { id: team.id, name: team.name, kind: team.kind, members: team.memberIds.map(id => superagentRow(store, id)),
    ...team.leadId ? { leadId: team.leadId } : {}, ...team.closed ? { closed: team.closed } : {}, counts }
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
    messages: store.team.messages.list(team.id).map((message: TeamMessage): TeamMessageRow => ({ id: message.id, from: message.from,
      fromName: name(store, message.from), text: message.text, at: message.at, kind: message.kind, ...message.taskId ? { taskId: message.taskId } : {} })) }
}
