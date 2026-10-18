---
name: "lockage"
displayName: "lockage"
description: "A coordination Power for multiple AI agents to develop in parallel on the same local git repository without conflicts. It provides task claiming (claim), physical isolation via worktree, per-ticket PR publishing via lockage-publish, through MCP tools and a workflow. Use it when handling lockage tickets or tasks, when developing in parallel with multiple agents, and when claiming work / assigning a worktree / task_done / publishing a PR."
keywords: ["lockage", "coordination", "multi-agent", "worktree", "claim", "task_done", "lockage-publish", "merge gate", "ticket", "pull request", "MCP"]
author: "tacck"
---
# lockage

A Power for coordinating to avoid conflicts when multiple AI agents develop at the same time on the same local git repository.
It bundles copies of the coordination rules (AGENTS.md) and the `lockage-workflow` skill as steering.
Registering the lockage MCP server and placing the hooks such as the main-tree edit guard are needed separately (see Prerequisites).

## Overview

This Power achieves coordination with 3 pillars.

1. **Task claiming (claim)** — `claim_task` atomically claims a task so that multiple agents do not
   contend for the same task. A conflict returns `conflict` and does not block.
2. **Physical isolation via worktree** — `assign_worktree` assigns a dedicated git worktree per agent and
   physically isolates edits. The main tree is not edited directly.
3. **Per-ticket PR publishing via `lockage-publish`** — the results of tasks are aggregated into the ticket integration branch,
   and when all tasks become `done`, `lockage-publish` pushes the integration branch and opens a PR.

**A ticket is a unit of work on lockage's ledger and is different from a GitHub Issue.** When the user says
"Issue," it means a GitHub Issue; do not mix it up with a ticket.

For the coordination rules, follow the bundled steering `AGENTS.md` (`readPowerSteering("lockage", "AGENTS.md")`).
For the work procedure, follow the bundled steering `lockage-workflow.md` (a copy of the `lockage-workflow` skill).
Both are copies of the canonical source in the lockage repository's `plugins/shared/`, not content transcribed here.
The session-start hook may also show the path of `steering/AGENTS.md` inside the clone. The content is the same, so you may read either.
If they diverge, the Power and the clone's revisions are out of sync, so follow the Power's side readable via `readPowerSteering` and tell the user about the drift.
However, if the target repository's `AGENTS.md` has a lockage section, prefer it as that repository's rule.

## When to Use This Power

Use this Power at the following times.

- When handling lockage tickets or tasks ("progress a ticket," "start a task," "start work").
  Do not use it when handling only a GitHub Issue.
- When multiple AI agents develop in parallel on the same repository and you want to avoid file or work conflicts.
- When you want to claim work, assign a worktree, and progress through `task_done`.
- When you want to publish a ticket as a PR with `lockage-publish`.

## Available MCP Tools

The tools the lockage MCP server exposes by default (the `core` tools (28)). The role is a one-line summary of the tool table in lockage's own README.md.

In addition, there is the cleanup `publisher` set (acquire_publish_lock and 6 others) that only `lockage-publish` uses, and
the `maintenance` set (reclaim_orphan_worktrees and 3 others) a human uses for maintenance, diagnosis. These are exposed only when enabled at server startup
with the environment variable `LOCKAGE_TOOLSETS` and are not visible to agents. Being invisible is by design, and does not fall under
`AGENTS.md`'s "when not a single tool is found."

The bundled `mcp.json` empties `LOCKAGE_TOOLSETS` and fixes it to `core` regardless of the launching shell's environment variables.
When a human uses the `maintenance` set, write `maintenance` in `LOCKAGE_TOOLSETS` in a separate MCP client's configuration
from the agents (the `publisher` set is enabled by `lockage-publish` itself, so no configuration is needed).

### Task operations

| Tool | Role |
|---|---|
| `create_task` | Create a task (`ticket_id` optional, set dependencies with `depends_on`. The new task only gains incoming edges, so no cycle can form) |
| `add_dependency` | Set a dependency (blocks) between existing tasks (`from_task` blocks `to_task`. Cycles rejected) |
| `list_tasks` | List tasks (with the `version` to pass to claim. Filter by `status`/`assignee`/`ticket_id`/`repo`. Unassigned is `status:"open"`. `ready_only` for only dependency-resolved. For `status:"blocked"` it attaches material for judging orphans) |
| `claim_task` | Atomically claim a task (CAS. A conflict returns `conflict` and does not block) |
| `release_task` | Release a task (`outcome="open"` to make it claimable again/`"abandoned"` to abandon) |
| `block_task` | Interrupt pending a human decision (`in_progress`→`blocked`). Keeps the assignee/worktree and holds indefinitely |
| `resume_task` | The same agent resumes on a human's "continue" instruction (`blocked`→`in_progress`) |
| `handoff_task` | Transfer a `blocked` task to another worker as a whole worktree unit (only on explicit human instruction) |
| `task_done` | Complete a task and send it to the integration merge gate (on success `done`) |
| `heartbeat` | Report liveness to extend the lease of a task/claim, and auto-compute the worktree's dirty. Also returns `unread_count` / `unread_preview` (newest 3 unread board posts) without marking them read |

