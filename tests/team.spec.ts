import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, inCycle, superagentWorkspace, type Assessor, type EngineOptions, type Executor, type OutboundMessage, type Policy,
  type SuperagentRunner, type Team, type TeamTask } from '../src/core/index.ts'

/** A minimal Policy: the team's delegation only reads its version. */
const policy = (): Policy => ({ version: 'v1', paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: false, reason: 'n/a' }),
  revalidate: () => true, admitsInferred: () => false })

function harness(superagent?: SuperagentRunner) {
  const repo = new MemoryRepositories()
  const outbox: OutboundMessage[] = []
  const assessor: Assessor = { request: vi.fn(), release: vi.fn() }
  const executor: Executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const runner = superagent ?? { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy, assessor, executor, outbox: {
    send: message => { outbox.push(message) }, status: () => undefined, withdraw: () => {} }, superagent: runner })
  return { repo, engine, executor, runner }
}

function team(id: string, memberIds: string[] = ['lead'], kind: Team['kind'] = 'group'): Team {
  return { id, name: id, kind, memberIds, ...kind === 'group' ? { leadId: memberIds[0] } : {}, createdAt: '2026-09-23T00:00:00.000Z' }
}

describe('the team of superagents', () => {
  it('registers superagents and teams, and refuses duplicates and unknown members', () => {
    const { engine } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'lead', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    expect(engine.superagent('a')?.name).toBe('A')
    expect(engine.addTeam(team('t1', ['lead', 'a'])).id).toBe('t1')
    expect(() => engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })).toThrow(UserError)
    expect(() => engine.addTeam(team('t1', ['lead', 'a']))).toThrow(UserError)
    expect(() => engine.addTeam(team('t2', ['lead', 'ghost']))).toThrow(UserError)
    // A group needs a lead who is a member.
    expect(() => engine.addTeam({ id: 't4', name: 't4', kind: 'group', memberIds: ['a'], createdAt: '' })).toThrow(UserError)
    // A direct conversation needs no lead.
    expect(engine.addTeam({ id: 'd', name: 'd', kind: 'direct', memberIds: ['a', 'lead'], createdAt: '' }).kind).toBe('direct')
  })

  it('binds a superagent to its own project directory and falls back to the state directory', () => {
    const { engine } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'lead', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', directory: '/srv/copy', createdAt: '' })
    engine.addSuperagent({ id: 'b', name: 'B', role: 'specialist', createdAt: '' })
    expect(engine.superagent('a')?.directory).toBe('/srv/copy')
    // A bound directory wins; an absent or blank one falls back to the state directory.
    expect(superagentWorkspace(engine.superagent('a'), '/state')).toBe('/srv/copy')
    expect(superagentWorkspace(engine.superagent('b'), '/state')).toBe('/state')
    expect(superagentWorkspace({ id: 'x', name: 'X', role: 'specialist', directory: '   ', createdAt: '' }, '/state')).toBe('/state')
    expect(superagentWorkspace(undefined, '/state')).toBe('/state')
  })

  it('dispatches a division, starts ready tasks, and marks the rest waiting', () => {
    const { engine, runner } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'lead', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'b', name: 'B', role: 'specialist', createdAt: '' })
    engine.addTeam(team('t1', ['lead', 'a', 'b']))
    const tasks = engine.proposeTeam('t1', [
      { assigneeId: 'a', text: 'do A' },
      { assigneeId: 'b', text: 'do B', after: ['a'] },
    ])
    expect(tasks.map(task => task.state)).toEqual(['proposed', 'proposed'])
    const dispatched = engine.dispatchTeam('t1')
    expect(dispatched.find(task => task.assigneeId === 'a')?.state).toBe('working')
    expect(dispatched.find(task => task.assigneeId === 'b')?.state).toBe('waiting')
    // The runner was asked to start A's turn, and not B's.
    expect((runner.start as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1].assigneeId)).toEqual(['a'])
  })

  it('advances a waiting task once its dependency reports done', () => {
    const { engine, runner } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'lead', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'b', name: 'B', role: 'specialist', createdAt: '' })
    engine.addTeam(team('t1', ['lead', 'a', 'b']))
    engine.proposeTeam('t1', [{ assigneeId: 'a', text: 'do A' }, { assigneeId: 'b', text: 'do B', after: ['a'] }])
    const [a, b] = engine.dispatchTeam('t1') as [TeamTask, TeamTask]
    engine.reportTeamTask(a.id, { state: 'done', summary: 'A done' })
    expect(engine.tasks('t1').find(task => task.id === b.id)!.state).toBe('working')
    expect((runner.start as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1].assigneeId)).toEqual(['a', 'b'])
    // A report without the declared outputs is refused; with them it ends done.
    engine.proposeTeam('t1', [{ assigneeId: 'a', text: 'again', outputs: ['out.txt'] }])
    const a2 = engine.dispatchTeam('t1').find(task => task.text === 'again')!
    expect(() => engine.reportTeamTask(a2.id, { state: 'done', summary: 'no outputs' })).toThrow(UserError)
    expect(engine.reportTeamTask(a2.id, { state: 'done', summary: 'ok', outputs: ['out.txt'] }).state).toBe('done')
  })

  it('fails a waiting task whose dependency failed', () => {
    const { engine } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'lead', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'b', name: 'B', role: 'specialist', createdAt: '' })
    engine.addTeam(team('t1', ['lead', 'a', 'b']))
    const [a, b] = engine.proposeTeam('t1', [{ assigneeId: 'a', text: 'do A' }, { assigneeId: 'b', text: 'do B', after: ['a'] }]) as [TeamTask, TeamTask]
    engine.dispatchTeam('t1')
    engine.reportTeamTask(a.id, { state: 'failed', summary: 'A broke' })
    expect(engine.tasks('t1').find(task => task.id === b.id)!.state).toBe('failed')
  })

  it('fails a dependency cycle at dispatch rather than waiting forever', () => {
    const { engine } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'lead', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'b', name: 'B', role: 'specialist', createdAt: '' })
    engine.addTeam(team('t1', ['lead', 'a', 'b']))
    const [a, b] = engine.proposeTeam('t1', [{ assigneeId: 'a', text: 'x', after: ['b'] }, { assigneeId: 'b', text: 'y', after: ['a'] }]) as [TeamTask, TeamTask]
    const dispatched = engine.dispatchTeam('t1')
    expect(dispatched.find(task => task.id === a.id)!.state).toBe('failed')
    expect(dispatched.find(task => task.id === b.id)!.state).toBe('failed')
    // The pure helper agrees: the two tasks wait on each other's members.
    const tasks: TeamTask[] = [
      { id: 'x', teamId: 't1', assigneeId: 'a', text: 'x', state: 'proposed', after: ['b'], outputs: [], createdAt: '' },
      { id: 'y', teamId: 't1', assigneeId: 'b', text: 'y', state: 'proposed', after: ['a'], outputs: [], createdAt: '' },
    ]
    expect([...inCycle(tasks)].sort()).toEqual(['x', 'y'])
  })

  it('records team messages and delivers them to a running member', () => {
    const { engine, runner } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'lead', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'b', name: 'B', role: 'specialist', createdAt: '' })
    engine.addTeam(team('t1', ['lead', 'a', 'b']))
    engine.proposeTeam('t1', [{ assigneeId: 'a', text: 'do A' }, { assigneeId: 'b', text: 'do B', after: ['a'] }])
    engine.dispatchTeam('t1')
    engine.sendTeamMessage('t1', 'lead', 'a heads up', 'discussion')
    // The message reached A's running turn; B's turn is waiting on A, so it was not delivered.
    expect((runner.deliver as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1].assigneeId)).toEqual(['a'])
    expect(engine.messages('t1').at(-1)?.text).toBe('a heads up')
    // A non-member cannot write to the team.
    expect(() => engine.sendTeamMessage('t1', 'ghost', 'nope', 'discussion')).toThrow(UserError)
  })

  it('routes a direct conversation to its running member only', () => {
    const { engine, runner } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'lead', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'b', name: 'B', role: 'specialist', createdAt: '' })
    engine.addTeam({ id: 'direct', name: 'private', kind: 'direct', memberIds: ['a', 'b'], createdAt: '' })
    engine.proposeTeam('direct', [{ assigneeId: 'a', text: 'do A' }])
    engine.dispatchTeam('direct')
    engine.sendTeamMessage('direct', 'b', 'just between us', 'discussion')
    // A's running turn received it; the sender (B) has no running turn, so only A was delivered.
    expect((runner.deliver as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1].assigneeId)).toEqual(['a'])
    expect(engine.messages('direct').at(-1)?.from).toBe('b')
  })

  it('closes a round with the lead decision and refuses further work', () => {
    const { engine } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'lead', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addTeam(team('t1', ['lead', 'a']))
    engine.proposeTeam('t1', [{ assigneeId: 'a', text: 'do A' }])
    engine.dispatchTeam('t1')
    const decision = engine.closeTeam('t1', 'lead', '定：A 已完成')
    expect(engine.team('t1')?.closed?.by).toBe('lead')
    expect(engine.messages('t1').at(-1)?.kind).toBe('decision')
    expect(decision.text).toBe('定：A 已完成')
    expect(() => engine.proposeTeam('t1', [{ assigneeId: 'a', text: 'more' }])).toThrow(UserError)
    expect(() => engine.closeTeam('t1', 'lead', 'again')).toThrow(UserError)
  })

  it('delegates concrete work to a worker under a team mandate', () => {
    const { repo, engine, executor } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'lead', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addTeam(team('t1', ['lead', 'a']))
    const [a] = engine.proposeTeam('t1', [{ assigneeId: 'a', text: 'do A' }]) as [TeamTask]
    engine.dispatchTeam('t1')
    const { ticketId } = engine.delegateTeamWork('t1', a.id, 'build the parser', 'build-parser', ['parser.ts'])
    const ticket = repo.tickets.get(ticketId)!
    expect(ticket.mandate.basis).toMatchObject({ via: 'team', team: 't1', task: a.id })
    expect(ticket.execution).toBeUndefined() // No prepareDelegated hook in this harness.
    expect(ticket.inputs[0]).toMatchObject({ kind: 'text' })
    // The executor was asked to start the delegated ticket.
    expect((executor.start as ReturnType<typeof vi.fn>).mock.calls.some(call => call[0].id === ticketId)).toBe(true)
    // Once the task ends, it can no longer delegate.
    engine.reportTeamTask(a.id, { state: 'done', summary: 'A done' })
    expect(() => engine.delegateTeamWork('t1', a.id, 'again', 'again')).toThrow(UserError)
  })
})
