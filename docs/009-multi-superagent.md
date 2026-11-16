# 009 Multiple superagents

This document describes how dsh-superagent moves from **one orchestrator superagent that routes work to
non-deciding workers** to **a team of superagents**: one lead that admits and coordinates, several
professional superagents that can talk to each other in group and direct chat, and workers that carry
the concrete implementation. It builds on [001 Domain model](001-domain.md), [002 Authorization](002-authorization.md)
and [003 Execution](003-execution.md), and is the design behind the `multi-superagent` fork.

The fork keeps every existing behaviour. Teams are **additive**: a deployment with no team configured runs
exactly the single-superagent system described by the documents before this one.

## Why

A single orchestrator owns all admission and all reporting. Its Session is the one place decisions are
made and the one bottleneck every candidate and every worker report passes through. Splitting the team
into a lead and professional superagents:

- lets each superagent own a **domain and a conversation** (a module, a source, a kind of work) instead
  of one Session juggling everything;
- lets specialists **talk to each other** before work starts, so a division is negotiated and recorded
  rather than inferred by one Session;
- keeps the lead as the **single admission authority**, so the gate, Mandates and Policy stay in one place;
- keeps workers as the **single execution authority**, so implementation stays bounded by a Ticket.

The model follows the group-chat division pattern: a lead closes a discussion, names who does what and in
what order, each member carries its part, reports back, and the lead closes the round. The difference from
a plain chat is that **every message and task is a domain record**, so the same durability, idempotence and
audit that Triggers and Tickets have apply to team talk.

## Roles

| Role | What it is | Where it runs | Decides |
| --- | --- | --- | --- |
| Lead | The admission authority: admits candidates, proposes and dispatches a division, relays results, closes rounds | The main Session (`orchestrator`), extended with team tools | Accept, attach, stop, ignore; who does what |
| Specialist | A professional superagent with its own Session, domain and conversation | A `superagent-<id>` Session under a new preset | Its own task, its messages, and what it delegates to a worker |
| Worker | The concrete executor for a Ticket | A `worker-<ticket>` Session, unchanged | Implementation within its Ticket's Mandate |

The lead **is** the main Session. Specialists are new Sessions. Workers are unchanged.

## Concepts

The domain keeps the existing concepts and adds four. A team is a **conversation between superagents**;
it is not a Source, and its messages are not Triggers.

### Superagent

A first-class agent identity in the domain: `{ id, name, role: 'lead' | 'specialist', capabilities?, directory?, createdAt }`.

- A superagent is the unit of a team's membership and of the Session that runs it.
- `role: 'lead'` names the admission authority. At most one lead exists, and it is the main Session.
- `role: 'specialist'` names a professional superagent. Capabilities are prompt text the lead uses to
  divide work; the core does not interpret them.
- `directory` optionally binds the superagent to its own project directory, so a specialist can be pointed at
  its own checkout or module (one directory per superagent). When it is absent or blank, the runner starts the
  superagent's Session in the machine's **state directory**, as before. The lead sets it through
  `lead_team_create_superagent`; the panel shows it on the team's detail page.
- One writer: the Engine, through the Teams part.

### Team

A conversation between superagents: `{ id, name, kind: 'group' | 'direct', memberIds, leadId, createdAt, closed? }`.

- `kind: 'group'`: several superagents talk in one place. A message reaches every member's Session.
- `kind: 'direct'`: a private conversation between two superagents (lead and one specialist, or two
  specialists). A message reaches only the two members.
- The lead of a group is the member who proposes the division and closes the round. A direct team has no
  lead; either member can propose, and the recipient decides.
- One writer: the Engine, through the Teams part.

### TeamMessage

One message on a team: `{ id, teamId, from, text, at, kind, taskId?, triggerId? }`, where `kind` is
`discussion`, `task`, `report`, `decision` or `notice`.

- `task`: the message that carries a proposed or dispatched task to its assignee.
- `report`: a superagent's report on a task it finished, which other members read.
- `decision`: the lead's closing summary, the "定：" line of a round.
- A message is the unit of a superagent turn's input. A specialist reads the messages of its team and
  answers with its own report.

