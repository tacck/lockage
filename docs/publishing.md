# lockage PR publishing operation (publishing — `lockage-publish`)

> 日本語版: [publishing_ja.md](publishing_ja.md)

This document gathers the operational details of the separate bin `lockage-publish`, which picks up `ticket_ready`, pushes the integration branch, and publishes a PR. This is **not** about releasing the npm package — for that (`npm publish`, the version-bump rule), see [`./releasing.md`](./releasing.md); the two share the word "publish" but are unrelated operations. For the user-facing overview, see [`../README.md`](../README.md); for how to develop, build, and test lockage itself, see [`./development.md`](./development.md).

## Overview

A 1-shot command that, on receiving `ticket_ready` (all tasks under a ticket already aggregated into the integration branch), pushes the integration branch to the remote and opens a PR. It also handles the integration-branch cleanup of merged PRs (`reconcile`). Because **"the core does not publish,"** it is a separate bin from the body (the `lockage` MCP server), and authentication is left to the existing login of `gh`/`glab` (lockage holds no tokens).

## Command examples

```bash
# publish unprocessed ticket_ready and clean up merged PRs (full sweep = launching the safety-net path)
lockage-publish --repo-path /abs/path/to/repo

# publish only / reconcile only / a specific ticket only
lockage-publish --repo-path /abs/repo --mode publish
lockage-publish --repo-path /abs/repo --mode reconcile
lockage-publish --repo-path /abs/repo --ticket 01H...
```

## Explanation of `--mode` (both / publish / reconcile)

