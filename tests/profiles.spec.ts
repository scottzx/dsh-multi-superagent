// A superagent's own files: its directory, its AGENTS.md, and the skills it can read.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AGENTS_MD_LIMIT, AgentsMdConflict, Profiles } from '../src/app/profiles.ts'
import type { Superagent } from '../src/core/index.ts'

let stateDir: string
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'profiles-')) })
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

const member = (fields: Partial<Superagent> = {}): Superagent =>
  ({ id: 'writer', name: 'Writer', role: 'specialist', createdAt: '', ...fields })

it('gives each unbound superagent its own directory, so each has its own AGENTS.md', () => {
  const profiles = new Profiles(stateDir)
  const one = profiles.read(member())
  const two = profiles.read(member({ id: 'researcher', name: 'Researcher' }))
  expect(one.directory).toBe(join(stateDir, 'superagents', 'writer'))
  expect(two.directory).toBe(join(stateDir, 'superagents', 'researcher'))
  // The directory is created on read, so its AGENTS.md can be written straight away.
  expect(one.agentsMd).toBeNull()
  // A bound directory wins over the per-member default.
  const bound = profiles.read(member({ directory: join(stateDir, 'checkout') }))
  expect(bound.directory).toBe(join(stateDir, 'checkout'))
})

it('writes and reads AGENTS.md as the file DSH injects from the working directory', () => {
  const profiles = new Profiles(stateDir)
  const first = profiles.read(member())
  const written = profiles.writeAgentsMd(member(), { content: '# Writer\n\nYou write the copy.', baseMtime: first.agentsMd?.mtime ?? 0 })
  expect(written.agentsMd?.content).toBe('# Writer\n\nYou write the copy.')
  expect(readFileSync(join(stateDir, 'superagents', 'writer', 'AGENTS.md'), 'utf8')).toBe('# Writer\n\nYou write the copy.')
  // Reading it back sees the same text, which is what the next request injects.
  expect(profiles.read(member()).agentsMd?.content).toBe('# Writer\n\nYou write the copy.')
})

it('refuses a save over a change it did not see, so an edit is never silently lost', () => {
  const profiles = new Profiles(stateDir)
  const seen = profiles.read(member())
  profiles.writeAgentsMd(member(), { content: 'first', baseMtime: seen.agentsMd?.mtime ?? 0 })
  const stale = seen.agentsMd?.mtime ?? 0
  // Someone else saved in between; the file on disk is newer than what this editor read.
  const current = profiles.read(member()).agentsMd!.mtime
  if (current === stale) {
    // A coarse filesystem clock can leave the mtime equal; touch it forward so the conflict is still exercised.
    writeFileSync(join(stateDir, 'superagents', 'writer', 'AGENTS.md'), 'other')
    const touched = profiles.read(member()).agentsMd!.mtime + 1
    expect(() => profiles.writeAgentsMd(member(), { content: 'mine', baseMtime: touched - 2 })).toThrow(AgentsMdConflict)
  } else {
    expect(() => profiles.writeAgentsMd(member(), { content: 'mine', baseMtime: stale })).toThrow(AgentsMdConflict)
  }
})

it('refuses a brief larger than the limit', () => {
  const profiles = new Profiles(stateDir)
  const base = profiles.read(member()).agentsMd?.mtime ?? 0
  expect(() => profiles.writeAgentsMd(member(), { content: 'x'.repeat(AGENTS_MD_LIMIT + 1), baseMtime: base })).toThrow(RangeError)
})

it('lists the skills a superagent can read: bound, the deployment\'s own, and its directory\'s', () => {
  const shipped = join(stateDir, 'shipped-skill.md')
  writeFileSync(shipped, '---\nname: feishu\ndescription: Work with Feishu\n---\n\nBody')
  const local = join(stateDir, 'superagents', 'writer', '.agents', 'skills', 'house-style')
  mkdirSync(local, { recursive: true })
  writeFileSync(join(local, 'SKILL.md'), '---\nname: house-style\ndescription: The house voice\n---\n\nBody')
  const profiles = new Profiles(stateDir, () => [{ name: 'feishu', description: 'Work with Feishu', source: 'deployment', path: shipped }])
  const profile = profiles.read(member({ skills: ['feishu', 'transcribe'] }))
  const byName = Object.fromEntries(profile.skills.map(skill => [skill.name, skill]))
  // A name both bound and shipped is listed once, as bound: the superagent was given it on purpose.
  expect(byName.feishu?.source).toBe('bound')
  expect(byName.feishu?.description).toBe('Work with Feishu')
  expect(byName.transcribe?.source).toBe('bound')
  expect(byName['house-style']?.source).toBe('directory')
  expect(byName['house-style']?.description).toBe('The house voice')
  expect(profiles.skill(member({ skills: ['feishu'] }), 'feishu')?.content).toContain('Body')
  expect(profiles.skill(member(), 'nope')).toBeUndefined()
})

it('seeds AGENTS.md from a persona once, and never overwrites a brief a person already wrote', () => {
  const profiles = new Profiles(stateDir)
  const seeded = profiles.read(member({ persona: 'You write the copy, and nothing else.' }))
  expect(seeded.agentsMd?.content).toContain('You write the copy, and nothing else.')
  profiles.writeAgentsMd(member({ persona: 'You write the copy, and nothing else.' }),
    { content: '# Writer\n\nA brief a person wrote.', baseMtime: seeded.agentsMd!.mtime })
  // The persona is only a seed: reading again keeps the person's brief rather than restoring the persona.
  expect(profiles.read(member({ persona: 'A different persona.' })).agentsMd?.content).toBe('# Writer\n\nA brief a person wrote.')
})