### TeamTask

A piece of work assigned to one superagent in a team:
`{ id, teamId, assigneeId, text, state, after, outputs, report?, reason?, createdAt, turn? }`.

| `state` | Meaning |
| --- | --- |
| `proposed` | The lead proposed it; not dispatched yet |
| `waiting` | It waits for the members named in `after` to finish |
| `working` | Its assignee's superagent turn is running |
| `done` | Its assignee reported success |
| `failed` | It failed, with `reason` |

- `after`: the member IDs whose tasks this one waits on. It orders work and records dependencies; it never
  routes.
- `outputs`: the deliverable file paths a task declares, checked before the task is treated as done.
- `turn`: the superagent's current turn, shaped like an Assignment (`state`, `createdAt`, `startedAt`,
  `endedAt`, `report`). It is what the `SuperagentRunner` port starts, delivers to and stops.
- A task is proposed once; dispatching it starts its turn. A member runs **one task at a time**; further
  tasks queue behind it.

The dispatch state machine is the one a group division uses:

```mermaid
stateDiagram-v2
  [*] --> proposed: lead proposes
  proposed --> waiting: it has `after`
  proposed --> working: dispatch starts it
  waiting --> working: its `after` tasks are done
  waiting --> failed: an `after` task failed
  working --> done: its assignee reports
  working --> failed: error, stop or no report
  done --> [*]
  failed --> [*]
```

A cycle in `after` fails at dispatch, with a notice, rather than waiting forever.

### Team mandate

A Ticket created by a specialist's delegation carries a mandate whose basis is `{ via: 'team' }`, naming
the team, the task and the lead who authorized it. It is revalidated by whether the team is still open and
the task belongs to it; it does not depend on the admission table, because the lead — not a Source sender —
granted it. This is the one new mandate basis; every other basis is unchanged.

## How a round runs

```mermaid
flowchart TB
  C[Candidate / request] --> L[Lead]
  L -->|propose tasks| T[Team tasks]
  T -->|dispatch| S1[Specialist A]
  T -->|dispatch| S2[Specialist B]
  S1 -->|task reports| T
  S2 -->|task reports| T
  S1 -->|delegate| W[Worker ticket]
  S2 -->|delegate| W
  W -->|ready / blocked| S1
  S1 -->|close: 定| T
  T -->|result| L
  L -->|reply| S[Source channel]
```

1. **Admit.** The lead receives a candidate or an explicit request exactly as today and decides accept,
   attach, stop or ignore. An accepted request may become a **team** instead of a single Ticket: the lead
   proposes who does what.
2. **Propose.** `lead_propose` records the tasks, each with an assignee, its text, the members it waits on
   and the deliverables it declares. They are `proposed`, not yet working.
3. **Dispatch.** `lead_dispatch` moves tasks to `working` as members free up, starting each assignee's
   superagent Session. `waiting` tasks start once their `after` tasks are `done`; a dependency cycle fails
   the cycle at once.
4. **Work.** A specialist reads its task and the team's messages, does the work, and reports with
   `superagent_team_report`: `done` with its outputs, or `failed` with a reason. It may send messages with
   `superagent_team_message` (group or direct) and delegate concrete implementation to a worker with
   `superagent_delegate`, which creates a Ticket under a team mandate.
5. **Close.** When a round's tasks are done or failed, the lead runs a closing turn and records its
   `decision` message. `lead_team_wait` returns the reports so the lead can summarize.
6. **Deliver.** The lead relays the result to the source conversation, exactly as a worker's result is
   relayed today.

A specialist does not admit new work: it can only decide its own task, answer its messages, and delegate
within its task. New admission stays with the lead.

## Where it lives in the code

