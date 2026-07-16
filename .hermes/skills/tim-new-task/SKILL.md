---
name: tim-new-task
description: "Create a new Task node in TIM (P0062/Tasks or any project's Tasks section). Enforces detailed body format (Background/Scope/Steps/Verification/Pitfalls). Use before every Worker spawn, before adding a task to a project's roadmap, or when a Worker fails and the Overseer needs to track the retry. Also: recognize a user proposal as a new task vs a Rule vs a Knowledge-Entry, evaluate priority, route to the right project's Tasks section, and report back. The convention 'Tasks = Next Steps, one queue per project' is enforced here (Benni 2026-06-15 refactor of the old Tasks-vs-Next-Steps split)."
triggers:
  # === Direct Task-creation phrasings (DE + EN) ===
  - "new task|task (anlegen|erstellen|create|add)"
  - "Task[- ]?Node|tasknode|new tasknode"
  - "Worker-Spawn vorbereiten|prepare worker spawn"
  - "track (this|my) task|soll ich (tracken|anlegen)"
  - "P00[0-9]{2}.*Tasks"
  - "P00[0-9]{2}.*Tasks section"
  # === User-proposal recognition (Benni-Phrasen) — DE ===
  - "wir (müssen|sollten|koennen) .* (ueberarbeiten|fixen|bauen|implementieren|pruefen|machen|loesen|checken)"
  - "es (muss|muesste) (sichergestellt|geprueft|gemacht|implementiert) sein( dass)?"
  - "deine aufgabe[: ]"
  - "ich habe (eine|ne) (idee|ein thema|was)"
  - "mir faellt (gerade|ein) auf( dass)?"
  - "(was|wie) machen wir (mit|gegenueber|zu) .*\\?"
  - "(wir|ich) (arbeiten|gehen) (an|mit) .* weiter"
  - "es waere (gut|hilfreich|zeit) (wenn|dass)"
  - "koennen wir .* (auch|mal|endlich|noch) (machen|fixen|loesen)"
  - "ich wuerde (gerne|mal) .* (machen|testen|probieren|haben|wollen)"
  - "schreib (das|den) (mal|als|auf) (als )?task"
  - "track (das|den) (doch|mal|bitte)"
  - "prioritaet (setzen|festlegen|hoch|runter)"
  - "(was|wie) (steht|waere|geht) .* (an|offen|zu tun)"
  # === User-proposal recognition — EN ===
  - "we (need|should|must) (to )?(fix|build|implement|check|solve|review|change|overhaul|redesign) .*"
  - "your task[: ]"
  - "i have (an? )?(idea|thought|suggestion)"
  - "i (just )?(noticed|realized) (that )?"
  - "(what|how) (do|should|can) we (do|handle) .*\\?"
  - "let'?s (also )?(work on|fix|build|implement|address) .*"
  - "it (would|should) (be|help) (if|to)"
  - "can we (also|please|finally) .*"
  - "(add|create|track) (this|that|it) as (a )?task"
  - "set (the )?priority"
  - "what'?s (next|open|on (the )?queue|outstanding)"
---

# tim-new-task — Task Node Authoring

PM skill: enforce the canonical Task-node body format in TIM. The body of a Task node is the Worker's contract — without it, Workers improvise, Overseer loses visibility, crash recovery is impossible (overseer Pitfall 12).

Two responsibilities in one skill:
1. **Intake recognition** — recognize a user proposal, classify it (Task vs Rule vs Knowledge-Entry), evaluate it, route it to the right project's Tasks section, report back to the user.
2. **Task-node creation** — enforce the canonical body format and metadata when writing the node.

## Step 0: Intake Recognition (NEW, 2026-06-15)

**The convention (Benni 2026-06-15):** Tasks = Next Steps. One queue per project, sorted by priority. When a user proposes something new, the agent must classify it BEFORE writing.

### Step 0.1: Classify the proposal

| User-Phrasen-Muster (DE / EN) | Classification | Where to put it |
|---|---|---|
| "Wir müssen X bauen/fixen/ändern", "I need to fix X", "lass uns X machen", "Deine Aufgabe: X" | **Task** | Target project's `Tasks` section, with `metadata.task=true`, `status=todo` |
| "Immer wenn ich X sage, musst du Y", "Whenever I say X, do Y", "es muss sichergestellt sein dass..." (deterministisches Verhalten) | **Rule** | Root-level entry with `metadata.type=rule`, or `~/.hermes/rules/` directory. **NOT a Task** — Rules trigger behavior, Tasks are one-time work. |
| "Bedeutet X dass...", "Mir fällt auf dass...", "ist es so dass...", reine Klärungen mit Fakten-Charakter | **Knowledge-Entry** | Root-level entry with `metadata.type=knowledge`, or the project's `Knowledge` section. **Spec still open (P0062/Ideas: "Knowledge-Entries als eigene Entry-Klasse")** — for now, put clarifications in P0062/Log with `kind=knowledge` and a TODO to promote. |
| "Ich hab da ne Idee", "I have an idea" (no commitment to do it) | **Idea** | Target project's `Ideas` section. Promote to Task only when the user commits. |
| "Bug: X geht nicht" | **Bug** | Use `tim-new-error` skill, not this one. |

