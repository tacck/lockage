# lockage

> 日本語版: [README_ja.md](README_ja.md)

An MCP server that lets multiple code-development LLMs (Kiro, Claude Code, and others) **collaborate on development centered on a local git repository**.

When you run several agents on the same repository at once, you normally hit problems: "two agents write the same file and break it," "nobody knows who is touching what," and "integration (merging) turns into chaos." lockage solves this by combining **physical isolation via git worktree** with **a lightweight coordination layer on top of SQLite**.

It is a tool aimed at collaboration on a single host (one personal machine).

> This document is for people getting started with lockage. For how to develop, build, and test lockage itself, see [`docs/development.md`](docs/development.md); for the operational details of publishing PRs (`lockage-publish`), see [`docs/publishing.md`](docs/publishing.md).

---

## What makes it distinctive

- **Two layers: physical isolation (worktree) + logical visibility (claim / dirty set)**
  Each agent is physically separated by a git worktree, which makes it impossible for two agents to write the same file at the same time. On top of that sits an advisory coordination layer where agents declare "who is responsible for what." The coordination layer **only warns; it never blocks** (warn-never-block). No hard lock that could cause deadlock is used.

- **Atomic task claim (CAS)**
  A task claim is serialized with SQLite's `BEGIN IMMEDIATE` + version CAS, mechanically preventing two agents from taking the same task (the later one receives `conflict` and is not blocked).

- **Integration merge gate**
  The path that integrates worktree results is serialized through a single gate. **A task under a ticket, regardless of how many tasks there are (even just one), goes through the serial merge gate (1-B) and is aggregated into the ticket integration branch `lockage/ticket/<short-id>`.** Only a minor task with no parent ticket (a task not linked to a ticket) that has no divergence is merged straight into the base branch on the spot (1-C) (if there is divergence or a conflict candidate, it also goes through the serial gate 1-B). Conflict candidates are detected by a 3-way pre-check and **sent back without auto-resolving**, leaving the decision to a human or the assignee.

- **A2A wake eliminates polling**
  Events such as another agent stepping into your area, a dependency task completing, or a message addressed to you — all of these can be awaited with a single `wait_for_unblock` long-poll. The agent no longer needs to busy-poll.

- **SQLite is the single source of truth for state**
  The source of truth for state such as tasks, claims, worktrees, and the board is SQLite. The default location is `~/.lockage/lockage.sqlite` in the home directory (changeable via `LOCKAGE_DB`).

lockage is an MCP server that provides atomic claim, dependency DAG, ticket management, worktree physical isolation, advisory claim/dirty set, integration merge gate, board/A2A wake, and the blocked-interrupt lifecycle.

---

## Requirements