### Ticket operations

| Tool | Role |
|---|---|
| `open_ticket` | Open a ticket (`repos` omitted/empty = involved in any repo. The body is full-text searchable) |
| `update_ticket` | Update a ticket (version-CAS. A conflict returns `conflict` and does not block) |
| `list_tickets` | List/search tickets (`status`/`repo`/`query` for FTS5 full-text search) |
| `read_ticket` | Get one ticket (includes `integration_branch`/`ticket_ready_at`/`repos`) |
| `link_task_to_ticket` | Re-link a task to its parent ticket (`ticket_id=null` to unlink) |

### File coordination (advisory)

| Tool | Role |
|---|---|
| `claim_files` | Declare your area with globs (overlaps warn only, do not block) |
| `release_claim` | Explicitly release a claim |
| `list_claims` | Return the list of currently valid claims |
| `publish_dirty` | Publish changed files and wake the overlapping party (take the union with the auto-computed dirty) |
| `list_dirty` | Return the list of the dirty set (the union of explicitly published entries and git-derived auto-computed ones) |

### Context sharing (board)

| Tool | Role |
|---|---|
| `post_board` | Post to the shared board (specify `to_agent` for a directed handoff). The post becomes unread for its recipient (or for everyone else, without `to_agent`) |
| `read_board` | Read the board (incremental fetch with a `since` cursor. To see only unresolved questions, `kind:"question", unresolved_only:true`). `agent_id` + `unread_only:true` returns only your unread posts (100 by default, changeable with `limit`) and marks them read; it cannot be combined with `since` / `to_agent` / `kind` / `unresolved_only` |
| `resolve_question` | Mark a question resolved (a complement to auto-resolution. Idempotent) |

### worktree

| Tool | Role |
|---|---|
| `assign_worktree` | Assign a git worktree for physical isolation (idempotent reuse) |
| `release_worktree` | Release a worktree (keeps the branch by default. On a remove failure keeps active and returns a reason) |
| `list_worktrees` | Return the list of valid worktree assignments (filter by `agent_id`/`ticket_id`. `stale:true` for only release-failure candidates) |

### PR publishing observation

| Tool | Role |
|---|---|
| `publisher_status` | Observe the counts and lists awaiting PR publishing, awaiting update, awaiting merge (read-only) |

### Waiting (A2A wake)

| Tool | Role |
|---|---|
| `wait_for_unblock` | Block with a long-poll until one of "dependency ready/unread board post addressed to you or to all/overlap/timeout" and return the reason. Posts that arrived while you were not waiting also wake it; returned posts are marked read |

> **`lockage-publish` is a CLI command, not an MCP tool** (bin: `dist/launcher/publish-cli.js`).
> It is not included in the table above. To publish a PR, invoke `lockage-publish --repo-path <absolute path> --ticket <ticket_id>` with Bash and the like
> (for details, see steering `publish-pr.md`).

## Steering

Read the relevant steering according to the user's situation (Kiro's `readPowerSteering` equivalent).

- **The full coordination rules** (what to keep. Read before starting work) → `readPowerSteering("lockage", "AGENTS.md")`
- **The work-procedure checklist** (Phase 0 through 5. What to call in what order) → `readPowerSteering("lockage", "lockage-workflow.md")`
- **The whole flow, entrance of coordinated development** (claim → worktree → `task_done`) → `readPowerSteering("lockage", "coordination.md")`
- **The guard against editing the main tree directly** (enforcing worktree isolation) → `readPowerSteering("lockage", "main-tree-guard.md")`
- **The PR-publishing trigger** (turn a ticket into a PR with `lockage-publish`) → `readPowerSteering("lockage", "publish-pr.md")`

`coordination` / `main-tree-guard` / `publish-pr` do not duplicate the body of the coordination rules; they reference the bundled `AGENTS.md` as authoritative.
For the execution-procedure checklist, follow `lockage-workflow.md`.

