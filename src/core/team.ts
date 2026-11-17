/** Teams: the team of superagents — identities, conversations, tasks, and the dispatch state machine. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { openTeam, superagentActive } from './model.ts'
import type { Superagent, SuperagentTurn, Team, TeamMessage, TeamMessageKind, TeamTask } from './model.ts'
import type { Reason } from './reasons.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { SuperagentRunner } from './ports.ts'
import type { Tickets } from './tickets.ts'

const busy = (team: Team, tasks: TeamTask[], memberId: string): boolean =>
  tasks.some(task => task.assigneeId === memberId && task.state === 'working' && task.turn && task.turn.state !== 'ended')
/** A SuperagentRunner that does nothing, for an Engine that never dispatches a team. */
const NOOP_SUPERAGENT: SuperagentRunner = { start() {}, deliver() {}, stop() {} }

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
    return value
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
    if (change.disabled === null) delete next.disabled
    else if (change.disabled) next.disabled = change.disabled
    this.repo.team.superagents.save(next)
    this.emit('superagent.updated', { superagentId: id })
    return next
  }
  /** Every superagent identity, oldest first. */
  superagents(): Superagent[] { return this.repo.team.superagents.list() }
  /** Create a team conversation. @throws UserError when the id is taken, a member is unknown, or a group has no lead in it. */
  addTeam(team: Team): Team {
    const at = this.now()
    if (this.repo.team.teams.get(team.id)) throw new UserError('teamExists')
    for (const memberId of team.memberIds) if (!this.repo.team.superagents.get(memberId)) throw new UserError('unknownSuperagent', { superagent: memberId })
    if (team.kind === 'group' && (team.leadId === undefined || !team.memberIds.includes(team.leadId))) throw new UserError('teamLeadMissing')
    const value = { ...team, createdAt: team.createdAt || at }
    this.repo.team.teams.save(value)
    this.emit('team.created', { teamId: value.id })
    return value
  }
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
   * Record a message on a team and deliver it to every member whose turn runs. A group message reaches all members; a direct
   * message reaches the recipient and the sender. `taskId` names the task a task or report message carries.
   * @throws UserError when the team or sender is unknown, or the sender is not a member.
   */
  sendMessage(teamId: string, from: string, text: string, kind: TeamMessageKind, taskId?: string, triggerId?: string): TeamMessage {
    const team = this.teamOf(teamId)
    if (!team.memberIds.includes(from)) throw new UserError('notAMember', { member: from })
    const at = this.now()
    const message: TeamMessage = { id: key('team-message', teamId, from, at, kind, text, ...taskId ? [taskId] : [], ...triggerId ? [triggerId] : []), teamId, from, text, at, kind, ...taskId ? { taskId } : {}, ...triggerId ? { triggerId } : {} }
    this.repo.team.messages.save(message)
    this.emit('team.message', { messageId: message.id, teamId })
    const runner = this.runner()
    for (const memberId of team.kind === 'direct' ? [from, ...team.memberIds.filter(id => id !== from)] : team.memberIds) {
      if (memberId === from) continue
      const member = this.superagent(memberId)
      // The lead is the main Session, not a superagent Session, so talk never starts one for it.
      if (!member || !superagentActive(member) || member.role === 'lead' || memberId === team.leadId) continue
      // A working turn reads the message with its task. An idle member gets it as talk, which does not start a task, so a
      // question does not have to be wrapped as one.
      const task = this.currentTask(teamId, memberId)
      if (task) runner.deliver(team, task)
      else runner.talk?.(team, memberId, message)
    }
    return message
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
  skills?: string[] | null; directory?: string | null; disabled?: { at: string; by: string } | null }