- **Node.js 22.5 or later** (SQLite uses Node's built-in `node:sqlite`, so no native build or extra DB is needed)
- **git** (used for worktree / merge operations)

---

## Setup

No clone or build is required. You only add a definition to your MCP client's configuration that launches the npm-published artifact with `npx` (for the concrete configuration, see "[Registering with an MCP client](#registering-with-an-mcp-client)" below).

```json
{
  "mcpServers": {
    "lockage": { "command": "npx", "args": ["-y", "lockage"] }
  }
}
```

The first run may take a little time to fetch. The DB (ledger) is created at `~/.lockage/lockage.sqlite` by default, so no extra configuration is needed.

To get started you need just two things: **registering with an MCP client** and **distributing the coordination rules** (next section). Line these two up and multi-agent coordination starts working.

### Registering with an MCP client

Add a server definition like the following to the MCP configuration of Kiro / Claude Code / Antigravity, and so on (follow each client's configuration file format. Antigravity uses `~/.gemini/config/mcp_config.json`, and you can also register with `agy mcp add`).

To Kiro's `mcp.json`, add the following definition that launches the npm-published artifact with `npx` (no clone or `npm run build` is needed; the first run may take a little time to fetch).

```json
{
  "mcpServers": {
    "lockage": {
      "command": "npx",
      "args": ["-y", "lockage"],
      "disabled": false
    }
  }
}
```

The DB (ledger) is stored at `~/.lockage/lockage.sqlite` by default (the parent directory is created automatically). The default is fine; only those who want to change the location add `"env": { "LOCKAGE_DB": "/absolute/path/to/your-workspace/.lockage/lockage.sqlite" }` to `lockage`.

When multiple agents coordinate, line everyone up so they **point at the same `LOCKAGE_DB`**. If you leave the default, everyone points at the same default ledger, so no extra configuration is needed. This becomes the shared coordination ledger.

For Claude Code, you do not need to register it here: the lockage plugin (next section) bundles this `npx -y lockage` definition, so installing the plugin registers the server too. If you registered it by hand before, remove that registration to avoid two servers, after moving any `LOCKAGE_DB` in its `env` to the `env` of Claude Code's `settings.json` (for the steps per scope, see [`plugins/README.md`](plugins/README.md#claude-code)).

For clients such as Antigravity where launching from the npm-published artifact has not been confirmed, clone and `npm run build`, then register with the traditional definition that points `command:node`, `args:["/absolute/path/to/lockage/dist/index.js"]`, and `env.LOCKAGE_DB` (for Antigravity, `agy mcp add --env LOCKAGE_DB=<absolute path to the ledger> lockage node <path to the lockage repository>/dist/index.js`).

Do not write `LOCKAGE_TOOLSETS` in an agent's configuration (only the default `core` is visible). Only when a human uses the maintenance/diagnostic tools, add `"LOCKAGE_TOOLSETS": "maintenance"` to the `env` of that MCP client.
With the Claude Code plugin, the bundled server has no `env`, so register a separate server for maintenance only where a human uses it, and remove it when done:

```bash
claude mcp add lockage-maint -s local -e LOCKAGE_TOOLSETS=maintenance -- npx -y lockage@latest
claude mcp remove lockage-maint -s local
```

Give it a command different from the bundled one (here `lockage@latest`). Claude Code merges servers with the same command even when their names and `env` differ, so registering it with `npx -y lockage` would replace the bundled server, and lockage-worker would no longer find its tools (confirmed with Claude Code 2.1.285).

---

## Distributing the coordination rules

Once both registering with an MCP client and distributing these coordination rules are in place, you can get started. After writing the registration in the previous section, go on to deliver the coordination rules to each agent.

**The main path is installation via a plugin / Power.** You can load the coordination rules and hooks on the client side without placing anything in the target repository.

- **Claude Code**: register this repository as a marketplace and install the lockage plugin (`plugins/claude`). The plugin also registers the MCP server.
- **Antigravity**: install with `agy plugin install <local path where you cloned lockage>/plugins/antigravity`.
- **Kiro**: register `plugins/kiro` as a Power and place the hooks into the target's `.kiro/hooks/` (`npx -y lockage setup kiro`).

For the detailed procedure of each, see [`plugins/README.md`](plugins/README.md).

**Manual install for environments that cannot use a plugin / Power**: the canonical source of the coordination rules is [`plugins/shared/AGENTS.md`](plugins/shared/AGENTS.md). Copy it to the root of the target project as `AGENTS.md` and you can have the same coordination rules read (keep a single canonical source and do not transcribe the full text here, to avoid double maintenance).

### Why distribution is needed

Merely registering this server in the MCP configuration does not tell an agent "when, which tool, in what order to call." Only once the instructions required for coordination (the coordination rules in `AGENTS.md` and the lockage-workflow skill) are delivered to each agent does coordination start running as the rules describe.

> 💡 There are only two prerequisites for coordinating multiple agents. **(a)** Everyone's MCP configuration points at **the same absolute `LOCKAGE_DB` path**, and **(b)** each agent names **its own unique `agent_id`** (since a shared `AGENTS.md` cannot write them out in advance, each agent decides its own at startup and confirms uniqueness on the board). Line these two up and coordination runs as the rules describe.

### Mapping of the coordination flow to tools

This is the mapping of which lockage tool the coordination rules (`plugins/shared/AGENTS.md`) call in which situation.

| Flow | Tool to call |
|---|---|
| Task planning (including dependencies) | `create_task` (`depends_on`) / `add_dependency` |
| Find and take a task | `list_tasks(status:"open")` → `claim_task` |
| Get your own workspace | `assign_worktree` (work in the returned `worktree_path`/`branch`; if you cannot move there, request it via `post_board`) |
| Change pre-announcement / conflict detection | `publish_dirty` (watch `overlaps`) |
| Communication / handoff | `post_board` / `read_board` |
| Cannot complete; interrupt / resume | `post_board(kind:"question")` → `block_task` → (if the human says continue) `resume_task` / (if a different worker is named) `handoff_task` |
| Completion / integration | `task_done` (if `needs_review`, look at the returned `contested` to resolve → re-run `task_done`) |
| Publishing a PR (per ticket, agent-driven) | Look at `publisher_status` and launch `lockage-publish` to publish your own ticket (do not run `gh pr create` by hand). For the trigger timing, `--mode`, and operational notes, see [`docs/publishing.md`](docs/publishing.md) |
| Idle | `wait_for_unblock` |

---

## How to set priority

Tasks (`create_task`) and tickets (`open_ticket` / `update_ticket`) can specify a `priority`. For this value, which determines processing order, the following consistent rule is adopted.

- **Larger means higher priority.** `priority` is an integer, default `0`. A task/ticket with a larger value is selected earlier (`list_tasks` / `list_tickets` return results `ORDER BY priority DESC`).
- **Ties at the same priority break by `created_at` ascending** (older first). At the same priority, the one created earlier is processed first.
- **Negative values are allowed.** Since `0` is the default (normal), attach a negative value (e.g. `-10`) to things you explicitly want to defer. There is no upper or lower bound.

### Why "larger means higher"

This tool assumes AI agents pass `priority` over MCP. "Bigger number = stronger (higher priority)" is the most intuitive and least error-prone, so this direction is adopted (with a "`0` is highest" scheme, every new task that defaults to `0` would come to the front, and raising the number would lower the priority — a counterintuitive result).

### Recommended range (a guide)

This is not a strict partition, just a guide to align how values are assigned.

| Value | Meaning |
|---|---|
| `100` | Interrupt (highest; when you want to jump ahead of everything) |
| `10` | High |
| `0` | Normal (default) |
| `-10` | Low (explicitly deferred) |

---

## Provided tools (37)

The following are exposed as MCP tools. `agent_id` is the identifier each agent names (within the single-host trust boundary).

### Tool sets (`LOCKAGE_TOOLSETS`)

By default only the `core` tools that agents use (28) are exposed. The other sets are enabled at server startup with the environment variable `LOCKAGE_TOOLSETS` (comma-separated). For a tool that belongs to a set, the role column in the table below begins with "Set: …".

| Set | How to enable | Tools |
|---|---|---|
| core | Always enabled | Those with no "Set" marked in the table below |
| publisher | Enabled on the server that `lockage-publish` launches itself (no configuration needed) | `acquire_publish_lock` `release_publish_lock` `clear_integration_branch` `close_ticket_on_merge` `release_ticket_worktrees` `release_ticket_claims` |
| maintenance | Write `"LOCKAGE_TOOLSETS": "maintenance"` in the `env` of the MCP client a human uses for maintenance/diagnosis | `reclaim_orphan_worktrees` `process_merge_queue` `list_merge_queue` |

The `publisher` set is for cleanup that, if an agent called it, could close a ticket or clear an integration branch name, so it is not shown to agents.

### Task operations

| Tool | Role |
|---|---|
| `create_task` | Create a task (`ticket_id` is optional; set dependencies with `depends_on`. Cycles are rejected) |
| `add_dependency` | Set a dependency (blocks) between existing tasks (`from_task` blocks `to_task`. Cycles are rejected) |
| `list_tasks` | List tasks (with the `version` to pass to claim. Filter by `status`/`assignee`/`ticket_id`/`repo`. Unassigned is `status:"open"`. `ready_only` for only dependency-resolved ones. For `status:"blocked"` it attaches `blocked_age_sec`/`agent_silent_sec`/`last_question` as material for judging orphans (no auto-reclaim)) |
| `claim_task` | Atomically claim a task (CAS. A conflict returns `conflict` and does not block) |
| `release_task` | Release a task (`outcome="open"` to make it claimable again/`"abandoned"` to abandon) |
| `block_task` | Interrupt pending a human decision (`in_progress`→`blocked`). Keeps the assignee/worktree and is excluded from the lease sweep = held indefinitely. Leave the reason you are stuck first via `post_board(kind="question")` |
| `resume_task` | The same agent resumes when a human instructs "continue" (`blocked`→`in_progress`). Routing to another worker is handoff (only when a human explicitly says so) |
| `handoff_task` | Transfer a `blocked` task to another worker **as a whole worktree unit** (§4.7). In a single CAS transaction, reassign the task/its active worktree/the active claim whose `holder=from` and `task_id` match/the dirty_set of the transferred worktree from `from`→`to` (branch/path unchanged). Double handoff is prevented by a CAS on `assignee=from` and `blocked`. An `in_progress` task cannot be snatched (must be `blocked` first). Making it another worker's is only on explicit human instruction |
| `task_done` | Complete → to the integration merge gate (1-C immediate merge / 1-B serial gate). On merge success, `done` |
| `heartbeat` | Liveness report. Extends the lease of held tasks/claims. Also auto-computes dirty from the git state of the assigned worktree and returns anything outside the claim's globs as `unclaimed` (§52) |

### Ticket operations (an aggregation unit for issues; model 3)

A ticket is a cross-cutting, long-lived, un-claimed aggregation unit for issues. Linked 1 ticket → N tasks via `tasks.ticket_id`.

| Tool | Role |
|---|---|
| `open_ticket` | Open a ticket (`repos` omitted/empty = cross-cutting over all. The body is FTS5-indexed) |
| `update_ticket` | Update a ticket (`version-CAS`. A conflict returns `conflict` and does not block) |
| `list_tickets` | List/search (descending `priority`, older first on ties. `status`/`repo`/`query` for FTS5 full-text search. `limit` defaults to 100. When `repo` is given, cross-cutting ones are included too) |
| `read_ticket` | Get one ticket (includes `integration_branch`/`ticket_ready_at`/`repos`. For the publisher) |
| `clear_integration_branch` | Set: publisher. Reset `integration_branch` to NULL (post-PR-merge cleanup. system column, version-invariant, idempotent) |
| `close_ticket_on_merge` | Set: publisher. Flip a ticket to `closed` after a PR merge (reconcile-only. Following the same idea as `clear_integration_branch`, it is separated from `update_ticket` (version-CAS) and leaves version invariant. Idempotent and one-way via a local CAS on `status != closed`) |
| `link_task_to_ticket` | Re-link a task to its parent ticket (`ticket_id=null` to unlink) |

### File coordination (advisory)

| Tool | Role |
|---|---|
| `claim_files` | Declare your area with globs (overlaps warn only, do not block) |
| `release_claim` | Explicitly release a claim |
| `list_claims` | List currently valid claims |
| `publish_dirty` | Publish changed files and A2A-wake the overlapping party. In addition to explicit publication, lockage auto-computes dirty from the git state of the worktree (`git status` + committed diff from `base_sha`) and includes it in the union, returning anything outside the claim's globs as `unclaimed` (§52. Debounced per worktree at a minimum interval of 30 seconds) |
| `list_dirty` | List the dirty set (the union of explicit `publish_dirty` entries and the git-derived changes of the worktree auto-computed by `heartbeat` and so on) |

### Context sharing (board)

| Tool | Role |
|---|---|
| `post_board` | Post to the shared board (specify `to_agent` for a directed handoff) |
| `read_board` | Read the board (incremental fetch with a `since` cursor. `unresolved_only:true` excludes resolved questions. Combine with `kind:"question"` to see only unresolved questions) |
| `resolve_question` | Mark a question resolved (a complement to auto-resolution. When a task is set done/abandoned, the linked unresolved questions are auto-resolved, so this is for explicitly closing a question with no `ref_task_id` or one a human only answered and wants to close. Idempotent) |

### worktree

| Tool | Role |
|---|---|
| `assign_worktree` | Assign a git worktree for physical isolation (idempotent reuse) |
| `release_worktree` | Release a worktree (keeps the branch by default. On a remove failure it does not set released but keeps active and returns a reason) |
| `list_worktrees` | List valid worktree assignments (filter by `agent_id`, `ticket_id`). With `stale:true`, return only worktrees that remain active even though they are linked to a done task (= candidates whose release failed) (read-only) |
| `reclaim_orphan_worktrees` | Set: maintenance. Enumerate/reclaim orphaned worktrees (`dry_run` enumerates only) |
| `release_ticket_worktrees` | Set: publisher. Release the done-task worktrees under a ticket in bulk (called from reconcile's MERGED path) |
| `release_ticket_claims` | Set: publisher. Release in bulk the claims linked to done/abandoned tasks under a ticket (called from reconcile's MERGED path. A recovery path for leftovers) |

### Merge gate

| Tool | Role |
|---|---|
| `process_merge_queue` | Set: maintenance. Drive the serial merge gate (normally `task_done` drives it automatically. For explicit driving) |
| `list_merge_queue` | Set: maintenance. List the merge queue (filter by `needs_review` and so on) |
| `publisher_status` | Observe from the board the counts and lists of unprocessed `ticket_ready` (awaiting PR), updates awaiting an existing PR, awaiting merge (`pr_opened` done but no `pr_merged` = awaiting reconcile) (`awaiting_merge_count`), the publisher's last-run trace (times of `pr_opened`/`pr_merged`), and each ticket (read-only. Does not launch publish). The three counts are separate observation axes and are not exclusive (in particular, awaiting-update and awaiting-merge can both show the same ticket, so do not simply add them) |

### Publish lock (per-ticket advisory lock)

An advisory lock so that multiple `lockage-publish` processes launched at once do not double-process the same ticket. Following the same idea as the lease/TTL of `claims`, PK=`ticket_id`, so other tickets are not blocked (default TTL 300 seconds. Even if a crash leaves it unreleased, another process can steal it after TTL expiry). Normally `lockage-publish` acquires and releases it internally and automatically, so agents do not need to call it directly.

| Tool | Role |
|---|---|
| `acquire_publish_lock` | Set: publisher. Acquire the per-ticket publish advisory lock (TTL settable with `ttl_sec`. Default 300. On success `{ ok:true, holder }`; if a live lock exists `{ ok:false }`. PK=`ticket_id`, so other tickets are not blocked) |
| `release_publish_lock` | Set: publisher. Release the publish advisory lock (deletes only on a `holder` match = does not delete a lock that is not yours, stolen after TTL expiry) |

### Waiting (A2A wake)

| Tool | Role |
|---|---|
| `wait_for_unblock` | Long-poll. Blocks until one of "dependency task ready / board addressed to you or to all / overlap / timeout," and returns the reason (`woke_by`) |

---

## A typical coordination flow

Everything starts from a ticket. You open what you want to do (an issue or feature) as a ticket, split it into multiple tasks, and agents process them.

1. `open_ticket(body, repos)` opens a ticket (the unit of what you want to do).
2. `create_task(ticket_id, depends_on …)` splits that ticket into one or more tasks (set dependencies with `depends_on`).
3. Agents claim and process each task (see "Processing one task" below).
4. A task under a ticket (even just one) does not get its `task_done` merged straight to the mainline; it is **aggregated into the ticket integration branch `lockage/ticket/<short-id>`** (no special treatment by task count). Only a minor task not linked to a ticket is merged straight into the base branch.
5. When all tasks under the same ticket become `done`, `ticket_ready` is auto-issued (idempotent via CAS), and the publisher (`lockage-publish`) pushes the integration branch → opens a PR to the default branch.

The flow of one agent processing one task:

1. `list_tasks(status:"open")` gets unassigned tasks and their `version`
2. `claim_task(task_id, agent_id, expected_version)` claims it (if there is a conflict, move to another task)
3. `assign_worktree(agent_id, repo_path, task_id)` gets your own dedicated worktree
4. Work in that worktree, publishing files you are about to change with `publish_dirty` as you go (if you overlap with someone else, they notice)
5. After finishing, commit in the worktree, then `task_done(agent_id, worktree_path, branch, repo, task_id)`
   - A task under a ticket (even just one) → if there are no conflict candidates, aggregated into the ticket integration branch via the serial gate (1-B)
   - A task not linked to a ticket → if there are no conflict candidates, merged straight into the base branch (1-C)
   - A conflict candidate exists → sent back to `needs_review`. Look at the returned `needs_review[].contested` (files likely to conflict), resolve in the worktree, and re-run `task_done`
6. When idle, wait for the next event (dependency resolved, communication, overlap) with `wait_for_unblock(agent_id)`

---

## Intended usage flow (user → agent → PR)

This shows the whole lifecycle of how a user uses lockage as a sequence. There are 5 actors:

- **User** (developer): the human who feeds in what they want (a ticket) and reviews/merges the PR.
- **Orchestrator**: the coordinator who wakes multiple workers. May be a human or a dedicated agent (for solo operation it may be absent, in which case the user wakes one worker directly).
- **Worker (agent)**: Claude Code / Kiro, etc. The one that actually writes code. Several run in parallel.
- **lockage**: the MCP server. With SQLite as the single source of truth for state, it provides claim / worktree / board / merge gate.
- **publisher**: `lockage-publish`. A 1-shot command that picks up `ticket_ready`, pushes the integration branch, and opens a PR. It is not resident; it **runs once only when an agent (or the coordinator) invokes it**. The main path is "the agent that set the last task of the same ticket to `task_done` checks `publisher_status` and launches it limited to `--ticket`," and the safety net is "each agent, at session end, looks at `publisher_status` and if anything is unprocessed launches a full sweep once."

```mermaid
sequenceDiagram
    actor User as User
    participant Orch as Orchestrator<br/>(human / dedicated agent)
    participant Agent as Worker<br/>(Claude Code / Kiro)
    participant Lockage as lockage (MCP)
    participant Git as git / worktree
    participant Pub as publisher<br/>(lockage-publish / 1-shot)
    actor Forge as GitHub / GitLab

    Note over User,Lockage: ① Open — turn what you want into a ticket
    User->>Lockage: open_ticket(body, repos)
    User->>Lockage: create_task(ticket_id, depends_on …)

    Note over Orch,Agent: ② Launch — wake a worker (for solo operation the user does it directly)
    User->>Orch: launch a worker (assign an agent_id)
    Orch->>Agent: launch in a worktree (have it read the coordination rules = AGENTS.md)

    Note over Agent,Git: ③ Name & claim — fix your own agent_id and take a task
    Agent->>Lockage: check for duplicates with read_board/list_claims → post_board(note "joined")
    Agent->>Lockage: list_tasks(status:open) → claim_task(CAS)
    Agent->>Lockage: assign_worktree(agent_id, repo, task)
    Lockage->>Git: git worktree add (physical isolation)

    Note over Agent,Lockage: ④ Work — write while making it visible via the coordination layer
    Agent->>Lockage: claim_files(glob) / publish_dirty (wake the party if you overlap)
    Agent->>Git: edit, commit in that worktree

    Note over Agent,Git: ⑤ Complete — to the integration merge gate
    Agent->>Lockage: task_done(worktree, branch, repo, task)
    alt no conflict candidate
        Lockage->>Git: under a ticket → 1-B merge into the integration branch / no ticket → 1-C immediate merge to base → done
    else conflict candidate exists
        Lockage-->>Agent: sent back to needs_review (3-way pre-check)
        Agent->>Git: resolve in the worktree → re-run task_done
    end
    Note over Lockage: all tasks under the ticket done → auto-issue ticket_ready (idempotent CAS)

    Note over Agent,Forge: ⑥ Publish — the agent drives the publisher (does not open PRs by hand)
    Agent->>Lockage: after the last task_done, publisher_status (confirm pending_count>=1)
    Agent->>Pub: lockage-publish --repo-path <abs> --ticket <id> (limited to your own ticket)
    Pub->>Lockage: read_board(ticket_ready) / acquire_publish_lock (per ticket)
    Pub->>Forge: push the integration branch → open a PR (gh / glab)
    Pub->>Lockage: release_publish_lock → post_board(pr_opened)
    Note over Agent,Pub: Safety net: at session end look at publisher_status; if pending_count>0, lockage-publish --repo-path <abs> (full sweep, default both); if awaiting_merge_count>0, --mode reconcile once. Concurrent launches are safe via the advisory lock (a ticket another process is handling is skipped=locked)

    Note over User,Forge: ⑦ Review & merge — the human gate
    User->>Forge: review the PR → merge
    Agent->>Pub: lockage-publish (default both. Use --mode reconcile for a previous session's missed cleanup)
    Pub->>Forge: check prState (MERGED)
    Pub->>Git: delete the remote/local integration branch
    Pub->>Lockage: clear_integration_branch → close_ticket_on_merge(status=closed) → post_board(pr_merged)

    Note over Agent,Lockage: ⑧ Next — when idle, wait via long-poll
    Agent->>Lockage: wait_for_unblock(agent_id)
    Lockage-->>Agent: wake on dependency resolved / board addressed to you / overlap
```

**Key points**:

- **The human touches only the two ends**: the entrance (`open_ticket` / `create_task`) and the exit (reviewing, merging the PR). The middle — claim → worktree → merge gate → publishing the PR — is run automatically by agents and the publisher.
- **Agents do not open PRs by hand**: run through `task_done` and, once all tasks are done, `ticket_ready` is raised automatically. Publishing a PR is not done by running `gh pr create` yourself; instead, **the agent that set the last task to done looks at `publisher_status` and launches `lockage-publish --ticket` once** to drive it (as a safety net, if anything is unprocessed at session end, a full sweep). No resident polling is needed, and even if multiple agents launch at once, the per-ticket advisory lock prevents double processing (a ticket being handled is `skipped`=`locked`).
- **Merging the PR is the human gate**: the integration branch is created automatically, but reflecting it into the mainline (merging the PR) goes through the user's approval (branch protection + merge rights).
- **Solo operation**: if no orchestrator is needed, the user just wakes one worker in any MCP client and the same flow runs.

Publishing a PR is handled per ticket by `lockage-publish` (a separate bin). It is a 1-shot command that picks up `ticket_ready` (all tasks under a ticket already aggregated into the integration branch), pushes the integration branch, and opens a PR to the default branch. For the command's `--mode`, putting it on PATH, the timing at which agents invoke it, and operational notes, see [`docs/publishing.md`](docs/publishing.md).

---

## License

MIT License

Existing projects referenced were used only for design ideas (patterns); no code was reused.