## Onboarding

The main path to start using the hooks (the main-tree edit guard and the context injection at session start) is to run the following in the target repository.

```bash
npx -y lockage setup kiro
```

This generates `lockage-guard.json` (main-tree edit guard) and
`lockage-session.json` (`SessionStart` context injection) in the target repository's `.kiro/hooks/`. The command is of the form `npx -y lockage hook ...`, and
**no manual replacement of absolute paths is needed** (the session hook's `--agents-md` is filled with the absolute path of
the target repository's `.kiro/steering/AGENTS.md`). If a hook with the same content already exists, it is `unchanged`; if the content differs, it is not overwritten
until you add `--force`. Even if you run it inside a worktree, the hooks are placed in the main repository's `.kiro/hooks/`.

Registering the MCP server (the `mcp.json` of `npx -y lockage`) is needed separately (see Prerequisites). If you do not use the hooks and
keep the rules of `main-tree-guard.md` yourself, you may skip this procedure.

In an environment where `npx -y lockage` is unavailable (offline, internal-registry constraints, etc.), or when you want to adjust the generated
files by hand, follow Prerequisites' "Alternative when not using setup" to copy the bundled templates by hand.

## Prerequisites

**The setup required differs between launching the MCP server and the hooks.** Both the MCP server and the hooks launch the npm-published artifact with `npx`,
so neither a clone nor `npm run build` is needed.

- The lockage MCP server is registered in `mcp.json` and connectable. This Power's bundled `mcp.json` is in a form that
  launches with `npx -y lockage`, and **is usable as-is with no placeholder replacement**.
  For launching the MCP server alone, neither a clone nor `npm run build` is needed (`npx` fetches and launches the npm-published artifact).
- To use the main-tree edit guard and the context-injection hook at session start, run
  `npx -y lockage setup kiro` (see Onboarding) in the target repository and have `.kiro/hooks/lockage-guard.json`, `lockage-session.json`
  placed. The hook commands are of the form `npx -y lockage hook ...`, so neither a clone nor `npm run build` is needed
  (`npx` fetches and launches the npm-published artifact). You can work without the hooks, but main-tree edits are not stopped
  (keep the rules of `main-tree-guard.md` yourself).
- **Alternative when not using setup.** When `npx -y lockage` is unavailable/you want to adjust the generated files by hand, copy the
  bundled templates in the clone's `plugins/kiro/hooks/` into the target's `.kiro/hooks/`. Replace `lockage-session.json`'s
  `--agents-md "<ABSOLUTE_PATH_TO_STEERING_AGENTS_MD>"` with the absolute path of the target's `.kiro/steering/AGENTS.md`
  (`lockage-guard.json` needs no replacement). For the procedure, see "Kiro (Power)" in the lockage repository's `plugins/README.md`.
- Node.js `>= 22.5`.
- The DB (ledger) storage location uses the default `~/.lockage/lockage.sqlite` (the parent directory is created automatically).
  The default is fine; only those who want to change the location add `env.LOCKAGE_DB` (absolute path to the ledger) to `lockage` in `mcp.json`.
- All coordinating agents point at the **same `LOCKAGE_DB`** (the same ledger DB file).
  If you align everyone on the default (`~/.lockage/lockage.sqlite`), everyone points at the same default, so no special configuration is needed.
  If someone changes the location, align everyone to point at the same `LOCKAGE_DB`.
  If this is not aligned, claim, dirty, board are not shared and conflict avoidance does not work.
- Use a lockage body built (`npm run build`) at the same revision as this Power. When you update lockage,
  rebuild and relaunch the MCP server (Kiro). If the versions drift, you get mismatches such as a renamed tool not being found
  or an unknown argument being silently ignored.
- The PR-publishing CLI `lockage-publish` is runnable from Bash. `npm link` it in the lockage body and put it on PATH, or
  run it directly with `node <absolute path to the lockage body>/dist/launcher/publish-cli.js`.
- `lockage-publish` is not an MCP server, so it does not receive `mcp.json`'s `env.LOCKAGE_DB`. When you place the ledger somewhere other than the default
  (`~/.lockage/lockage.sqlite`), add `--db <absolute path to the ledger>` or set the shell environment variable
  `LOCKAGE_DB` to the same path, to show it the same ledger as the MCP server.

## Quick Usage Examples

### Processing one task

User: "progress the first task of this ticket"

→ Read `coordination.md`, and following `lockage-workflow.md`,
claim and isolate with `list_tasks(status:"open")` → `claim_task` → `claim_files` → `assign_worktree`,
implement and commit inside the worktree → progress through `task_done`.

### Publishing a ticket as a PR

User: "all tasks of this ticket are done, so turn it into a PR"

→ Read `publish-pr.md`, confirm there are no remaining tasks with `list_tasks(ticket_id)`,
confirm `publisher_status`, then invoke `lockage-publish --repo-path <absolute path> --ticket <ticket_id>` once
(do not add `--mode`. Add `--db` too when the ledger is placed other than the default).

## Troubleshooting

### The MCP tools (the `lockage` server) are not found

Check the registration in `mcp.json`. Confirm whether `command:npx`, `args:["-y","lockage"]`, `disabled:false`
(the bundled `mcp.json` is in this form and needs no placeholder replacement). Since `npx` fetches
`lockage` from npm and launches it, neither a clone nor `npm run build` is needed to launch the MCP server.
The first time, fetching may take a while.

- **Not a single lockage tool exists:** per AGENTS.md's principle, work as usual without lockage and report it.
- **Only some tools (such as `open_ticket`) are missing:** the lockage body's version is older than this Power. Do not edit files;
  tell the user to rebuild lockage and relaunch Kiro (see Prerequisites).
  Tools of the `publisher`, `maintenance` sets being invisible is by design, so this does not apply.

### `claim_task` returns `conflict`

Another agent took that task first. Do not snatch it; move to another task.

### `task_done` returns `not_assignee`

You are not the assignee (another agent holds it, or the worktree assignment is not linked to that task and is not a rescue target).
Repeating the same call will not pass. Confirm with `list_tasks`; if another agent holds it, do not snatch it, move to another task.
If unassigned, open, confirm the combination of task_id and worktree_path you passed to `task_done` is your own work
(that you did not pass another task's worktree), then pass the version read in `list_tasks` as `expected_version` to
`claim_task` and re-run `task_done`.

Rescue means that a task that lease-expired (heartbeat lapsed, the task's lease expired, and it returned to unassigned, open) is
re-claimed and continued by lockage via a `task_done` from the worktree that was `assign_worktree`'d with that task_id.
If another agent claimed first, it is not rescued. A worktree assigned without passing the task_id is also not rescued.

### `task_done` returns `lease_expired`

The rescue re-claim lost to another update conflict. The task is still unassigned, so wait a few seconds and re-run `task_done`.
Retries are at most 3 times excluding the first call. If `lease_expired` still returns, confirm the task's state with `list_tasks`,
and split by result.

- **Unassigned open**: confirm the combination of task_id and worktree_path is your own work, then pass the version read in `list_tasks` as
  `expected_version` to `claim_task` and re-run `task_done` (if you can claim, you are the assignee so it passes).
  If `claim_task` is `conflict`, re-confirm from `list_tasks`.
- **Another agent holds it**: like `not_assignee`, do not snatch it, move to another task.
- **Otherwise (done, abandoned, etc.)**: leave the reason with `post_board(kind:"question")` and stop. `block_task` works
  only when you are the assignee and in_progress, so call it only then.

### `lockage-publish`'s result is `published: []`

First, with `publisher_status` (the MCP side), see whether the target ticket appears awaiting PR publishing (`pending_tickets`).

- **Not shown**: not all tasks of the target ticket are `done`. Confirm the remaining tasks with `list_tasks(ticket_id)` and
  set the open task to `done` first.
- **Shown yet `published: []`**: `lockage-publish` is looking at a different ledger from the MCP server. If it is the default (`~/.lockage/lockage.sqlite`),
  neither `--db` nor an environment variable is needed. When you added `env.LOCKAGE_DB` to `mcp.json` and placed the ledger other than the default,
  align `--db` or the environment variable `LOCKAGE_DB` to the same path and re-run (see Prerequisites).

### A main-tree edit is rejected by the guard (hook)

You are not working inside a worktree. Move to the `worktree_path` of `assign_worktree` and work.
If rejected, do not redo the same edit by another means such as Bash (for details, see `main-tree-guard.md`).

Kiro's guard, unlike the Claude Code version, rejects without interposing a confirmation. So even work where the user instructed to fix
on the main tree without lockage is rejected. To stop the guard, the user needs to set the environment variable
`LOCKAGE_GUARD_DISABLE=1` and relaunch Kiro, so tell the user that.

### Claim or dirty is not shared between agents

Check whether each agent's `LOCKAGE_DB` points at the same file. If they point at different DBs, the ledger is split and
coordination does not hold (see Prerequisites).