**Heuristic when ambiguous:** Ask the user with one short question. Better to clarify once than to write in the wrong section.

### Step 0.2: Evaluate the proposal

Before assigning priority, ask:

| Question | Why |
|---|---|
| **Size:** S (≤30 min) / M (1-2 h) / L (≥3 h, multiple files, Worker needed) | Determines whether the Overseer can do it directly or must spawn a Worker |
| **Risk:** data loss? security? silent failure? | Maps to P0 priority if any of these are "yes" |
| **Blocking:** does it block other open tasks? | Map to P0 if yes, P1 if the blocked tasks are P0/P1 |
| **Cost / quota:** does it burn Opus budget / Deepseek balance / many tool-calls? | Routes to delegate_task or Worker, not inline |
| **Focus alignment:** is it on the current focus, or a tangent? | Tangents go to P2/P3 to preserve focus |

### Step 0.3: Assign priority

Use the **P0-P3** taxonomy (preferred) OR **high/medium/low** (legacy, still accepted by MCP). Be consistent per project.

| Prio | Meaning | Examples |
|---|---|---|
| **P0** | Data loss / security / blocking everything / silent failure | DB backup missing, auth bypass, cron causing data corruption |
| **P1** | Regression risk / cost leak / clear improvement | FK bug, expensive query, missing validation |
| **P2** | Quality / UX / tech-debt | Refactor for clarity, skill wording, doc drift |
| **P3** | Cleanup / style / nice-to-have | Typos, dead-code removal, comment improvements |

### Step 0.4: Route to the right project's Tasks section

| Proposal type | Master-Node section | Reason |
|---|---|---|
| Worker-Spawning, Reporting, Cronjobs, Skill-Management, Meta-Infrastructure, Overseer-Workflow | **P0062/Tasks** | bbbee's home project, PM-Workflow |
| TIM-Schema, Section-Design, Task-Node-Konzept, Project-Lifecycle, FTS, MCP-Tools | **P0063/Tasks** | TIM-Design-Themen (the system being designed) |
| Hermes-Code, Gateway, Cron-Scheduler, Config, Profile | **P0064/Tasks** (or whichever Hermes project exists) | Hermes-Code-Themen |
| Repo X (e.g. a new project) | **PXXXX/Tasks** (the respective project) | Project-internal |
| Cross-Cutting: convention touching multiple projects | **Master in the project where the design-drift originates**; other projects via `metadata.cross_project_relevant=["P00XX"]` | Single source of truth for the design, references for downstream effects |

**Always use `parentTitle="Tasks"` + `projectId="P00XX"`** for section resolution. Never hardcode section ULIDs (couples to DB state).

### Step 0.5: Check for higher-priority open tasks

Before committing, query the target project's open tasks:
```
mcp_tim_tim_show what="tasks" root="P00XX" with="open"
```
If the new proposal is P2 and there are 3 P0s and 5 P1s already open, mention this in the report-back so the user can choose to insert the new task or work the higher-priority backlog first.

### Step 0.6: Report back to the user (mandatory)

Use this format (German for PM-Overseer, English for any other context):

```
[Classification] Habe als Task [P2] angelegt in [P0063/Tasks]:
- ULID: ubun-0615-ns-XXXXXXXXXXXXXXXXXXXX
- Summary: <one-line>
- Acceptance criteria: <bulleted>

[Queue context] Aktuell sind noch [N P0, M P1] offen in P0063. Willst du die P0 zuerst, oder dein neues Thema dazwischen schieben?

[Action] Soll ich direkt den Worker spawnen (für L-tasks) oder du bestätigst erst?
```

### Worked example: Benni says "Wir müssen das Task-System überarbeiten"

