---
name: lockage-workflow
description: >-
  The workflow skill for lockage coordinated development.
  When handling lockage tickets or tasks — "start work," "changed a file,"
  "finish work," "merged a PR" — follow this skill's checklist to
  call the lockage MCP tools without omission.
  Do not use it when handling only a GitHub Issue.
  Whereas AGENTS.md's coordination rules define "what to keep,"
  this skill provides "what to call in what order" as an executable checklist.
  Use this skill when working on lockage tickets or tasks,
  starting work, committing changes, finishing tasks, or publishing PRs.
  Do not use it for GitHub Issues alone; a lockage ticket is not a GitHub Issue.
  Trigger on phrases like "lockage", "progress a ticket", "start a task",
  "start work", "lockage-publish", "task_done", "claim",
  "start working on ticket", "finish task".
---

# lockage coordinated development workflow

AGENTS.md's "Coordination rules (lockage)" is authoritative. This skill is its execution guide.
Read AGENTS.md for the details of the rules.
When installed via the lockage plugin for Claude Code or Antigravity, AGENTS.md is bundled with the plugin,
and its path is shown at session start (when launched inside a git repository; for Antigravity, before the first model call of a conversation)
(the target repository need not have AGENTS.md). If it is not shown, ask the user for the location.
In Claude Code it is also shown when lockage-worker launches. When you launch lockage-worker, pass the location you know via `agents_md_path`
(for usage, see "What it receives" in Claude Code's plugin `agents/lockage-worker.md`). Antigravity has no lockage-worker, so work in the main conversation without delegating to a subagent.
When installed via the lockage Power for Kiro, copies of AGENTS.md and this skill are bundled as the Power's steering (`AGENTS.md`, `lockage-workflow.md`).
Kiro has no lockage-worker either, so work in the main conversation.
If the target repository's AGENTS.md also has a lockage section, prefer it as that repository's primary over the bundled AGENTS.md.
For work that falls under the top of AGENTS.md's "When the user instructs you not to use lockage," do not use this checklist (follow AGENTS.md's exception rules).

## Phase 0: Session start (once right after startup)

```
□ Decide an agent_id
  → confirm existing agent_ids with read_board(kind:"note")
  → confirm active holders with list_claims / list_worktrees
  → finalize if there is no duplicate
□ post_board(agent_id, kind:"note", body:"<agent_id> joined")
□ Confirm publisher_status
  → if awaiting_merge_count > 0, consider reconcile first
```

> **When a human specified an agent_id**: skip the duplicate check and the naming is unnecessary (handover from a previous session).

## Phase 1: Start work

### 1a. Choosing and claiming a task

```
□ list_tasks(status:"open") to get unassigned tasks and their version
  → reuse an existing task if any (do not create a duplicate task with the same content)
  → if none, create with create_task and link it to a ticket with link_task_to_ticket
  → priority: larger is higher (guide 100=interrupt / 10=high / 0=normal / -10=low).
    It is not "0 is highest." See "How to set priority" below
□ claim_task(task_id, agent_id, expected_version)
  → if ok:false (conflict), move to another task. Do not snatch
□ claim_files(agent_id, globs, task_id) to declare the files you touch by glob
  → globs are repo-relative (the same basis as publish_dirty's files)
  → always pass task_id. task_done, release_task, reconcile release the claim by task_id.
    without it, the claim is not released and keeps being extended by heartbeat
```

### 1b. Worktree assignment

```
□ assign_worktree(agent_id, repo_path, task_id)
  → record the returned worktree_path and branch
  → do all subsequent edits inside this worktree
  → do not edit the main tree directly (the exception is only the top of AGENTS.md's "When the user instructs you not to use lockage")
```

