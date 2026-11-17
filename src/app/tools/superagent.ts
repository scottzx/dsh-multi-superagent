/** Team tools: the lead proposes, dispatches and closes a division; a specialist reports, talks and delegates. */
import { z } from 'zod'
import { type EngineForLead, type EngineForSpecialist, type Superagent } from '../../core/index.ts'
import type { Store } from '../store.ts'
import { tool, type Tool } from './tool.ts'

/** The lead's team tools read the team through the Engine and its stores. */
export interface LeadTeamToolsHost {
  readonly engine: EngineForLead
  readonly store: Pick<Store, 'team'>
  /** The superagent identity of the main Session, which is the team's lead. */
  readonly leadId: string
}
/** A specialist superagent's team tools read its task and the team through the Engine. */
export interface SuperagentToolsHost {
  readonly engine: EngineForSpecialist
  readonly store: Pick<Store, 'team'>
  readonly superagent: Superagent
}

const MemberSchema = z.string().trim().min(1).max(200)
const CapabilitySchema = z.string().trim().min(1).max(200)
const TeamNameSchema = z.string().trim().min(1).max(160)
/** A superagent's project directory: an absolute path the lead binds to it, so it runs in its own checkout. */
const DirectorySchema = z.string().trim().min(1).max(1000).optional()
const PersonaSchema = z.string().trim().min(1).max(4000)
const SkillSchema = z.string().trim().min(1).max(80)
const TaskSpecSchema = z.object({
  assignee_id: MemberSchema,
  text: z.string().trim().min(1).max(4000),
  after: z.array(MemberSchema).max(16).optional(),
  outputs: z.array(z.string().trim().min(1).max(500)).max(32).optional(),
}).strict()

/** A team's state as the lead reads it: the team, its tasks and its messages, newest last. */
function teamState(store: Pick<Store, 'team'>, teamId: string) {
  const team = store.team.teams.get(teamId)
  if (!team) return undefined
  return { team, tasks: store.team.tasks.list(teamId), messages: store.team.messages.list(teamId) }
}
/**
 * The identity a lead tool writes as. The main Session is the team's lead, but its session id is not a team member, so a
 * message or a close is recorded as the team's `leadId`. A direct conversation has no lead: the other member is the recipient.
 */
function voiceOf(store: Pick<Store, 'team'>, teamId: string, sessionId: string): string {
  const team = store.team.teams.get(teamId)
  if (!team) return sessionId
  if (team.memberIds.includes(sessionId)) return sessionId
  if (team.leadId && team.memberIds.includes(team.leadId)) return team.leadId
  const other = team.memberIds.find(id => id !== sessionId)
  return other ?? sessionId
}

/**
 * The lead's tools for a team of superagents: register a superagent, create a team conversation, propose a division, dispatch
 * it, talk to the team, close a round, and read a team's state. The lead stays the admission authority: these tools never
 * admit a candidate or create a Ticket; delegation to a worker is a specialist's tool.
 */