1. **Trigger matches:** "wir (müssen|sollten|koennen) .* (ueberarbeiten|...)" → yes, skill loads.
2. **Classify:** "ueberarbeiten" = real work, no deterministic behavior, not a clarification. → **Task**.
3. **Evaluate:** touches the Section-Design of TIM. Multi-file (3 skills + memory). ≈ 30-60 min. Prio: P1 (workflow improvement, not data loss). Risk: low. Blocking: no.
4. **Route:** Section-Design of TIM = **P0063/Tasks** (TIM-Design-Themen).
5. **Check open:** `tim_show tasks open root=P0063` → existing P0s in P0063 (none currently, but P0062 has INVENTORY-FIX-05 P0).
6. **Write:** `tim_write(parentTitle="Tasks", projectId="P0063", metadata={task:true, status:todo, priority:high, ...})`.
7. **Report:** "Habe als P1 angelegt in P0063/Tasks. In P0062 sind noch INVENTORY-FIX-05 (P0) und 5 P1 offen. Willst du zuerst die P0 abwarten, oder den Refactor jetzt angehen?"
8. **Wait for user decision** before spawning a Worker (if the task is L-sized).

## When to use

- Before spawning a Worker (every Worker task gets a P0062/Tasks node with `metadata.task=true`)
- After discovering a multi-step project task that should be tracked
- When reconciling missing task nodes (post-session-crash)
- When the user proposes something new in chat and the trigger patterns match

## Background

**Why detailed bodies matter:**
- `process(action='list')` is empty after session restart. Task-Node body IS the recovery artifact.
- Title-only tasks (`content=""`) are dead on session crash — Overseer has no way to re-spawn a Worker without re-reading the spawning Exchange entry.
- Search (`tim_search`) and `tim_tasks()` index title + body. Empty body = invisible.

**Body format** (per overseer Pitfall 12, also enforced in `tim-new-project` and `tim-new-error` siblings):

| Section | Required? | Content |
|---|---|---|
| **Background** | Yes | 2-3 sentences: why this task exists, what triggered it |
| **Scope** | Yes | Bulleted list: what the Worker must do, and what is OUT of scope |
| **Steps** | Yes (if non-trivial) | Numbered procedure with exact commands |
| **Verification** | Yes | Commands the Worker runs to prove the task is done (e.g. `npm test`, `git log`, file-existence checks) |
| **Pitfalls** | Recommended | Known footguns the Worker might hit |
| **Worker-Info** | Yes for spawns | PID, session_id, task-dir, project-dir |
| **Result** | Append on completion | Commit hashes, test counts, files changed, outcome |

## Step 1: Choose the parent section

- **Overseer-spawned Worker task** → P0062/Tasks (master node lives here)
- **Project-internal task** (e.g. a TIM refactor) → P0063/Tasks
- **Bug, decision, log entry** → P0062/{Bugs|Decisions|Log} instead — don't conflate with Tasks

Use `tim_write` with `parentTitle="Tasks"` + `projectId="P0062"` (or P0063) to resolve the section automatically. Never hardcode the section ULID — parentTitle resolves per-project.

## Step 2: Write the body

Use this template (English content, German for PM-Workflow-Skills section titles is fine):

```
## <Action verb> <target>: <one-line summary>

**Background:** <2-3 sentences — what triggered this task, what is the current state>

**Scope:**
- <must-do bullet>
- <must-do bullet>
- OUT OF SCOPE: <explicit exclusion>

**Steps:**
1. <concrete action with command>
2. <concrete action with command>
3. <verification step>

**Verification:**
- `<command>` → <expected output>
- `<command>` → <expected output>

**Pitfalls:**
- <known footgun + mitigation>
```

## Step 3: Set metadata

Required metadata fields:

```json
{
  "task": true,
  "status": "todo",  // or "in_progress" if spawning immediately
  "priority": "P0|P1|P2|P3"  // preferred, see Step 0.3 taxonomy
                            // OR legacy "high|medium|low" (still accepted)
}
```

Optional but recommended:
```json
{
  "owner": "bbbee|worker-name",       // who owns the work
  "scope": "short-tag",               // e.g. "tim-section-design", "pm-workflow"
  "type": "refactor|bug-fix|feature|doc",  // mirrors conventional-commit types
  "cross_project_relevant": ["P00XX"] // when the design affects other projects
}
```

For Worker spawns, also set:
```json
{
  "worker_dir": "~/projects/tasks/task-<slug>/",
  "result_artifact": "~/projects/tasks/task-<slug>/RESULT.md"
}
```

## Promote Idea → Task

Set `metadata.idea.status` to `planned` via `tim_update`. Same entry ID becomes a task under Tasks.

## Coding subtype

For implementation work: `metadata.task.subtype: "coding"`. After commit, append SHAs to `metadata.task.commits` and leave `reviewed: false`. Prefer not setting `done` until review sets `reviewed: true` (rework uses `changes_pending`).