> **base_ref を省くと既定でリモート追跡から切る（Issue #8）**: `base_ref` を省略すると、`assign_worktree` は
> 切る前に `git fetch <remote> <base>` でローカル base をリモート追跡 (`origin/<base>`) に追従させ、
> **`origin/<base>` から worktree を切る**（本流を手で `git pull` しなくても最新から始まる）。
> このとき応答に `base_source:"remote"`、`base_ref_used:"origin/<base>"`、`behind:<件数>`（ローカル base が
> `origin/<base>` から遅れていたコミット数）が返る。**リモートが無いリポジトリや、そのブランチの追跡 ref が
> 取れない場合は従来どおりローカル base から切り**（`base_source:"local"`、`behind:null`）、挙動は変わらない。
> リモート追従を無効化してローカル base から切りたいときは `base_from_remote:false` を渡す。
> なお `base_ref` を明示した呼び出し（後述の follow-up の統合ブランチ指定など）は、`base_from_remote` に関係なく
> その ref をそのまま使う。

## Phase 2: During work

```
□ File changes (dirty) are auto-computed by lockage. Manual publication is unnecessary
  → for your assigned worktree, lockage auto-reflects the union of git status (uncommitted) and
    the committed diff from the branched-off SHA into the dirty set
  → this recomputation runs at the timing of each lockage tool call (including the piggyback on heartbeat).
    whether with Edit or Bash/a script, once you change it, it becomes visible to other agents after the next tool call
□ Only when you want to pre-announce a file you have not written yet,
  publish_dirty(agent_id, worktree_path, files)
  → the explicitly published entries are included in the union of the auto-computed set too
  → if another agent appears in overlaps, contact them with post_board
□ When a file appears in a tool response's unclaimed (= you are touching outside the claim's declaration),
  re-call claim_files(agent_id, globs, task_id) with the globs of that file
  → unclaimed is returned in the response of each tool such as publish_dirty / heartbeat / task_done
□ Call heartbeat(agent_id, task_id) periodically
  → on every commit, and at the latest every 10 minutes (a task's lease is 15 minutes)
  → do not stop it while you continue non-lockage work (build, test, etc.)
□ git commit at each break (on the worktree)
```

> **dirty is auto-computed.** You do not need to manually call publish_dirty every time
> you change a file; it becomes visible to other agents after the next lockage tool call
> (including the piggyback on heartbeat). publish_dirty is not retired; it remains as an auxiliary
> tool used when you want to **pre-announce a file you have not written yet** or to publish explicitly.

> **Why call heartbeat yourself**: a heartbeat piggybacked on another tool call also extends
> the lease of the caller's own in_progress task. However, during time when you call no lockage tool
> at all (such as while running a build or test continuously) no piggyback
> occurs and the lease is not extended. So that this gap does not exceed 15 minutes,
> call heartbeat explicitly.

## Phase 3: Finish work

### 3a. Commit and task_done

```
□ git add && git commit (on the worktree)
  → committed diffs are included in the dirty auto-computation too, so you do not need to call
    publish_dirty at the end (only optionally publish_dirty if there is a file you want to pre-announce)
□ task_done(agent_id, worktree_path, branch, repo, task_id)
  → if needs_review: resolve the conflict → re-commit → re-run task_done
    (consult a human only when a human decision is needed, such as when choosing which change to take requires a design judgment)
  → if ok:false: check the error reason
    → not_assignee: you are not the assignee (another agent holds it, or the worktree
      assignment is not linked to that task and is not a rescue target). Repeating the same call will not pass.
      Confirm with list_tasks; if another agent holds it, do not snatch it, move to another task.
      If unassigned, open, confirm the combination of task_id and worktree_path you passed is your own work,
      then pass the version read in list_tasks as expected_version to claim_task, and re-run task_done
    → lease_expired: the rescue re-claim lost to a conflict. The task is still unassigned, so
      wait a few seconds and re-run task_done. Retries are at most 3 times excluding the first call.
      If lease_expired still returns, confirm the state with list_tasks and split by result
      → unassigned open: confirm the combination of task_id and worktree_path is your own work, then
        pass the version read in list_tasks as expected_version to claim_task, and re-run task_done
        (if you can claim, you are the assignee so it passes). If claim_task is conflict, re-confirm from list_tasks
      → another agent holds it: like not_assignee, do not snatch it, move to another task
      → otherwise (done, abandoned, etc.): leave the reason with post_board(kind:"question") and stop.
        block_task works only when you are the assignee and in_progress, so call it only then
```