export function leadTeamTools(host: LeadTeamToolsHost): Tool[] {
  const { engine, store, leadId } = host
  return [
    tool({
      name: 'lead_team_create_superagent',
      description: 'Register a superagent, with optional capabilities, persona, skills and project directory.',
      schema: z.object({ id: MemberSchema, name: z.string().trim().min(1).max(160), role: z.enum(['lead', 'specialist']),
        capabilities: z.array(CapabilitySchema).max(16).optional(), persona: PersonaSchema.optional(),
        skills: z.array(SkillSchema).max(16).optional(), directory: DirectorySchema }).strict(),
      execute: async args => {
        const superagent = engine.addSuperagent({ id: args.id, name: args.name, role: args.role, ...args.capabilities ? { capabilities: args.capabilities } : {},
          ...args.persona ? { persona: args.persona } : {}, ...args.skills ? { skills: args.skills } : {},
          ...args.directory ? { directory: args.directory } : {}, createdAt: '' })
        return { superagent }
      },
    }),
    tool({
      name: 'lead_team_list_superagents',
      description: 'List every superagent identity: its role, capabilities, persona, skills, directory and whether it is disabled.',
      schema: z.object({}).strict(),
      execute: async () => ({ superagents: engine.superagents() }),
    }),
    tool({
      name: 'lead_team_update_superagent',
      description: 'Change a superagent. A field left out is kept; null clears capabilities, persona, skills or directory.',
      schema: z.object({ id: MemberSchema, name: z.string().trim().min(1).max(160).optional(),
        capabilities: z.array(CapabilitySchema).max(16).nullable().optional(), persona: PersonaSchema.nullable().optional(),
        skills: z.array(SkillSchema).max(16).nullable().optional(), directory: z.string().trim().min(1).max(1000).nullable().optional(),
        disabled: z.boolean().optional() }).strict(),
      execute: async args => {
        const superagent = engine.updateSuperagent(args.id, { ...args.name !== undefined ? { name: args.name } : {},
          ...args.capabilities !== undefined ? { capabilities: args.capabilities } : {},
          ...args.persona !== undefined ? { persona: args.persona } : {},
          ...args.skills !== undefined ? { skills: args.skills } : {},
          ...args.directory !== undefined ? { directory: args.directory ?? null } : {},
          ...args.disabled === undefined ? {} : { disabled: args.disabled ? { at: new Date().toISOString(), by: leadId } : null } })
        return { superagent }
      },
    }),
    tool({
      name: 'lead_team_create',
      description: 'Create a team: a group of superagents, or a direct conversation between two.',
      schema: z.object({ id: MemberSchema, name: TeamNameSchema, kind: z.enum(['group', 'direct']), member_ids: z.array(MemberSchema).min(1).max(16),
        lead_id: MemberSchema.optional() }).strict(),
      execute: async args => {
        const team = engine.addTeam({ id: args.id, name: args.name, kind: args.kind, memberIds: args.member_ids,
          ...args.lead_id ? { leadId: args.lead_id } : {}, createdAt: '' })
        return { team }
      },
    }),
    tool({
      name: 'lead_team_propose',
      description: 'Propose a division: one task per superagent, with what it does, what it waits on, and its deliverables.',
      schema: z.object({ team_id: MemberSchema, tasks: z.array(TaskSpecSchema).min(1).max(16) }).strict(),
      execute: async args => {
        const tasks = engine.proposeTeam(args.team_id, args.tasks.map(item => ({ assigneeId: item.assignee_id, text: item.text,
          ...item.after ? { after: item.after } : {}, ...item.outputs ? { outputs: item.outputs } : {} })))
        return { team_id: args.team_id, tasks }
      },
    }),
    tool({
      name: 'lead_team_dispatch',
      description: 'Start ready tasks now and return. Do not wait for reports.',
      schema: z.object({ team_id: MemberSchema }).strict(),
      execute: async args => {
        const tasks = engine.dispatchTeam(args.team_id)
        const started = tasks.filter(task => task.state === 'working' || task.state === 'waiting')
        return { team_id: args.team_id, started: started.length,
          tasks: tasks.map(task => ({ task_id: task.id, assignee_id: task.assigneeId, state: task.state,
            ...task.reason ? { reason: task.reason } : {} })) }
      },
    }),
    tool({
      name: 'lead_team_message',
      description: 'Send a line to a team, as its lead.',
      schema: z.object({ team_id: MemberSchema, text: z.string().trim().min(1).max(4000) }).strict(),
      execute: async args => {
        const message = engine.sendTeamMessage(args.team_id, voiceOf(store, args.team_id, leadId), args.text, 'discussion')
        return { team_id: args.team_id, message_id: message.id, from: message.from }
      },
    }),
    tool({
      name: 'lead_team_close',
      description: 'Close a round with the lead decision. The team closes and its turns end.',
      schema: z.object({ team_id: MemberSchema, summary: z.string().trim().min(1).max(4000) }).strict(),
      execute: async args => {
        const message = engine.closeTeam(args.team_id, voiceOf(store, args.team_id, leadId), args.summary)
        return { team_id: args.team_id, message_id: message.id, from: message.from }
      },
    }),
    tool({
      name: 'lead_team_read',
      description: 'Read a team, its tasks and its messages.',
      schema: z.object({ team_id: MemberSchema }).strict(),
      execute: async args => teamState(store, args.team_id) ?? { error: 'Unknown team' },
    }),
    tool({
      name: 'lead_team_wait',
      description: 'Read reports already in. Do not call this to wait.',
      schema: z.object({ team_id: MemberSchema }).strict(),
      execute: async args => {
        const state = teamState(store, args.team_id)
        if (!state) return { error: 'Unknown team' }
        const open = state.tasks.filter(task => task.state === 'proposed' || task.state === 'waiting' || task.state === 'working')
        return { team_id: args.team_id, open: open.length, tasks: state.tasks.map(task => ({ task_id: task.id, assignee_id: task.assigneeId,
          state: task.state, ...task.report ? { summary: task.report } : {}, ...task.reason ? { reason: task.reason } : {},
          ...task.outputs.length ? { outputs: task.outputs } : {} })) }
      },
    }),
  ]
}

