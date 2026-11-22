/** Team tools: the lead proposes, dispatches and closes a division; a specialist reports, talks and delegates. */
import { z } from 'zod'
import { ALICE_ID, ALL_HANDS_ID, UserError, superagentActive, type EngineForLead, type EngineForSpecialist, type Superagent } from '../../core/index.ts'
import type { Store } from '../store.ts'
import { tool, type Tool } from './tool.ts'

/** The lead's team tools read the team through the Engine and its stores. */
export interface LeadTeamToolsHost {
  readonly engine: EngineForLead
  readonly store: Pick<Store, 'team'>
  /** The superagent identity of the main Session, which is the team's lead. */
  readonly leadId: string
  /** Provision a specialist's workspace brief and DSH Session so it is immediately ready to open and receive messages. */
  ensureSuperagentSession?(superagent: Superagent): Promise<void>
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
const RepoSchema = z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/)
const PersonaSchema = z.string().trim().min(1).max(4000)
const SkillSchema = z.string().trim().min(1).max(80)
/** The superagents a message wakes: a structured list, never a text search, so at most five of them. */
const MentionSchema = z.array(MemberSchema).min(1).max(5).describe('The superagents who should answer.')
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
/** Map a proposed division into the engine's task specs. */
function taskSpecs(tasks: readonly { assignee_id: string; text: string; after?: string[]; outputs?: string[] }[]) {
  return tasks.map(item => ({ assigneeId: item.assignee_id, text: item.text, ...item.after ? { after: item.after } : {},
    ...item.outputs ? { outputs: item.outputs } : {} }))
}

/**
 * Bob's tools. He hires business superagents, creates a group, names its owner, hands the request to that owner, and
 * dissolves a group. He is not a member, so he does not speak, propose, or dispatch. Alice already exists.
 */
