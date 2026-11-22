/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { HUMAN_ID, UserError, superagentActive, type EngineForPeople, type EngineForTeamPanel, type Superagent, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'
import { AGENTS_MD_LIMIT } from './profiles.ts'
import type { Profiles } from './profiles.ts'
import { AgentsMdConflict } from './profiles.ts'
import { superagentList, teamDetail, teamList, teamMessages } from './views/teams.ts'

export interface HttpHost {
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople & EngineForTeamPanel
  /** A superagent's own files: its directory, its AGENTS.md and the skills it can read. */
  readonly profiles: Profiles
  readonly executor: Pick<DshExecutor, 'activeCount'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  /** Restart so a specialist's new Feishu CLI is resolved. GitHub repositories are read on the next poll and need no restart. */
  restart(): void
  requestPass(): void
  /** Provision a specialist's workspace brief and DSH Session so it can open and receive messages immediately. */
  ensureSuperagentSession?(superagent: Superagent): Promise<void>
  models(): Promise<ModelCatalog>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404 | 409, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
const TAILNET_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net(?::\d+)?$/i
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  if (req.headers['x-orchestrator-request'] !== '1') return false
  const host = req.headers.host
  if (!host) return false
  const origin = req.headers.origin
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) {
    return origin === undefined || origin === `http://${host}`
  }
  if (TAILNET_HOST.test(host) && (req.headers['tailscale-user-login'] !== undefined || req.headers['x-forwarded-proto'] === 'https')) {
    return origin === undefined || origin === `https://${host}`
  }
  return false
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved?.github ? { repository: resolved.repository, agent: resolved.github.login, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health,
    superagents: superagentList(runtime.store).superagents }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'GET teams': () => teamList(store),
    'GET teams/:id': ({ params }) => {
      const detail = teamDetail(store, params.id)
      if (!detail) throw new RouteError(404, 'Team not found')
      return detail
    },
    'POST teams/:id/close': async ({ params, body }) => {
      const summary = z.object({ summary: z.string().trim().min(1).max(4000) }).parse(await body()).summary
      runtime.engine.dissolveTeam(params.id, summary)
      return { closed: true }
    },
    'POST teams/:id/owner': async ({ params, body }) => {
      const ownerId = z.object({ owner_id: z.string().trim().min(1).max(200) }).parse(await body()).owner_id
      const team = runtime.engine.setTeamOwner(params.id, ownerId)
      return { owner_id: team.leadId ?? ownerId }
    },
    'POST teams/:id/message': async ({ params, body }) => {
      const args = z.object({ text: z.string().trim().min(1).max(4000), at: z.array(z.string().trim().min(1).max(200)).max(5).optional(),
        reply_to: z.string().trim().min(1).max(200).optional() }).parse(await body())
      const team = runtime.engine.team(params.id)
      if (!team) throw new RouteError(404, 'Team not found')
      // A person speaks as itself in any conversation, group or direct. Only the superagents in `at` are woken, and speaking
      // resumes a group that paused itself.
      const message = runtime.engine.sendTeamMessage(params.id, HUMAN_ID, args.text, 'discussion',
        { ...args.at ? { mentions: args.at } : {}, ...args.reply_to ? { replyTo: args.reply_to } : {} })
      return { message_id: message.id, woke: message.mentions ?? [] }
    },
    'GET teams/:id/messages': ({ params, query }) => {
      const after = query?.after ?? undefined
      const limit = query?.limit === undefined ? 200 : Number(query.limit)
      const view = teamMessages(store, params.id, after, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 200)
      if (!view) throw new RouteError(404, 'Team not found')
      return view
    },
    'POST teams/:id/pause': async ({ params, body }) => {
      const { paused } = z.object({ paused: z.boolean() }).parse(await body())
      if (paused) runtime.engine.pauseTeam(params.id)
      else runtime.engine.resumeTeam(params.id)
      return { paused: runtime.engine.team(params.id)?.paused !== undefined }
    },
    'POST teams': async ({ body }) => {
      const args = z.object({ name: z.string().trim().min(1).max(160), member_ids: z.array(z.string().trim().min(1).max(200)).min(1).max(16),
        kind: z.enum(['group', 'direct']).optional(), lead_id: z.string().trim().min(1).max(200).optional() }).parse(await body())
      const kind = args.kind ?? 'group'
      const team = runtime.engine.addTeam({ id: `team-${Date.now().toString(36)}`, name: args.name, kind, memberIds: args.member_ids,
        ...args.lead_id ? { leadId: args.lead_id } : {}, createdAt: '' })
      return { team_id: team.id }
    },
    'GET superagents': () => superagentList(store),
    'GET superagents/:id/profile': ({ params }) => {
      const superagent = store.team.superagents.get(params.id)
      if (!superagent) throw new RouteError(404, 'Superagent not found')
      return runtime.profiles.read(superagent)
    },
    'PUT superagents/:id/agents-md': async ({ params, body }) => {
      const superagent = store.team.superagents.get(params.id)
      if (!superagent) throw new RouteError(404, 'Superagent not found')
      const write = z.object({ content: z.string().max(AGENTS_MD_LIMIT), baseMtime: z.number() }).parse(await body())
      try { return runtime.profiles.writeAgentsMd(superagent, write) }
      catch (error) {
        if (error instanceof AgentsMdConflict) throw new RouteError(409, 'AGENTS.md changed since it was read; reload before saving')
        throw error
      }
    },
    'GET superagents/:id/skills/:name': ({ params }) => {
      const superagent = store.team.superagents.get(params.id)
      if (!superagent) throw new RouteError(404, 'Superagent not found')
      const skill = runtime.profiles.skill(superagent, params.name)
      if (!skill) throw new RouteError(404, 'Skill not found')
      return skill
    },
    'POST superagents': async ({ body }) => {
      const args = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(160),
        capabilities: z.array(z.string().trim().min(1).max(200)).max(16).optional(), persona: z.string().trim().min(1).max(4000).optional(),
        directory: z.string().trim().min(1).max(1000).optional(), repository: z.string().trim().max(200).optional(),
        feishuCli: z.string().trim().max(1000).optional() }).parse(await body())
      const superagent = runtime.engine.addSuperagent({ id: args.id, name: args.name, role: 'specialist', createdAt: '',
        ...args.capabilities ? { capabilities: args.capabilities } : {}, ...args.persona ? { persona: args.persona } : {},
        ...args.directory ? { directory: args.directory } : {}, ...args.repository ? { repository: args.repository } : {},
        ...args.feishuCli ? { feishuCli: args.feishuCli } : {} })
      await runtime.ensureSuperagentSession?.(superagent)
      return { id: superagent.id }
    },
    'POST superagents/:id': async ({ params, body }) => {
      const args = z.object({ name: z.string().trim().min(1).max(160).optional(),
        capabilities: z.array(z.string().trim().min(1).max(200)).max(16).nullable().optional(),
        persona: z.string().trim().min(1).max(4000).nullable().optional(), directory: z.string().trim().min(1).max(1000).nullable().optional(),
        repository: z.string().trim().max(200).nullable().optional(), feishuCli: z.string().trim().max(1000).nullable().optional(),
        disabled: z.boolean().optional() }).parse(await body())
      const before = store.team.superagents.get(params.id)?.feishuCli
      const superagent = runtime.engine.updateSuperagent(params.id, { ...args.name !== undefined ? { name: args.name } : {},
        ...args.capabilities !== undefined ? { capabilities: args.capabilities } : {},
        ...args.persona !== undefined ? { persona: args.persona } : {},
        ...args.directory !== undefined ? { directory: args.directory ?? null } : {},
        ...args.repository !== undefined ? { repository: args.repository || null } : {},
        ...args.feishuCli !== undefined ? { feishuCli: args.feishuCli || null } : {},
        ...args.disabled === undefined ? {} : { disabled: args.disabled ? { at: new Date().toISOString(), by: 'panel' } : null } })
      if (superagentActive(superagent)) await runtime.ensureSuperagentSession?.(superagent)
      if (args.feishuCli !== undefined && (args.feishuCli || undefined) !== before) runtime.restart()
      return { id: superagent.id }
    },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