- `--mode both` (default) = run publish → reconcile in order. Even on the main path invoked limited to `--ticket`, with the default `both`,
  reconcile also runs, so cleanup of merged PRs and closing of tickets happen in the same single run. What `reconcile` handles is
  **① delete the remote/local integration branch → ② `clear_integration_branch` (reset `integration_branch` to NULL) →
  ③ `close_ticket_on_merge` to set the ticket to `closed` (do not leave merged work in `list_tickets(status:"open")`.
  Like `clear_integration_branch`, it is a system operation that does not bump version, so it does not contend over version with a human's concurrent edit) →
  ④ post `pr_merged` → ⑤ release the done-task worktrees under the ticket (`release_ticket_worktrees`)** (the idempotent source of truth).
  `--base` (when omitted, inferred from `main`/`master`/`develop` by what actually exists), `--provider github|gitlab`
  (auto-determined from the origin host). A ticket with unfinished tasks remaining is treated as `skipped_unmerged_tasks`, protecting both the branch and the worktrees, and worktree release is not performed. A worktree with uncommitted changes is not released and remains active.

## Idempotency

With board's `pr_opened`/`pr_merged` as the source of truth, it does not create a duplicate PR, and cleanup happens only once. Even if `gh pr create` fails with "a PR already exists," it folds into the existing PR; "no diff" is skipped; and an unexpected error marks only that ticket `failed` and the batch continues.

## Prerequisites

The publisher is on the same host, the same repo path as the workers (the integration branch exists locally). An integration branch not present locally is not pushed and is skipped.

## Driving

`lockage-publish --repo-path <abs>` is not resident; it is 1-shot. An agent (or the coordinator) launches it by looking at `publisher_status` after setting a task to done or at session end (see "Timing at which an agent invokes lockage-publish" below). Each run publishes unprocessed ticket_ready as PRs and cleans up merged ones. If there is a per-ticket `failed`, exit code 1.

### Safety of concurrent launch

Even if multiple agents launch at once, the publisher serializes per ticket with an advisory lock. A ticket another process is handling is skipped as `skipped` (`reason:"locked"`), and other tickets are not blocked. Duplicate PRs are also prevented by the idempotency with board's `pr_opened`/`pr_merged` as the source of truth.

### Putting it on PATH (installing `lockage-publish`)

To invoke `lockage-publish` directly from PATH, use one of the following.

```bash
# in the directory where you cloned this repository (for development, local operation)
npm run build
npm link            # put lockage-publish on PATH

# or a global install
npm install -g .
```

If you do not want to pollute PATH, you may invoke the built entry directly by absolute path.

```bash
node /abs/path/to/lockage/dist/launcher/publish-cli.js --repo-path /abs/repo
```

### Timing at which an agent invokes `lockage-publish`

The publisher is a 1-shot command and is not resident. Periodic launching by cron is unnecessary; instead, **an agent (or the coordinator) launches it in the following two-stage manner**.

- **Main path (after the last `task_done`)**: the agent that set the last task of a ticket to `task_done` reads `publisher_status`, confirms that the ticket is included in `pending_tickets` (`pending_count>=1`), and launches it limited to its own ticket. Invoke with the default `both` without `--mode` (reconcile runs following publish).

  ```bash
  lockage-publish --repo-path /abs/repo --ticket <ticket_id>   # --mode omitted = default both
  ```

- **Safety net (at session end)**: each agent reads `publisher_status` before ending its session.
  - If `pending_count>0` (something is awaiting a PR), run a full sweep once without `--ticket` (default `both`). This also picks up what other agents missed, all at once.

    ```bash
    lockage-publish --repo-path /abs/repo
    ```

  - If `awaiting_merge_count>0` (a PR was opened but the merged recovery is not done = awaiting cleanup), recover once with `--mode reconcile`. The integration-branch cleanup of merged PRs and the `close` of tickets happen together.

    ```bash
    lockage-publish --repo-path /abs/repo --mode reconcile
    ```

> Do not invoke `--mode publish` alone. Reconcile does not run, and the cleanup after a merged PR (integration-branch cleanup, resetting `integration_branch` to NULL, the `close` of the ticket, posting `pr_merged`) is not performed, so merged tickets keep piling up as `open` (with the default `both`, reconcile also runs every time, even on the main path).

This way, as `ticket_ready` accumulates it is published as PRs, merged ones are cleaned up, and the corresponding tickets become `closed`. Even if multiple agents invoke at once, they are serialized per ticket by the advisory lock, and a ticket being handled is skipped as `skipped` (`reason:"locked"`), so there is no double processing.

## Important operational notes

> ⚠️ **Important operational note**: even if `ticket_ready` appears on the board, no PR is created unless someone launches `lockage-publish`. Even if all tasks become `done`, the integration branch is not pushed and keeps piling up awaiting a PR. In agent-driven operation, **each agent drives the publisher by looking at `publisher_status` "right after setting the last task of the same ticket to `task_done`" and "at session end"** to prevent accumulation (the two-stage manner in the canonical source [`../plugins/shared/AGENTS.md`](../plugins/shared/AGENTS.md): main path = limited to `--ticket`, safety net = full sweep). Accumulation can be observed with the `publisher_status` tool: the unprocessed counts are `pending_count`/`pending_update_count`, the count awaiting recovery of merged ones (a PR was opened but not yet cleaned up, closed) is `awaiting_merge_count`, and the last publishing, merge traces are `last_pr_opened_at`/`last_pr_merged_at`. When `awaiting_merge_count>0`, invoke `lockage-publish --mode reconcile` (or the default `both`) to recover merged PRs (this also sets the corresponding tickets to `closed`).

## Worktrees that fail to release (`list_worktrees` stale)

> ⚠️ **About worktrees that are not released and remain active because of dirty (release failure)**: a worktree with uncommitted tracked changes has its `git worktree remove` rejected because `release_worktree`/`release_ticket_worktrees` prefer data protection without using `--force`, so it is not released and **remains `active` in the ledger** (an intentional design so results are not deleted by mistake; `reason` returns `dirty`/`untracked`). Furthermore, reconcile does not reprocess a ticket that has posted `pr_merged`, so a worktree left active this way is **not reclaimed automatically** (it does not become an orphan, but no automatic retry is applied either — an asymmetry). These release-failure candidates can be observed with `list_worktrees(stale:true)` (lists worktrees that remain active even though they are linked to a done task; filterable by `ticket_id`/`agent_id`). To reclaim one, stash away the remaining diff (commit/`git stash`/discard) and then call `release_worktree` (since it remains `active` in the ledger, it cannot be reclaimed with `reclaim_orphan_worktrees`, which handles only orphans).

## Authentication prerequisite

Creating and pushing a PR is left to the existing login of `gh`/`glab` (`gh auth login` done). Since lockage itself holds no tokens, log in to `gh`/`glab` in advance on the host that runs the publisher. The login state of the executing user of the agent/coordinator that launches it is used.

## Note on same-host operation

Run the publisher on the **same host, same repo path** as the workers. The integration branch to be published must exist locally; running on a different host does not find the integration branch and it is skipped as `branch_not_local`.
