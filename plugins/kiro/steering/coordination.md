# lockage coordination rules (Kiro Power steering: coordination)

Multiple AI agents develop this repository at the same time. For the conflict-avoidance and PR-publishing procedure,
**follow "Coordination rules (lockage)" in the bundled `AGENTS.md` (`readPowerSteering("lockage", "AGENTS.md")`)**.
Here only the entrance highlights are given; the body of the logic is not duplicated. For details, always treat `AGENTS.md` as the single authority.

> **How to read the canonical source**: this Power's `AGENTS.md` is a copy of the lockage repository's `plugins/shared/AGENTS.md`.
> If the target repository's root has an `AGENTS.md` lockage section, prefer it as that repository's primary over the
> bundled `AGENTS.md` (per the principle at the top of `AGENTS.md`).

## First follow the skill

**Work by following the checklist (Phase 0 through 5) of the copy of the `lockage-workflow` skill (`readPowerSteering("lockage", "lockage-workflow.md")`).**
The skill defines "what to call in what order" in an executable form. This steering and `AGENTS.md`
define "what to keep." Whenever the two diverge, always prefer `AGENTS.md`.

## The work flow (highlights only; details in AGENTS.md)

- **Right after startup**: decide an `agent_id`, confirm there is no duplicate with `read_board(kind:"note")` / `list_claims`,
  and name yourself with `post_board(kind:"note")`.
- **Start work**: `list_tasks(status:"open")` → `claim_task` → `claim_files` → `assign_worktree`.
  Do not snatch a task you could not claim; move to another task.
- **During work**: always edit inside your assigned `worktree_path` (do not touch the main tree directly.
  For details, see `main-tree-guard.md`). Beat the `heartbeat` periodically. Dirty is auto-computed by lockage.
- **Finish work**: commit on the worktree → `task_done`. `needs_review` / `overlaps` is not "stop";
  first resolve, contact and proceed yourself (for details, see `AGENTS.md`).
- **Publish a PR**: do it with `lockage-publish` (for details, see `publish-pr.md`).

For the exact procedure, parameters, handling on failure of each stage, see `lockage-workflow.md` and `AGENTS.md`.

## Guidance for use as a worker in Kiro

Claude Code's lockage plugin has a `lockage-worker` subagent that receives one task and progresses through `task_done`
inside a worktree (its definition is the lockage repository's `plugins/claude/agents/lockage-worker.md`).
Since the means to officially distribute a subagent for a Kiro Power is not yet settled in this Power, this is only guidance.
When you do worker-equivalent work in Kiro's main conversation, follow the highlights of `lockage-worker.md`.

- Before working, read the canonical source (the bundled `AGENTS.md`) and follow the procedure of `lockage-workflow.md`.
- If the lockage MCP tools are unusable (not a single one, or some of the tools you use are missing), do not proceed; report it.
  This mirrors `lockage-worker`'s exception, which arises because a worker is launched solely for a lockage task.
  For ordinary work that is not worker-equivalent, follow `AGENTS.md` (if not a single tool exists, work as usual).
- Since `lockage-publish` is a CLI command, not an MCP tool, if you cannot run it, stop at `task_done` and
  report that the caller needs to publish the PR.