/**
 * A specialist superagent's tools for its team: report its task, talk to the team or its other superagent, delegate concrete
 * implementation to a worker under the team mandate, and read the team's state.
 */
export function superagentTools(host: SuperagentToolsHost): Tool[] {
  const { engine, store, superagent } = host
  return [
    tool({
      name: 'superagent_team_report',
      description: 'Report your task once: done with the deliverables it declared, failed with the reason, or waiting while you continue. This is the handoff to the lead.',
      schema: z.object({ task_id: MemberSchema, state: z.enum(['done', 'failed', 'waiting']), summary: z.string().trim().min(1).max(4000),
        outputs: z.array(z.string().trim().min(1).max(500)).max(32).optional() }).strict(),
      execute: async args => {
        const task = engine.reportTeamTask(args.task_id, { state: args.state, summary: args.summary, ...args.outputs ? { outputs: args.outputs } : {} })
        return { task_id: task.id, state: task.state, reason: task.reason }
      },
    }),
    tool({
      name: 'superagent_team_message',
      description: 'Send a line to your team, or to the other superagent in a direct conversation. Keep it short and about the work.',
      schema: z.object({ team_id: MemberSchema, text: z.string().trim().min(1).max(4000) }).strict(),
      execute: async args => {
        const message = engine.sendTeamMessage(args.team_id, superagent.id, args.text, 'discussion')
        return { team_id: args.team_id, message_id: message.id }
      },
    }),
    tool({
      name: 'superagent_delegate',
      description: 'Delegate concrete implementation to a worker: create a Ticket under the team mandate, which a worker executes and reports back. Only while your task is working.',
      schema: z.object({ team_id: MemberSchema, task_id: MemberSchema, text: z.string().trim().min(1).max(4000),
        name: z.string().trim().min(1).max(160).describe('A short English worktree name for the worker.'),
        outputs: z.array(z.string().trim().min(1).max(500)).max(32).optional() }).strict(),
      execute: async args => {
        const result = engine.delegateTeamWork(args.team_id, args.task_id, args.text, args.name, args.outputs)
        return { ticket_id: result.ticketId, outputs: result.outputs }
      },
    }),
    tool({
      name: 'superagent_team_read',
      description: 'Read your team\'s state: the team, its tasks and its messages.',
      schema: z.object({ team_id: MemberSchema }).strict(),
      execute: async args => teamState(store, args.team_id) ?? { error: 'Unknown team' },
    }),
  ]
}