> **Lease expiry and rescue**: when heartbeat lapses and a task's lease (15 minutes) expires, the task returns to unassigned (open)
> (lease expiry). Even for a lease-expired task, a task_done from the worktree that was assign_worktree'd with that task_id
> lets lockage re-claim and continue processing (rescue). If another agent claimed first, it is not rescued.
> A worktree assigned without passing the task_id is also not rescued, since it cannot be confirmed to be that task's work.

> **How to close a question**: setting a task to `done` (task_done) or `abandoned`
> (release_task(outcome:"abandoned")) **auto-resolves** any unresolved
> question that has that task as its `ref_task_id` (you need not close it by hand). For a question with no `ref_task_id`,
> or one you want to close with just an answer without resuming the task, close it explicitly with
> `resolve_question(agent_id, message_id)` (idempotent). To see only unresolved ones,
> `read_board(kind:"question", unresolved_only:true)`.

### 3b. Publishing a PR (lockage-publish)

```
□ list_tasks(ticket_id) to confirm the remaining tasks of the same ticket
  → if tasks remain, proceed to the next task (do not publish a PR yet)
  → if all tasks are done ↓
□ publisher_status to confirm pending_tickets / pending_update_tickets
□ lockage-publish --repo-path <repo_path> --ticket <ticket_id>
  → do not add --mode (the default both = publish + reconcile)
  → do not invoke --mode publish alone
```

## Phase 4: Before session end

```
□ Confirm publisher_status
  → pending_count > 0 or pending_update_count > 0:
    lockage-publish --repo-path <repo_path> (full sweep. No --ticket)
  → awaiting_merge_count > 0:
    lockage-publish --repo-path <repo_path> --mode reconcile
  → if all 0, do nothing
```

## Phase 5: After merge (when you did the merge yourself)

```
□ lockage-publish --repo-path <repo_path> --mode reconcile
  → integration-branch cleanup of the merged PR and closing of the ticket
```

## Follow-up tasks (fixes after opening a PR)

When you fix something after opening a PR, such as review feedback, create a new task **linked to the same ticket**
and re-branch from the ticket integration branch to work. Cutting from the default branch would not carry the
earlier fix, so pass the integration branch to `base_ref`.

```
□ read_ticket(ticket_id) to read integration_branch
  → if null, the PR is merged and cleanup is done. Adding a task will not become a PR, so
    instead of a follow-up task, proceed as a new ticket (open_ticket)
  → do not assemble a branch name (a ticket created before the rename stays lockage/issue/<short-id>)
□ create_task(ticket_id:<the same ticket>) to create a follow-up task
□ claim_task(task_id, agent_id, expected_version)
□ assign_worktree(agent_id, repo_path, task_id,
    base_ref:<integration_branch>)
  → omitting base_ref cuts from the (remote-tracking) default branch and would not carry the earlier fix
  → base_ref を明示するとリモート追従 (base_from_remote) は行わず、その統合ブランチからそのまま切る
□ Work → git commit (dirty is auto-computed. publish_dirty only when you want to pre-announce)
□ task_done(agent_id, worktree_path, branch, repo, task_id)
□ lockage-publish --repo-path <repo_path> --ticket <ticket_id>
  → when a done task is added to a ticket that already has a PR, ticket_ready is re-issued and
    appears in publisher_status's pending_update_tickets. lockage-publish treats
    this as a follow-up push to the existing PR
```

> **Note on cleanup**: restoring files broken by mutation testing and the like with `git checkout -- <path>` should be done
> **only after committing**. Restoring while uncommitted rolls back the fixes you made in the meantime too.

## How to set priority

The `priority` (an integer, default `0`) you set when opening with `open_ticket` / `create_task` or revisiting with `update_ticket` is
**larger means higher priority**. `list_tasks` / `list_tickets` are ordered by larger first, and at the same value older first.
It is not "`0` is highest," so attach a negative value to things you want to defer.

| Value | Meaning |
|---|---|
| `100` | Interrupt (when you want to jump ahead of everything) |
| `10` | High |
| `0` | Normal (default) |
| `-10` | Low (explicitly deferred) |

## State-check command list

The procedure to check when a problem occurs:

| Situation | How to check |
|---|---|
| A task's assignee came off | confirm version with `list_tasks` → re-claim with `claim_task` |
| A worktree remains | check with `list_worktrees(stale:true)` |
| Who is touching what | check with `list_claims` / `list_dirty` |
| Whether PR publishing is done | check pending / awaiting_merge with `publisher_status` |
| Other agents' state | check participants with `read_board(kind:"note")` |

## lockage MCP tool parameter cheat-sheet

The following are the parameters of the main tools. The call syntax depends on the tool's environment.

### claim_task
```json
{ "task_id": "<task_id>", "agent_id": "<agent_id>", "expected_version": <number> }
```

### claim_files
```json
{ "agent_id": "<agent_id>", "globs": ["<repo-relative glob>", ...], "task_id": "<task_id>" }
```

Omit `ttl_sec` (default 8 hours). Do not omit `task_id`.

### assign_worktree
```json
{ "agent_id": "<agent_id>", "repo_path": "<repository absolute path>", "task_id": "<task_id>" }
```

`base_ref`（任意）: 切り元ブランチを明示する。省略時は dev/stg/main/master のうち実在する最初のものを使う。
`base_from_remote`（任意、既定 true 相当）: `base_ref` 省略時に、ローカル base をリモート追跡 (`origin/<base>`) に
追従させてから切る。リモートが無い / 追跡 ref が無いときはローカル base から切る。`false` で従来どおりローカルから切る。
`base_ref` を明示したときは無視される。follow-up の統合ブランチ指定（`base_ref:<integration_branch>`）はそのまま使われる。

### publish_dirty
```json
{ "agent_id": "<agent_id>", "worktree_path": "<worktree_path>", "files": ["<relative path>", ...] }
```

### task_done
```json
{ "agent_id": "<agent_id>", "worktree_path": "<worktree_path>", "branch": "<branch>", "repo": "<repository absolute path>", "task_id": "<task_id>" }
```

### publisher_status
```json
{}
```

## Common failures and handling

| Failure | Cause | Handling |
|---|---|---|
| `claim_task` is `conflict` | another agent took it first | move to another task |
| `task_done` is `not_assignee` | you are not the assignee (another agent holds it, or the worktree assignment is not linked to that task and is not a rescue target) | confirm with `list_tasks`. If another agent holds it, do not snatch, move to another task. If unassigned, open, confirm the combination of task_id and worktree_path you passed is your own work, then pass the version read in `list_tasks` as `expected_version` to `claim_task` and re-run task_done |
| `task_done` is `lease_expired` | the rescue re-claim lost to another update conflict (the task is still unassigned) | wait a few seconds and re-run task_done (retries are at most 3 times excluding the first call). If it still returns, confirm the state with `list_tasks` and split. If unassigned open, confirm the combination of task_id and worktree_path, then `claim_task` with the version from `list_tasks` and re-run task_done (if conflict, redo from `list_tasks`). If another agent holds it, do not snatch, move to another task. Otherwise (done, abandoned, etc.), leave the reason with `post_board(kind:"question")` and stop (`block_task` only when you are the assignee and in_progress) |
| `lockage-publish` is `published: []` | not all tasks are done (not shown in pending) | confirm the remaining tasks with `list_tasks`. Set the open task to done first |
| it is in `publisher_status`'s `pending_tickets` yet `published: []` | `lockage-publish` is looking at a different ledger from the MCP server (`lockage-publish` does not receive the MCP registration's `env.LOCKAGE_DB`) | add `--db <absolute path to the ledger>`, or set the shell environment variable `LOCKAGE_DB` to the same path as the MCP registration. The ledger path is in the MCP registration (the client's MCP config `env.LOCKAGE_DB`; the default `~/.lockage/lockage.sqlite` if none). If you cannot read the config, ask the user |
| `publish_dirty`'s `overlaps` has another agent | another agent is editing the same file | contact the party with `post_board` and coordinate |
| cannot move into the worktree | an environment where CWD cannot be changed | ask the user with `post_board(kind:"question")`. Do not start on the mainline (except for work the user instructed to do without lockage) |