## Step 4: Write the entry

```bash
# Use parentTitle for section resolution
tim_write(
  content="<body from Step 2>",
  parentTitle="Tasks",
  projectId="P0062",  # or P0063 for project-internal
  contentType="text",
  metadata={"task": true, "status": "in_progress", "priority": "high", ...},
  tags=["#task", "#in_progress", "#<topic-tags>"]
)
```

## Step 5: Verify

```bash
# Read back the task to confirm fields are correct
tim_read(id="<returned-task-id>")
# Should show: title, body with all sections, metadata.task=true
```

## Out of Scope

- Creating Project nodes (use `tim-new-project` skill instead)
- Creating Error nodes (use `tim-new-error` skill instead)
- Writing to non-Task sections (Log, Decisions, Bugs, Ideas, Roadmap)
- Executing the task itself — this skill only CREATES the tracker node

## Pitfalls

- **parentTitle is global** — `parentTitle="Tasks"` resolves to whichever project you specified. If you pass `projectId="P0062"` and `parentTitle="Tasks"`, you get P0062/Tasks. If you pass `projectId="P0063"`, you get P0063/Tasks. Never pass parentId as a raw ULID (it works, but couples the skill to a specific DB state).
- **FTS5 search limitations** — `metadata.task:true` does NOT work in `tim_search`. To find task nodes, use section ULID directly or search by title keyword.
- **Overwriting existing tasks** — `tim_write` creates a new entry, but if you reuse a title in the same section, you may get confusion. To update, use `tim_update(id=<existing-id>, ...)`, not `tim_write`.
- **Empty body is the #1 failure mode** (overseer Pitfall 12) — Workers can spawn without a body, but the resulting node is dead. Always fill Background/Scope/Steps/Verification.
- **priority is a string, not a number** — use `"high"`, `"medium"`, `"low"`, not `1/2/3`.
- **status values** — `todo`, `in_progress`, `done`, `cancelled`, `changes_pending` (coding rework). Don't use `"complete"` or `"finished"` (MCP schema rejects them).

## Verification

After creating a Task node:

```bash
# 1. Read back
tim_read(id="<new-id>")  # Should show all sections

# 2. Check metadata
tim_read(id="<new-id>") | jq '.metadata'  # Should show task=true, status=todo|in_progress

# 3. Confirm it appears in tim_tasks()
tim_tasks()  # Should list this node among others

# 4. Tags correct
tim_read(id="<new-id>") | jq '.tags'  # Should include #task
```

## Example: Full Worker-spawn task node

```bash
tim_write(
  content="## TIM-Fixes Batch: Auto-Load cwd-only + tim_read renderDepth-Bug

**Background:** Two TIM bugs in P0063/Tasks. Both in ~/projects/tim, combined into one Worker to share test suite.

**Scope:**
- Fix 1: Auto-Load Hook cwd-only (mirror Hermes statusline pattern from commit 133c5abd3)
- Fix 2: tim_read includeChildren default true (user misdiagnosis: renderDepth was not the actual cause)
- OUT OF SCOPE: Other render tools (tim_search, tim_trace), Codebase section content, Statusline code (different repo)

**Steps:**
1. cd ~/projects/tim && git status (clean)
2. Read P0063/Tasks entry 'Bug-Fix: tim_read soll renderDepths ignorieren'
3. Branch: feature/tim-render-fixes
4. TDD: red test first, then fix, then green
5. 2 separate conventional commits
6. tim_record_commit × 2
7. RESULT.md + JOURNAL.md

**Verification:**
- npm test → 470/470 (was 462)
- npx tsc -b → clean
- git log feature/tim-render-fixes ^master → 2 commits
- node tim-cli doctor → no warnings introduced

**Pitfalls:**
- Don't break renderDepthRead=0 in tim_read_project
- Don't break the Statusline pattern (different repo)
- TDD is mandatory for Fix 2
",
  parentTitle="Tasks",
  projectId="P0062",
  contentType="text",
  metadata={
    "task": true,
    "status": "in_progress",
    "priority": "high",
    "worker_dir": "~/projects/tasks/task-tim-render-and-autoload-fixes/"
  },
  tags=["#task", "#in_progress", "#worker-spawn", "#tim-bugs", "#batch"]
)
```

## Related Skills

- `tim-new-project` — register a new P-entry project in TIM
- `tim-new-error` — log a new E-entry bug in TIM
- `tim-write` — generic write protocol (any entry type, any section)
- `overseer` — PM workflow (Pitfall 12 references this skill)

## References

None — the body is self-contained.
