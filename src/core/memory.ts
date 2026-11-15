/** In-memory repository implementation for testing and ephemeral engine instances. */
import { latestAssignment, type Decision, type Superagent, type Team, type TeamMessage, type TeamTask, type Thread, type Ticket, type Trigger,
  type TriggerDisposition } from './model.ts'
import type { Repositories } from './ports.ts'

const clone = <T>(value: T): T => structuredClone(value)
/**
 * In-memory implementation of the Repositories port backed by cloned Map entries so caller mutations do not affect stored state.
 * Provides snapshot-based atomic rollback and matches the ordering semantics of the SQLite store for Engine tests.
 */
export class MemoryRepositories implements Repositories {
  private readonly triggerRows = new Map<string, Trigger>()
  private readonly dispositions = new Map<string, TriggerDisposition>()
  private readonly threadRows = new Map<string, Thread>()
  private readonly ticketRows = new Map<string, Ticket>()
  private readonly decisionRows = new Map<string, Decision>()
  private readonly superagentRows = new Map<string, Superagent>()
  private readonly teamRows = new Map<string, Team>()
  private readonly teamMessageRows = new Map<string, TeamMessage>()
  private readonly teamTaskRows = new Map<string, TeamTask>()
  atomic<T>(work: () => T): T {
    const maps: Map<string, unknown>[] = [this.triggerRows, this.dispositions, this.threadRows, this.ticketRows, this.decisionRows,
      this.superagentRows, this.teamRows, this.teamMessageRows, this.teamTaskRows]
    const snapshot = maps.map(map => new Map(map))
    try { return work() }
    catch (error) {
      maps.forEach((map, index) => { map.clear(); for (const [id, value] of snapshot[index]!) map.set(id, value) })
      throw error
    }
  }
  readonly triggers = {
    get: (id: string) => clone(this.triggerRows.get(id)),
    save: (trigger: Trigger) => { this.triggerRows.set(trigger.id, clone(trigger)) },
    disposition: (id: string) => clone(this.dispositions.get(id)),
    saveDisposition: (id: string, value: TriggerDisposition) => { this.dispositions.set(id, clone(value)) },
  }
  readonly threads = {
    get: (key: string) => clone(this.threadRows.get(key)),
    save: (thread: Thread) => { this.threadRows.set(thread.key, clone(thread)) },
    list: () => [...this.threadRows.values()].map(clone),
    active: () => this.threads.list().filter(thread => thread.pending.length > 0 || thread.evaluating !== undefined),
  }
  readonly tickets = {
    get: (id: string) => clone(this.ticketRows.get(id)),
    save: (ticket: Ticket) => { this.ticketRows.set(ticket.id, clone(ticket)) },
    /** Newest first, matching the SQLite Store's order. */
    list: () => [...this.ticketRows.values()].reverse().map(clone),
    open: () => this.tickets.list().filter(ticket => !ticket.ended),
    active: () => this.tickets.list().filter(ticket => ticket.undelivered.length > 0 || ['pending', 'running'].includes(latestAssignment(ticket)?.state ?? '')),
  }
  readonly decisions = {
    get: (id: string) => clone(this.decisionRows.get(id)),
    save: (decision: Decision) => { this.decisionRows.set(decision.id, clone(decision)) },
    byThread: (key: string) => [...this.decisionRows.values()].filter(decision => decision.threadKey === key).map(clone),
  }
  readonly team = {
    superagents: {
      get: (id: string) => clone(this.superagentRows.get(id)),
      save: (value: Superagent) => { this.superagentRows.set(value.id, clone(value)) },
      list: () => [...this.superagentRows.values()].map(clone),
    },
    teams: {
      get: (id: string) => clone(this.teamRows.get(id)),
      save: (value: Team) => { this.teamRows.set(value.id, clone(value)) },
      list: () => [...this.teamRows.values()].map(clone),
    },
    messages: {
      get: (id: string) => clone(this.teamMessageRows.get(id)),
      save: (value: TeamMessage) => { this.teamMessageRows.set(value.id, clone(value)) },
      list: (teamId: string) => [...this.teamMessageRows.values()].filter(message => message.teamId === teamId).map(clone),
    },
    tasks: {
      get: (id: string) => clone(this.teamTaskRows.get(id)),
      save: (value: TeamTask) => { this.teamTaskRows.set(value.id, clone(value)) },
      list: (teamId: string) => [...this.teamTaskRows.values()].filter(task => task.teamId === teamId).map(clone),
    },
  }
}
