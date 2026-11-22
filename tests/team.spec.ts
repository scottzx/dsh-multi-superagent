import { describe, expect, it, vi } from 'vitest'
import { Engine, ALL_HANDS_ID, HUMAN_ID, MemoryRepositories, TEAM_HOP_LIMIT, UserError, inCycle, superagentWorkspace, type Assessor, type EngineOptions, type Executor,
  type OutboundMessage, type Policy, type SuperagentRunner, type Team, type TeamTask } from '../src/core/index.ts'

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
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
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
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', directory: '/srv/copy', createdAt: '' })
    engine.addSuperagent({ id: 'b', name: 'B', role: 'specialist', createdAt: '' })
    expect(engine.superagent('a')?.directory).toBe('/srv/copy')
    // A bound directory wins; an absent or blank one falls back to the state directory.
    expect(superagentWorkspace(engine.superagent('a'), '/state')).toBe('/srv/copy')
    // An unbound superagent gets its own directory under the state directory, so its AGENTS.md is its own.
    expect(superagentWorkspace(engine.superagent('b'), '/state')).toBe('/state/superagents/b')
    expect(superagentWorkspace({ id: 'x', name: 'X', role: 'specialist', directory: '   ', createdAt: '' }, '/state')).toBe('/state/superagents/x')
    expect(superagentWorkspace(undefined, '/state')).toBe('/state')
  })

  it('dispatches a division, starts ready tasks, and marks the rest waiting', () => {
    const { engine, runner } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
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
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
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
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
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
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
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

  it('records team messages, and mentions reach a running turn while unmentioned talk does not', () => {
    const { engine, runner } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'b', name: 'B', role: 'specialist', createdAt: '' })
    engine.addTeam(team('t1', ['lead', 'a', 'b']))
    engine.proposeTeam('t1', [{ assigneeId: 'a', text: 'do A' }, { assigneeId: 'b', text: 'do B', after: ['a'] }])
    engine.dispatchTeam('t1')
    engine.sendTeamMessage('t1', 'lead', 'a heads up', 'discussion')
    // Nothing was mentioned, so the line is recorded but reaches no turn: a running turn is not steered either.
    expect((runner.deliver as ReturnType<typeof vi.fn>).mock.calls).toEqual([])
    engine.sendTeamMessage('t1', 'lead', 'a heads up', 'discussion', { mentions: ['a'] })
    // A was mentioned, so its running turn reads it; the batch is what a turn that is idle would be woken with.
    expect((runner.deliver as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1].assigneeId)).toEqual(['a'])
    expect(engine.messages('t1').at(-1)?.text).toBe('a heads up')
    // A non-member cannot write to the team.
    expect(() => engine.sendTeamMessage('t1', 'ghost', 'nope', 'discussion')).toThrow(UserError)
  })

  it('lets only the owner speak, add and remove members, and hands a request to the owner without joining', () => {
    const { engine } = harness()
    engine.addSuperagent({ id: 'chief', name: 'Chief', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'b', name: 'B', role: 'specialist', createdAt: '' })
    engine.addTeam(team('t1', ['chief', 'a']))
    expect(() => engine.sendTeamMessage('t1', 'a', 'hi', 'discussion')).toThrow(UserError)
    expect(() => engine.sendTeamMessage('t1', 'bob', 'hi', 'discussion')).toThrow(UserError)
    engine.sendTeamMessage('t1', 'chief', 'hi', 'discussion')
    expect(engine.messages('t1').at(-1)).toMatchObject({ from: 'chief', text: 'hi' })
    expect(() => engine.addTeamMember('t1', 'a', 'b')).toThrow(UserError)
    expect(engine.addTeamMember('t1', 'chief', 'b').memberIds).toContain('b')
    expect(() => engine.removeTeamMember('t1', 'chief', 'chief')).toThrow(UserError)
    expect(engine.removeTeamMember('t1', 'chief', 'a').memberIds).not.toContain('a')
    expect(() => engine.addTeamMember(ALL_HANDS_ID, 'chief', 'b')).toThrow(UserError)
    engine.setTeamOwner('t1', 'b')
    expect(() => engine.sendTeamMessage('t1', 'chief', 'still mine', 'discussion')).toThrow(UserError)
    const handed = engine.handOffTeam('t1', 'please revise the resume')
    expect(handed.mentions).toEqual(['b'])
    expect(engine.inbox('b', 'pending').map(item => item.messageId)).toEqual([handed.id])
    expect(engine.team('t1')?.memberIds).not.toContain('bob')
  })

  it('routes a direct conversation only to the members it mentions', () => {
    const { engine, runner } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'b', name: 'B', role: 'specialist', createdAt: '' })
    engine.addTeam({ id: 'direct', name: 'private', kind: 'direct', memberIds: ['a', 'b'], createdAt: '' })
    engine.proposeTeam('direct', [{ assigneeId: 'a', text: 'do A' }])
    engine.dispatchTeam('direct')
    engine.sendTeamMessage('direct', 'b', 'just between us', 'discussion', { mentions: ['a'] })
    // A was mentioned, so its running turn reads it; the sender (B) has no running turn, so only A was delivered.
    expect((runner.deliver as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1].assigneeId)).toEqual(['a'])
    expect(engine.messages('direct').at(-1)?.from).toBe('b')
  })

  it('closes a round with the lead decision and refuses further work', () => {
    const { engine } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
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

  it('wakes only the members a message mentions, and never searches the text', () => {
    const wake = vi.fn()
    const { engine } = harness({ start: vi.fn(), deliver: vi.fn(), stop: vi.fn(), wake })
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', persona: 'You write the copy.', capabilities: ['copy'], createdAt: '' })
    engine.addSuperagent({ id: 'b', name: 'B', role: 'specialist', createdAt: '' })
    engine.addTeam(team('t1', ['lead', 'a', 'b']))
    // Naming someone in the text wakes nobody: only a mention does, and it is a structured field.
    engine.sendTeamMessage('t1', 'lead', '@a what do you think', 'discussion')
    expect(wake).not.toHaveBeenCalled()
    expect(engine.inbox('a')).toEqual([])
    engine.sendTeamMessage('t1', 'lead', 'what do you think', 'discussion', { mentions: ['a'] })
    expect(wake).toHaveBeenCalledOnce()
    expect(wake).toHaveBeenCalledWith('a')
    expect(engine.tasks('t1')).toEqual([])
    expect(engine.inbox('a').map(item => item.botId)).toEqual(['a'])
    // Only the group's owner may speak in it. A member's reply is refused, and wakes nobody.
    expect(() => engine.sendTeamMessage('t1', 'a', 'back', 'discussion', { mentions: ['lead'] })).toThrow(UserError)
    expect(wake).toHaveBeenCalledTimes(1)
    engine.updateSuperagent('b', { disabled: { at: '2026-09-23T00:00:00.000Z', by: 'lead' } })
    expect(() => engine.sendTeamMessage('t1', 'lead', 'still there', 'discussion', { mentions: ['b'] })).toThrow(UserError)
    expect(wake).toHaveBeenCalledTimes(1)
  })
  it('rejects a mention of a non-member, of the sender, or of more than five members', () => {
    const { engine } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addTeam(team('t1', ['lead', 'a']))
    expect(() => engine.sendTeamMessage('t1', 'lead', 'hi', 'discussion', { mentions: ['zed'] })).toThrow(UserError)
    expect(() => engine.sendTeamMessage('t1', 'lead', 'hi', 'discussion', { mentions: ['lead'] })).toThrow(UserError)
    expect(() => engine.sendTeamMessage('t1', 'lead', 'hi', 'discussion', { mentions: ['a', 'a', 'a', 'a', 'a', 'a'] })).not.toThrow()
    expect(() => engine.sendTeamMessage('t1', 'lead', 'hi', 'discussion', { mentions: ['a', 'lead'] })).toThrow(UserError)
  })
  it('gathers mentions from several groups into one batch, with each group\'s context', () => {
    const { engine } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addTeam(team('t1', ['lead', 'a']))
    engine.addTeam({ ...team('t2', ['lead', 'a']), name: 'Second' })
    engine.sendTeamMessage('t1', 'lead', 'first', 'discussion', { mentions: ['a'] })
    engine.sendTeamMessage('t2', 'lead', 'second', 'discussion', { mentions: ['a'] })
    const batch = engine.takeBatch('a')!
    expect(batch.teams.map(group => group.teamId)).toEqual(['t1', 't2'])
    expect(batch.teams.map(group => group.mentions.map(message => message.text))).toEqual([['first'], ['second']])
    expect(engine.inbox('a', 'pending')).toHaveLength(2)
    engine.deliverBatch('a', batch)
    expect(engine.inbox('a', 'pending')).toEqual([])
    expect(engine.inbox('a', 'delivered')).toHaveLength(2)
    expect(engine.takeBatch('a')).toBeUndefined()
  })
  it('pauses a group whose bots mention each other too often, and resumes when the person speaks', () => {
    const wake = vi.fn()
    const { engine } = harness({ start: vi.fn(), deliver: vi.fn(), stop: vi.fn(), wake })
    engine.ensureHuman()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    engine.addSuperagent({ id: 'b', name: 'B', role: 'specialist', createdAt: '' })
    engine.addTeam(team('t1', ['lead', 'a', 'b']))
    for (let index = 0; index < TEAM_HOP_LIMIT; index += 1) engine.sendTeamMessage('t1', 'lead', `line ${index}`, 'discussion', { mentions: ['a'] })
    expect(engine.team('t1')?.paused?.reason).toBe('hops')
    expect(engine.messages('t1').at(-1)?.kind).toBe('notice')
    const before = wake.mock.calls.length
    engine.sendTeamMessage('t1', 'lead', 'still talking', 'discussion', { mentions: ['a'] })
    expect(wake.mock.calls.length).toBe(before)
    engine.sendTeamMessage('t1', HUMAN_ID, 'carry on', 'discussion', { mentions: ['a'] })
    expect(engine.team('t1')?.paused).toBeUndefined()
    expect(engine.team('t1')?.hops).toBe(0)
    expect(wake).toHaveBeenLastCalledWith('a')
  })
  it('needs a lead in a group and at most six bots, and adds the person to every team', () => {
    const { engine } = harness()
    engine.ensureHuman()
    // A group of the person alone has no lead in it, so it is refused for that rather than for a missing member.
    expect(() => engine.addTeam(team('t1', [HUMAN_ID]))).toThrow(UserError)
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) engine.addSuperagent({ id, name: id, role: 'specialist', createdAt: '' })
    expect(() => engine.addTeam(team('big', ['lead', 'a', 'b', 'c', 'd', 'e', 'f']))).toThrow(UserError)
    const created = engine.addTeam(team('t1', ['lead', 'a']))
    expect(created.memberIds).toContain(HUMAN_ID)
    expect(engine.isHuman(HUMAN_ID)).toBe(true)
  })

  it('holds every bot in the standing all-hands group, so the lead dispatches to any of them', () => {
    const { engine, runner } = harness()
    engine.ensureHuman()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
    // The group appeared with the first bot, and holds it and the person.
    expect(engine.team(ALL_HANDS_ID)).toMatchObject({ kind: 'group', leadId: 'lead' })
    expect(engine.team(ALL_HANDS_ID)?.memberIds).toEqual(['lead', HUMAN_ID])
    // A specialist registered later joins it, so the lead needs no group-building step to reach it.
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    expect(engine.team(ALL_HANDS_ID)?.memberIds).toEqual(['lead', HUMAN_ID, 'a'])
    engine.proposeTeam(ALL_HANDS_ID, [{ assigneeId: 'a', text: 'do A' }])
    engine.dispatchTeam(ALL_HANDS_ID)
    expect((runner.start as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1].assigneeId)).toEqual(['a'])
  })

  it('starts with Alice as the all-hands owner and keeps Bob out of the group', () => {
    const { engine } = harness()
    engine.ensureHuman()
    expect(engine.ensureAlice('/state/alice')).toMatchObject({ id: 'alice', name: 'Alice', builtin: true, directory: '/state/alice' })
    expect(engine.team(ALL_HANDS_ID)?.leadId).toBe('alice')
    expect(engine.team(ALL_HANDS_ID)?.memberIds).toEqual(['alice', HUMAN_ID])
    engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
    expect(engine.team(ALL_HANDS_ID)?.memberIds).toEqual(['alice', HUMAN_ID, 'a'])
    expect(engine.team(ALL_HANDS_ID)?.leadId).toBe('alice')
    expect(engine.updateSuperagent('alice', { name: 'Alicia' }).name).toBe('Alicia')
    expect(() => engine.updateSuperagent('alice', { disabled: { at: '2026-09-23T00:00:00.000Z', by: 'bob' } })).toThrow(UserError)
    expect(() => engine.dissolveTeam(ALL_HANDS_ID, 'no')).toThrow(UserError)
  })

  it('keeps a closed all-hands group closed, and holds more bots than a group people build', () => {
    const { engine } = harness()
    engine.ensureHuman()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) engine.addSuperagent({ id, name: id, role: 'specialist', createdAt: '' })
    // The standing group holds every bot, past the limit a group people build has.
    expect(engine.team(ALL_HANDS_ID)?.memberIds).toHaveLength(8)
    expect(() => engine.dissolveTeam(ALL_HANDS_ID, 'no')).toThrow(UserError)
    // A closed group is not reopened by a bot: only the person reopens it, by speaking in it.
    engine.closeTeam(ALL_HANDS_ID, 'lead', 'round done')
    engine.addSuperagent({ id: 'g', name: 'G', role: 'specialist', createdAt: '' })
    expect(engine.team(ALL_HANDS_ID)?.closed).toBeDefined()
    expect(engine.team(ALL_HANDS_ID)?.memberIds).toContain('g')
  })

  it('delegates concrete work to a worker under a team mandate', () => {    const { repo, engine, executor } = harness()
    engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
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

it('adds the person to a team created before it existed, so an older group can still be spoken to', () => {
  const { engine } = harness()
  engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
  engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
  // A team from a build before the person was a member.
  engine.addTeam({ id: 'old', name: 'Old', kind: 'group', memberIds: ['lead', 'a'], leadId: 'lead', createdAt: '' })
  expect(engine.team('old')?.memberIds).not.toContain(HUMAN_ID)
  engine.ensureHuman()
  expect(engine.team('old')?.memberIds).toContain(HUMAN_ID)
  expect(() => engine.sendTeamMessage('old', HUMAN_ID, 'still here?', 'discussion')).not.toThrow()
})

it('treats a close as the end of a round: the person speaking again starts the next one', () => {
  const { engine } = harness()
  engine.ensureHuman()
  engine.addSuperagent({ id: 'lead', name: 'Lead', role: 'specialist', createdAt: '' })
  engine.addSuperagent({ id: 'a', name: 'A', role: 'specialist', createdAt: '' })
  engine.addTeam(team('t1', ['lead', 'a']))
  engine.closeTeam('t1', 'lead', '定：这一轮结束')
  expect(engine.team('t1')?.closed).toBeDefined()
  // A bot cannot reopen it: a close still stops the members from starting work.
  expect(() => engine.sendTeamMessage('t1', 'a', 'one more thing', 'discussion')).toThrow(UserError)
  // The person can: the same group goes on, with its history.
  const before = engine.messages('t1').length
  engine.sendTeamMessage('t1', HUMAN_ID, '还有一件事', 'discussion', { mentions: ['a'] })
  expect(engine.team('t1')?.closed).toBeUndefined()
  expect(engine.messages('t1').length).toBeGreaterThan(before)
  expect(engine.messages('t1').at(-1)?.text).toBe('还有一件事')
  expect(engine.inbox('a', 'pending')).toHaveLength(1)
})