export function leadTeamTools(host: LeadTeamToolsHost): Tool[] {
  const { engine, store, leadId } = host
  return [
    tool({
      name: 'lead_team_create_superagent',
      description: 'Hire a business superagent. It joins the all-hands group. Alice already exists; do not hire her again.',
      schema: z.object({ id: MemberSchema, name: z.string().trim().min(1).max(160),
        capabilities: z.array(CapabilitySchema).max(16).optional(), persona: PersonaSchema.optional(),
        skills: z.array(SkillSchema).max(16).optional(), directory: DirectorySchema,
        repository: RepoSchema.optional(), feishu_cli: z.string().trim().max(1000).optional() }).strict(),
      execute: async args => {
        if (args.id === ALICE_ID) throw new UserError('builtinProtected')
        const superagent = engine.addSuperagent({ id: args.id, name: args.name, role: 'specialist', ...args.capabilities ? { capabilities: args.capabilities } : {},
          ...args.persona ? { persona: args.persona } : {}, ...args.skills ? { skills: args.skills } : {},
          ...args.directory ? { directory: args.directory } : {}, ...args.repository ? { repository: args.repository } : {},
          ...args.feishu_cli ? { feishuCli: args.feishu_cli } : {}, createdAt: '' })
        await host.ensureSuperagentSession?.(superagent)
        const allHands = engine.team(ALL_HANDS_ID)
        return { superagent, ...allHands ? { all_hands: { id: allHands.id, name: allHands.name, lead_id: allHands.leadId } } : {} }
      },
    }),
    tool({
      name: 'lead_team_list_superagents',
      description: 'List every superagent, and the all-hands group.',
      schema: z.object({}).strict(),
      execute: async () => ({ superagents: engine.superagents(), all_hands: engine.team(ALL_HANDS_ID) ?? null }),
    }),
    tool({
      name: 'lead_team_update_superagent',
      description: 'Change a superagent. A field left out is kept; null clears an optional one.',
      schema: z.object({ id: MemberSchema, name: z.string().trim().min(1).max(160).optional(),
        capabilities: z.array(CapabilitySchema).max(16).nullable().optional(), persona: PersonaSchema.nullable().optional(),
        skills: z.array(SkillSchema).max(16).nullable().optional(), directory: z.string().trim().min(1).max(1000).nullable().optional(),
        repository: RepoSchema.nullable().optional(), feishu_cli: z.string().trim().max(1000).nullable().optional(),
        disabled: z.boolean().optional() }).strict(),
      execute: async args => {
        const superagent = engine.updateSuperagent(args.id, { ...args.name !== undefined ? { name: args.name } : {},
          ...args.capabilities !== undefined ? { capabilities: args.capabilities } : {},
          ...args.persona !== undefined ? { persona: args.persona } : {},
          ...args.skills !== undefined ? { skills: args.skills } : {},
          ...args.directory !== undefined ? { directory: args.directory ?? null } : {},
          ...args.repository !== undefined ? { repository: args.repository || null } : {},
          ...args.feishu_cli !== undefined ? { feishuCli: args.feishu_cli || null } : {},
          ...args.disabled === undefined ? {} : { disabled: args.disabled ? { at: new Date().toISOString(), by: leadId } : null } })
        if (superagentActive(superagent)) await host.ensureSuperagentSession?.(superagent)
        return { superagent }
      },
    }),
    tool({
      name: 'lead_team_create',
      description: 'Create a group or a direct conversation. You do not join it. For a group, name its owner and pass the person\'s request; that delivers the request to the owner.',
      schema: z.object({ id: MemberSchema, name: TeamNameSchema, kind: z.enum(['group', 'direct']), member_ids: z.array(MemberSchema).min(1).max(16),
        lead_id: MemberSchema.optional().describe('The group\'s owner. Required for a group, and one of member_ids.'),
        request: z.string().trim().min(1).max(4000).optional().describe('The person\'s request, delivered to the owner. Not a message from you in the group.') }).strict(),
      execute: async args => {
        const team = engine.addTeam({ id: args.id, name: args.name, kind: args.kind, memberIds: args.member_ids,
          ...args.lead_id ? { leadId: args.lead_id } : {}, createdAt: '' })
        const handoff = args.request ? engine.handOffTeam(team.id, args.request) : undefined
        return { team, ...handoff ? { handoff_id: handoff.id } : {} }
      },
    }),
    tool({
      name: 'lead_team_set_owner',
      description: 'Change a group\'s owner. The new owner is already in the group. You do not join it.',
      schema: z.object({ team_id: MemberSchema, owner_id: MemberSchema }).strict(),
      execute: async args => ({ team_id: args.team_id, owner_id: engine.setTeamOwner(args.team_id, args.owner_id).leadId }),
    }),
    tool({
      name: 'lead_team_dissolve',
      description: 'Dissolve a group when the person is done with that matter. A finished round is not a reason. The all-hands group cannot be dissolved.',
      schema: z.object({ team_id: MemberSchema, summary: z.string().trim().min(1).max(4000) }).strict(),
      execute: async args => {
        const team = engine.dissolveTeam(args.team_id, args.summary)
        return { team_id: team.id, closed: team.closed }
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
      description: 'Say something in a group or direct conversation you belong to. Only `at` wakes anyone. Never name yourself.',
      schema: z.object({ team_id: MemberSchema, text: z.string().trim().min(1).max(4000), at: MentionSchema.optional() }).strict(),
      execute: async args => {
        const message = engine.sendTeamMessage(args.team_id, superagent.id, args.text, 'discussion', { ...args.at ? { mentions: args.at } : {} })
        return { team_id: args.team_id, message_id: message.id, woke: message.mentions ?? [] }
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
      description: 'Read your team\'s state: the team, its tasks and its messages. The group\'s owner is leadId.',
      schema: z.object({ team_id: MemberSchema }).strict(),
      execute: async args => teamState(store, args.team_id) ?? { error: 'Unknown team' },
    }),
    tool({
      name: 'superagent_team_add_member',
      description: 'As this group\'s owner, add a business superagent. Not the all-hands group, whose membership follows hiring.',
      schema: z.object({ team_id: MemberSchema, member_id: MemberSchema }).strict(),
      execute: async args => ({ team_id: args.team_id, member_ids: engine.addTeamMember(args.team_id, superagent.id, args.member_id).memberIds }),
    }),
    tool({
      name: 'superagent_team_remove_member',
      description: 'As this group\'s owner, remove a member other than yourself. You cannot dissolve the group by leaving it.',
      schema: z.object({ team_id: MemberSchema, member_id: MemberSchema }).strict(),
      execute: async args => ({ team_id: args.team_id, member_ids: engine.removeTeamMember(args.team_id, superagent.id, args.member_id).memberIds }),
    }),
    tool({
      name: 'superagent_team_propose',
      description: 'As this group\'s owner, propose a division: one task per member, with what it does, what it waits on, and its deliverables.',
      schema: z.object({ team_id: MemberSchema, tasks: z.array(TaskSpecSchema).min(1).max(16) }).strict(),
      execute: async args => {
        const team = store.team.teams.get(args.team_id)
        if (!team || team.leadId !== superagent.id) throw new UserError('notGroupOwner')
        const tasks = engine.proposeTeam(args.team_id, taskSpecs(args.tasks))
        return { team_id: args.team_id, tasks }
      },
    }),
    tool({
      name: 'superagent_team_dispatch',
      description: 'As this group\'s owner, start ready tasks now and return. Do not wait for reports.',
      schema: z.object({ team_id: MemberSchema }).strict(),
      execute: async args => {
        const team = store.team.teams.get(args.team_id)
        if (!team || team.leadId !== superagent.id) throw new UserError('notGroupOwner')
        const tasks = engine.dispatchTeam(args.team_id)
        return { team_id: args.team_id, started: tasks.filter(task => task.state === 'working' || task.state === 'waiting').length,
          tasks: tasks.map(task => ({ task_id: task.id, assignee_id: task.assigneeId, state: task.state,
            ...task.reason ? { reason: task.reason } : {} })) }
      },
    }),
  ]
}
