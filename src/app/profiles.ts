/**
 * A superagent's own files: the `AGENTS.md` of the directory its Session runs in, which DSH injects into every request, and the
 * skills it can read. The profile is what makes a superagent a person with a standing brief rather than a prompt string: the
 * brief is a file the person can read and edit, and the next request uses it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { superagentWorkspace, type Superagent } from '../core/index.ts'

/** The most `AGENTS.md` may hold; a brief longer than this is a document, not a briefing. */
export const AGENTS_MD_LIMIT = 64 * 1024
/** The file DSH reads from a Session's working directory, and that the panel edits here. */
export const AGENTS_MD = 'AGENTS.md'

/** One skill a superagent can read. */
export interface SkillRow {
  name: string
  description: string
  /** Where the skill came from: bound to the superagent, shipped with the deployment, or in the superagent's own directory. */
  source: 'bound' | 'deployment' | 'directory'
  path: string
}
/** A superagent's profile as the panel reads it. */
export interface ProfileView {
  id: string
  name: string
  /** The directory its Session runs in. */
  directory: string
  /** Its `AGENTS.md`, when one exists. */
  agentsMd: { path: string; content: string; mtime: number } | null
  skills: SkillRow[]
}
/** What the panel writes to `AGENTS.md`: the new text, and the version it was editing. */
export interface AgentsMdWrite { content: string; baseMtime: number }

/** Raised when the file changed since the panel read it, so a save cannot silently overwrite someone else's edit. */
export class AgentsMdConflict extends Error {}

const splitFrontMatter = (text: string): { name?: string; description?: string } => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) return {}
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1]!)?.[1]?.trim()
  return { name: field('name'), description: field('description') }
}

/**
 * Reads and writes a superagent's profile. The directory comes from the same rule the Session uses, so the file this edits is
 * the file DSH injects: a bound project directory when the lead bound one, its own directory under the state directory when not.
 */
export class Profiles {
  /**
   * @param stateDir The deployment's state directory, the fallback workspace and the root of each unbound superagent's directory.
   * @param skills The deployment's own skills, by name, read-only here.
   */
  constructor(private readonly stateDir: string, private readonly skills: () => SkillRow[] = () => []) {}

  /** The directory a superagent runs in, created when missing so its `AGENTS.md` can be written. */
  workspace(superagent: Superagent): string {
    const directory = superagentWorkspace(superagent, this.stateDir)
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    return directory
  }
  /** A superagent's profile: its directory, its `AGENTS.md` if it has one, and the skills it can read. */
  read(superagent: Superagent): ProfileView {
    const directory = this.workspace(superagent)
    const path = join(directory, AGENTS_MD)
    // A persona registered before AGENTS.md existed is the brief: seed the file once, so the panel edits the same text DSH
    // injects, and a later edit of the file is never overwritten by the old persona.
    if (!existsSync(path) && superagent.persona?.trim()) writeFileSync(path, `# ${superagent.name}\n\n${superagent.persona.trim()}\n`)
    const agentsMd = existsSync(path)
      ? { path, content: readFileSync(path, 'utf8'), mtime: Math.round(statSync(path).mtimeMs) }
      : null
    return { id: superagent.id, name: superagent.name, directory, agentsMd, skills: this.skillsOf(superagent, directory) }
  }
  /**
   * Write a superagent's `AGENTS.md`. An empty body deletes nothing: it writes an empty brief, which is what a person clearing
   * the box means, and DSH injects nothing for an empty file.
   * @throws AgentsMdConflict when the file changed since `baseMtime`; the caller shows the newer text instead.
   */
  writeAgentsMd(superagent: Superagent, write: AgentsMdWrite): ProfileView {
    const directory = this.workspace(superagent)
    const path = join(directory, AGENTS_MD)
    if (write.content.length > AGENTS_MD_LIMIT) throw new RangeError(`AGENTS.md exceeds ${AGENTS_MD_LIMIT} bytes`)
    if (existsSync(path) && Math.round(statSync(path).mtimeMs) !== write.baseMtime) throw new AgentsMdConflict('AGENTS.md changed since it was read')
    writeFileSync(path, write.content)
    return this.read(superagent)
  }
  /**
   * The skills a superagent can read: the ones the lead bound to it, the deployment's own, and any in its directory's
   * `.agents/skills`. A bound name that the deployment also ships is listed once, as bound.
   */
  skillsOf(superagent: Superagent, directory = this.workspace(superagent)): SkillRow[] {
    const rows = new Map<string, SkillRow>()
    for (const skill of this.skills()) rows.set(skill.name, { ...skill, source: 'deployment' })
    for (const name of superagent.skills ?? []) {
      const known = rows.get(name)
      rows.set(name, { name, description: known?.description ?? '', source: 'bound', path: known?.path ?? '' })
    }
    const local = join(directory, '.agents', 'skills')
    if (existsSync(local)) {
      for (const entry of readdirSync(local)) {
        const path = join(local, entry, 'SKILL.md')
        if (!existsSync(path)) continue
        const { name, description } = splitFrontMatter(readFileSync(path, 'utf8'))
        if (name) rows.set(name, { name, description: description ?? '', source: 'directory', path })
      }
    }
    return [...rows.values()]
  }
  /** The text of one skill's `SKILL.md`, when the superagent can read it. */
  skill(superagent: Superagent, name: string): { name: string; content: string } | undefined {
    const row = this.skillsOf(superagent).find(skill => skill.name === name)
    if (!row?.path) return undefined
    return { name: row.name, content: readFileSync(row.path, 'utf8') }
  }
}