| Part | Module | Does |
| --- | --- | --- |
| Domain types | `src/core/model.ts` | `Superagent`, `Team`, `TeamMessage`, `TeamTask`, `SuperagentTurn`, the `team` mandate basis, and `superagentWorkspace` (a superagent's directory or the fallback) |
| Port | `src/core/ports.ts` | `SuperagentRunner`: start, deliver and stop a superagent turn; the team repositories |
| Engine part | `src/core/team.ts` | `Teams`: superagent and team records, message routing, the dispatch state machine, closing |
| Engine | `src/core/engine.ts` | The Teams part, the lead and specialist role interfaces, delegation to a Ticket |
| Runner | `src/executor/dsh.ts` | `DshExecutor` implements `SuperagentRunner`: one superagent Session and its turns, launched in the superagent's bound directory or the state directory |
| Sessions | `src/app/sessions.ts` | The `superagent` role, its preset, its prompt and tools |
| Lead tools | `src/app/tools/main.ts` (and `src/app/tools/superagent.ts`) | `lead_team_create_superagent` (including its `directory`), `lead_team_create`, `lead_team_propose`, `lead_team_dispatch`, `lead_team_message`, `lead_team_close`, `lead_team_read` |
| Specialist tools | `src/app/tools/superagent.ts` | `superagent_team_report`, `superagent_team_message`, `superagent_delegate` |
| Prompts | `prompts/` | `lead.md`, `superagent.md`, and the team-communication section |
| Store | `src/app/store.ts`, `src/app/migration.ts` | The `team`, `superagent`, `team_message` and `team_task` tables, schema 12 |
| Effects | `src/app/effects.ts` | `superagent-launch` and `superagent-delivery` |

### Dependency rules kept

- **One writer per state.** Superagents, teams, messages and tasks are written by `Teams`; the
  `SuperagentRunner` only reports facts back (a turn started, inputs delivered, a turn ended, a failure),
  exactly as `DshExecutor` does for tickets.
- **Explicit, narrow dependencies.** `Teams` depends on the repositories, the Policy, the runner port and
  `Tickets` (for delegation). It imports nothing from `src/app`.
- **Team talk is not a Source.** A team's messages never become Triggers, and a team never enters Eval.
  The lead is the only path from a team to a Ticket.
- **The lead stays the admission authority.** Specialists have no `orchestrator_route`, and no tool of
  theirs creates a Ticket except through delegation under a team mandate.

## Persistence and migration

Teams are stored as JSON rows in four tables (`superagent`, `team`, `team_message`, `team_task`), opened
with `CREATE TABLE IF NOT EXISTS` on every start, and the schema version moves from 11 to 12. The schema 12
migration is additive and empty: older databases have no team rows, so nothing is converted. A deployment
that never created a team runs the existing code path untouched.

## Skeleton status

The `multi-superagent` fork delivers the design above as a **runnable skeleton**:

- the four domain concepts, the dispatch state machine, dependency ordering and cycle detection, closing,
  the team-mandate basis, and a superagent's bound project directory (optional, falling back to the state
  directory), with unit tests over in-memory repositories;
- the `SuperagentRunner` port and its `DshExecutor` implementation, with superagent Sessions;
- the lead and specialist tools, and the `superagent` prompt role;
- the team tables and schema 12;
- the Web panel's Team tab: the list of team conversations, one team's tasks and messages, and closing a
  round from the panel.

Deferred to a later change, and not claimed by the skeleton:

- team-aware Source admission (a team still receives work only through the lead);
- automatic division (the lead still proposes explicitly);
- direct superagent-to-superagent ticket hand-off beyond delegation under a team mandate.

## Risks

- **Two admission paths.** Delegation creates a Ticket without a Source Trigger. The team mandate is the
  safeguard; a closed team cannot authorize new work, and a specialist cannot delegate outside its task.
- **Superagent turns are long.** A specialist turn can run far longer than a worker's. The runner bounds it
  and reports a failure rather than hanging, and a turn is stopped when its task ends.
- **Group noise.** The philosophy of [000](000-philosophy.md) still governs: team talk is internal unless a
  person must act or can use a result. The lead relays, specialists do not.
