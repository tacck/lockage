import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { unixNow, type CoordDb } from '../db/index.js';
import { fileIntersect } from './globs.js';
import { git, resolveBaseBranch, short } from './git.js';
import { releaseWorktree } from './worktree.js';
import { postBoard, wake, isReady, resolveQuestionsForTask } from './board.js';
import { completeTask, claimTask } from './claim.js';
import { releaseClaimsForTask } from './files.js';

/**
 * §4.6 Integration merge gate (serialization + 3-way precheck, requirement FR-1.6).
 *
 * Serializes the integration of worktree results back into the mainline through a single gate.
 * Small tasks merge-and-discard immediately (1-C); larger work goes through the serial gate (1-B).
 * Same "never let them happen at the same time" idea as the claim CAS serialization.
 * - FR-1.6.1 = serial queue (one row at a time in ascending seq; no concurrent processing while merging)
 * - FR-1.6.2 = 3-way precheck (files touched by mainline ∩ my dirty set) and the auto/review split
 * - FR-1.6.3 = combined use of 1-C (immediate merge) and 1-B (serial gate)
 *
 * Strict repo scoping: merge-base/diff/merge all run as `git -C <repo>`. The mainline branch name is
 * resolved via resolveBaseBranch(repo) (infers dev/stg/main/master from what actually exists), assuming multi-repo.
 *
 * Phase 1 only goes as far as "detect and send back" for conflicts. Automatic conflict resolution is
 * not included (heavy and unstable).
 */

export interface MergeQueueRow {
  id: string;
  seq: number;
  agent_id: string;
  worktree_path: string;
  branch: string;
  task_id: string | null;
  repo: string;
  state: 'queued' | 'merging' | 'merged' | 'needs_review';
  precheck: string | null;
  enqueued_at: number;
  processed_at: number | null;
  host_id: string;
  origin: string;
  /** Aggregation target branch (A-1). NULL = base (backward compatible). When aggregating onto an integration branch, its name. */
  target_branch: string | null;
}

export interface MergeArgs {
  agentId: string;
  worktreePath: string;
  branch: string;
  repo: string; // filesystem root of the repo (the `git -C` target)
  taskId?: string | null;
  /** Aggregation target branch (A-1). When omitted, resolveBaseBranch(repo). When aggregating onto an integration branch, its name. */
  targetBranch?: string | null;
}

export interface EnqueueResult {
  merge_id: string;
  position: number; // seq
}

export interface MergedEntry {
  task_id: string | null;
  branch: string;
  path: '1-B'; // via process_merge_queue
}
export interface NeedsReviewEntry {
  task_id: string | null;
  branch: string;
  contested: string[];
  /** Error summary when the git merge actually failed (a precheck false-negative slipping through). */
  error?: string;
}
export interface ProcessResult {
  merged: MergedEntry[];
  needs_review: NeedsReviewEntry[];
  /** Peers notified of needs_review via A2A wake (kind='board') + board handoff. */
  wake_targets: string[];
}

export type OnTaskDoneResult =
  | {
    ok: true;
    merged: Array<{ task_id: string | null; branch: string; path: '1-B' | '1-C' }>;
    needs_review: NeedsReviewEntry[];
    wake_targets: string[];
  }
  | {
    ok: false;
    reason:
    | 'no_active_worktree' // no active assignment for (agent_id, worktree_path)
    | 'branch_is_base' // branch equals the base branch (prevents accidental merge into the main tree)
    | 'not_assignee' // the caller is not the assignee (another agent owns it, or the worktree assignment is not tied to that task and is not eligible for rescue). Repeating the same call will not go through
    | 'lease_expired'; // the lease-expiry rescue re-claim lost a race, but the task is still open and unassigned (safe to retry)
    detail: string;
  };

/** Read the dirty set (file array) of the given worktree. Empty array if none. */
function dirtyFiles(cdb: CoordDb, agentId: string, worktreePath: string): string[] {
  const row = cdb.db
    .prepare(
      `SELECT files FROM dirty_sets WHERE agent_id = ? AND worktree_path = ?`,
    )
    .get(agentId, worktreePath) as { files: string } | undefined;
  if (!row) return [];
  try {
    const v = JSON.parse(row.files);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** Clear the dirty-set row of the given worktree (§4.5: cleared on mainline reflection or discard). */
function clearDirty(cdb: CoordDb, agentId: string, worktreePath: string): void {
  cdb.db
    .prepare(`DELETE FROM dirty_sets WHERE agent_id = ? AND worktree_path = ?`)
    .run(agentId, worktreePath);
}

/**
 * Real git conflict detection (mitigation for issue "high-2"). Instead of relying on the advisory
 * dirty set, it uses `git merge-tree` to actually run the 3-way comparison of base/mainline/branch
 * and lets git decide whether they conflict. No false negatives even when the dirty set was never published.
 * @returns the list of conflicting files (empty = can merge cleanly). null when git fails (cannot decide).
 */
function gitConflictFiles(repo: string, baseBranch: string, branch: string): string[] | null {
  try {
    const base = git(repo, ['merge-base', baseBranch, branch]);
    // `git merge-tree --write-tree` (git 2.38+) emits conflicts in a machine-readable form.
    // Even on a non-zero exit the conflict info is written to stdout, so catch the exception and parse it.
    let out: string;
    try {
      out = git(repo, ['merge-tree', '--write-tree', '--name-only', baseBranch, branch]);
      // Not non-zero = no conflict.
      void base;
      return [];
    } catch (e) {
      // merge-tree exits non-zero on conflict. stdout format (--write-tree --name-only):
      //   <tree-oid>\n <conflicting file name>...\n <blank line>\n <"Auto-merging"/"CONFLICT" messages>...
      // The conflicting file names run from the line after line 1 (the tree oid) up to the first blank
      // line. Everything after the blank line is messages, so discard it.
      const stdout = (e as { stdout?: string | Buffer }).stdout;
      if (stdout == null) return null; // cannot parse (old git, etc.) → cannot decide
      const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
      const lines = text.split('\n');
      const files: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '') break; // blank line = end of the info block
        files.push(lines[i]!);
      }
      return files;
    }
  } catch {
    return null; // merge-base etc. unavailable → cannot decide
  }
}

/**
 * Safe merge (mitigation for issues "high-1"/"high-4", Issue #25 option 1).
 *
 * To never touch the main repository's working tree, checkout state, or uncommitted changes,
 * the merge is performed on a **temporary worktree** (Issue #25).
 *   (1) `git(repo, ['worktree', 'add', <tmp>, baseBranch])` checks baseBranch out to a temporary worktree.
 *   (2) `git(<tmp>, ['merge', '--no-ff', ...])` runs the merge on that temporary worktree. Because baseBranch
 *       is a shared ref, on success baseBranch advances to the merge commit as seen from the main repo too.
 *   (3) The temporary worktree is cleaned up with remove/prune regardless of success. On failure, discarding
 *       the whole temporary worktree restores the original state, so `git merge --abort` is unnecessary.
 *
 * 1-C edge case: if baseBranch is currently checked out in the main repo, git refuses the double checkout
 * of the same branch and `worktree add` fails. Only in that case do we merge directly on the main repo
 * without a temporary worktree (the main repo is already on baseBranch, so no checkout and no branch
 * switch happen). Only on failure of the main-repo merge path do we restore with `git merge --abort`.
 *
 * Throws nothing; returns the result `{ ok: true } | { ok: false; error: string }`. Signature unchanged.
 */
function safeMerge(
  repo: string,
  baseBranch: string,
  branch: string,
  pathTag: '1-B' | '1-C',
): { ok: true } | { ok: false; error: string } {
  // Check the main repo's current branch. If it equals baseBranch, worktree add would fail with a
  // double checkout, so merge directly on the main repo (the 1-C edge case). If rev-parse throws
  // (detached HEAD, etc.), conservatively fall back to the temporary-worktree approach.
  let headBranch: string | null = null;
  try {
    headBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    headBranch = null;
  }

  // Invariant (review Issue #3): this headBranch check only looks at the main repo's HEAD.
  // If another worktree holds baseBranch, worktree add fails with a double checkout; it does not
  // enter the edge-case branch and instead returns the `{ ok: false, error: 'worktree add ... failed' }`
  // below. In the current design, assigned-worktree branches use worktree.ts's deterministic naming
  // `lockage/<agent>/<slug>`, which never collides with baseBranch (dev/stg/main/master), so this
  // situation is unreachable. If that naming convention changes in the future, note that the premise
  // here (deciding double-checkout eligibility from the main HEAD alone) breaks.
  if (headBranch === baseBranch) {
    // The main repo is already on baseBranch → merge on the main repo as-is without checkout (no branch switch).
    try {
      git(repo, ['merge', '--no-ff', '-m', `merge ${branch} (${pathTag})`, branch]);
      return { ok: true };
    } catch (e) {
      // Merge failed → abort and restore the main working tree to its original state (high-1/high-4).
      // Regarding review Issue #2 (main repo dirty + edge case + merge failure): with git's real
      // behavior this merge --abort will not drag in and discard uncommitted changes in the main repo.
      //   (a) If uncommitted changes touch a file in the merge, git aborts before the merge starts with
      //       "local changes would be overwritten" (the working tree is not changed at all).
      //   (b) If uncommitted changes are in unrelated files, merge --abort only reverts what the merge
      //       touched back to its pre-merge state, so unrelated uncommitted changes are preserved as-is.
      // In both cases uncommitted changes are not lost. When merge --abort is a no-op (no merge to abort)
      // it exits non-zero, but we swallow that best-effort.
      try {
        git(repo, ['merge', '--abort']);
      } catch {
        /* best effort even if the abort itself fails */
      }
      return { ok: false, error: `merge ${branch} failed: ${errMsg(e)}` };
    }
  }

  // Temporary-worktree approach: merge without touching the main repo at all. The path lives outside
  // the repo (under tmpdir).
  const tmp = join(tmpdir(), `lockage-merge-${ulid()}`);
  try {
    git(repo, ['worktree', 'add', tmp, baseBranch]);
  } catch (e) {
    // worktree add itself failed → nothing was created, so just prune best-effort.
    try {
      git(repo, ['worktree', 'prune']);
    } catch {
      /* best effort */
    }
    return { ok: false, error: `worktree add for ${baseBranch} failed: ${errMsg(e)}` };
  }

  try {
    // Merge on the temporary worktree (git -C <tmp>). On success the shared ref baseBranch advances.
    git(tmp, ['merge', '--no-ff', '-m', `merge ${branch} (${pathTag})`, branch]);
    return { ok: true };
  } catch (e) {
    // Merge failed → discarding the whole temporary worktree restores the original state (merge --abort unneeded).
    return { ok: false, error: `merge ${branch} failed: ${errMsg(e)}` };
  } finally {
    // Clean up the temporary worktree regardless of success (leave no debris). Swallow failures best-effort.
    try {
      git(repo, ['worktree', 'remove', '--force', tmp]);
    } catch {
      /* best effort */
    }
    try {
      git(repo, ['worktree', 'prune']);
    } catch {
      /* best effort */
    }
  }
}

/** Extract a short message from an exception (includes git stderr). */
function errMsg(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  if (err?.stderr != null) {
    return (typeof err.stderr === 'string' ? err.stderr : err.stderr.toString('utf8')).trim().slice(0, 500);
  }
  return err?.message ? err.message.slice(0, 500) : String(e).slice(0, 500);
}

/**
 * Mark a successfully merged task done, record the completion event, and wake dependent agents.
 * - If taskId is null (a merge not tied to a task), the status is left untouched.
 * - completeTask is a CAS (assignee=by and in_progress). If it does not match, the task is not set to
 *   done, but the merge itself succeeded so processing continues (only the status update is skipped).
 * - Once done, send a task_ready wake to the assignees of incomplete tasks this task blocks
 *   (they resume via the task_ready path of wait_for_unblock).
 * @returns completed = whether the task could be set to done (taskId=null has nothing to complete, so true).
 *          woke = array of agent_ids woken by the unblock (reflected into wake_targets).
 */
function finalizeMergedTask(
  cdb: CoordDb,
  by: string,
  taskId: string | null,
): { completed: boolean; woke: string[] } {
  if (!taskId) return { completed: true, woke: [] };
  const r = completeTask(cdb, taskId, by);
  if (!r.ok) {
    // CAS mismatch (lease sweep reopened it, reassigned, etc.). It is merged into the mainline but
    // cannot be set to done = "merged but not done". We do not set done, but the merge succeeded so
    // processing continues.
    return { completed: false, woke: [] };
  }

  // Issue #45 item 1: once the task is done, release the active claims that hold this task_id.
  // We release here because finalizeMergedTask is the only done-confirmation point that both the
  // 1-B (via integration branch) and 1-C (direct to base) paths pass through, and it runs after
  // completeTask succeeds (= merged into the mainline). Release by task_id regardless of holder, so
  // claims made after a handoff are not left behind.
  releaseClaimsForTask(cdb, taskId);

  // Issue #49 auto-resolution (main path, done side): once the task is done, auto-resolve unresolved
  // questions that hold this task as ref_task_id. This is the only done-confirmation point both the
  // 1-B/1-C paths pass through (completion after a handoff also passes here), so no done path's
  // unresolved question is missed. Called after completeTask succeeds (r.ok), so only questions whose
  // done is confirmed by a mainline merge are closed. resolvedBy is the assignee who confirmed done
  // (= by, the one who completed this task). Idempotent (only unresolved ones are targeted).
  resolveQuestionsForTask(cdb, { taskId, resolvedBy: by });

  // Wake the assignees of downstream tasks this task blocks (early unblock notification).
  const downstream = cdb.db
    .prepare(
      `SELECT t.id AS id, t.assignee AS assignee
         FROM task_edges e JOIN tasks t ON t.id = e.to_task
        WHERE e.from_task = ? AND e.kind = 'blocks'
          AND t.assignee IS NOT NULL AND t.status != 'done'`,
    )
    .all(taskId) as unknown as Array<{ id: string; assignee: string | null }>;

  const woke = new Set<string>();
  for (const d of downstream) {
    if (!d.assignee || !isReady(cdb, d.id)) continue; // do not wake if other blockers remain
    wake(cdb, d.assignee, 'task_ready', { reason: 'dependency_done', task: taskId, ready_task: d.id });
    woke.add(d.assignee);
  }
  return { completed: true, woke: [...woke] };
}

/**
 * Compute "files touched by mainline ∩ my dirty set" via a 3-way precheck (§4.6).
 * All repo-scoped (`git -C <repo>`). The mainline branch is resolved via resolveBaseBranch.
 *
 * Mitigation for issue "high-2": a decision that depends on the advisory dirty set produces a false
 * negative when publish_dirty was never called. So also use real git conflict detection
 * (`git merge-tree`), and treat a file as contested if either side flags it (fail-safe). If git cannot
 * decide (old git, etc.), fall back to advisory only.
 * @returns contested = conflict-candidate files (empty = can merge safely).
 */
function threeWayPrecheck(cdb: CoordDb, item: MergeArgs): string[] {
  // A-1: the aggregation target prefers item.targetBranch (integration branch), else base. From here on
  // base/mainFiles/merge-tree are all relative to this target (when aggregating, "files touched by the
  // integration branch ∩ my dirty set").
  const baseBranch = item.targetBranch ?? resolveBaseBranch(item.repo);
  const base = git(item.repo, ['merge-base', baseBranch, item.branch]);
  // Files changed base→mainline (touched by the latest mainline)
  const mainFilesRaw = git(item.repo, ['diff', '--name-only', base, baseBranch]);
  const mainFiles = mainFilesRaw ? mainFilesRaw.split('\n').filter(Boolean) : [];
  const myFiles = dirtyFiles(cdb, item.agentId, item.worktreePath);
  // advisory side: touched by mainline ∩ my dirty set (the strict decision of §4.0)
  const advisory = fileIntersect(mainFiles, myFiles);

  // git-real side: detect real conflicts with merge-tree (no false negative even if dirty was unpublished)
  const gitConflicts = gitConflictFiles(item.repo, baseBranch, item.branch);

  if (gitConflicts === null) return advisory; // git cannot decide → advisory only
  // union of what either side flagged (fail-safe)
  return [...new Set([...advisory, ...gitConflicts])];
}

/**
 * §4.6 enqueue_merge — push a completed worktree onto the serial merge gate (1-B).
 * seq follows the same numbering discipline as board (MAX+1 inside BEGIN IMMEDIATE): monotonically
 * increasing and unique.
 */
export function enqueueMerge(cdb: CoordDb, item: MergeArgs): EnqueueResult {
  const db = cdb.db;
  const now = unixNow();
  const id = ulid();

  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM merge_queue`)
      .get() as { next: number };
    const seq = row.next;
    db.prepare(
      `INSERT INTO merge_queue
         (id, seq, agent_id, worktree_path, branch, task_id, repo, state, precheck,
          enqueued_at, processed_at, host_id, origin, target_branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, NULL, ?, 'local', ?)`,
    ).run(
      id,
      seq,
      item.agentId,
      item.worktreePath,
      item.branch,
      item.taskId ?? null,
      item.repo,
      now,
      cdb.hostId,
      item.targetBranch ?? null,
    );
    db.exec('COMMIT');
    return { merge_id: id, position: seq };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already closed */
    }
    throw e;
  }
}

/**
 * §4.6 process_merge_queue — the serial merge gate (1-B).
 * Processes one row at a time in ascending seq. If a row is already merging, does not process concurrently.
 * If the 3-way precheck finds zero conflict candidates, auto-merge; if there are candidates, send it back
 * as needs_review (no hard block — a human/the assignee resolves it in the worktree).
 * Uses a while loop rather than tail recursion for the next item (avoids stack overflow on long queues).
 */
export function processMergeQueue(cdb: CoordDb): ProcessResult {
  const db = cdb.db;
  const merged: MergedEntry[] = [];
  const needsReview: NeedsReviewEntry[] = [];
  const wakeTargets = new Set<string>();

  while (true) {
    // high-3: atomize "confirm nothing is inflight" and "secure queued→merging" in a single
    // BEGIN IMMEDIATE, turning it into a CAS with a conditional UPDATE + changes check. This way even if
    // multiple processes share the same DB, the same row cannot be set to merging twice (apply the same
    // serialization as the seq numbering to the driving side too).
    let item: MergeQueueRow | undefined;
    db.exec('BEGIN IMMEDIATE');
    try {
      const inflight = db
        .prepare(`SELECT 1 FROM merge_queue WHERE state = 'merging' LIMIT 1`)
        .get();
      if (inflight) {
        db.exec('COMMIT');
        break; // another path is processing
      }
      const candidate = db
        .prepare(
          `SELECT * FROM merge_queue WHERE state = 'queued' ORDER BY seq ASC LIMIT 1`,
        )
        .get() as MergeQueueRow | undefined;
      if (!candidate) {
        db.exec('COMMIT');
        break; // queue empty
      }
      const info = db
        .prepare(
          `UPDATE merge_queue SET state = 'merging' WHERE id = ? AND state = 'queued'`,
        )
        .run(candidate.id);
      if (info.changes === 0) {
        // Another process secured it first. Roll back and re-fetch on the next loop.
        db.exec('COMMIT');
        continue;
      }
      item = candidate;
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already closed */
      }
      throw e;
    }
    if (!item) break;

    const now = unixNow();

    // high-1 (the key one): wrap the entire processing block "after" merging is secured in a try.
    // If `git merge-base`/`git diff` inside threeWayPrecheck throws (nonexistent branch, ENOBUFS,
    // corrupt repo, etc.), without this guard the row stays merging and the inflight check at the top
    // permanently halts the queue thereafter. In catch, terminalize the row as needs_review and notify,
    // then continue the loop (never let the throw escape).
    try {
      const contested = threeWayPrecheck(cdb, {
        agentId: item.agent_id,
        worktreePath: item.worktree_path,
        branch: item.branch,
        repo: item.repo,
        taskId: item.task_id,
        targetBranch: item.target_branch, // A-1: deliver the aggregation target (integration branch) to the precheck (d)
      });

      if (contested.length === 0) {
        // No conflict candidates → real merge. On git failure safeMerge discards the temporary worktree,
        // restores the original state, and returns the result (high-1). The main working tree / checkout
        // state are untouched (Issue #25). A-1(e): the target prefers target_branch (integration branch),
        // else base. safeMerge takes baseBranch as an argument, so the signature is unchanged.
        const baseBranch = item.target_branch ?? resolveBaseBranch(item.repo);
        const res = safeMerge(item.repo, baseBranch, item.branch, '1-B');
        if (res.ok) {
          db.prepare(
            `UPDATE merge_queue SET state = 'merged', processed_at = ? WHERE id = ?`,
          ).run(now, item.id);
          clearDirty(cdb, item.agent_id, item.worktree_path);
          const woke = finalizeMergedTask(cdb, item.agent_id, item.task_id);
          for (const a of woke.woke) wakeTargets.add(a);
          merged.push({ task_id: item.task_id, branch: item.branch, path: '1-B' });
          // A-3 path 1 (this process merged): when aggregating (target_branch present), if this done makes
          // all tasks under the ticket done, emit ticket_ready (idempotent via ticket_ready_at CAS = no
          // double emit with path 2). Only tasks with a ticket_id carry target_branch (decideTarget sets
          // isIntegration=true only when ticket_id is present). Even a 1-task ticket carries target_branch,
          // so it is emitted naturally.
          if (item.target_branch && item.task_id) {
            const ticketRow = db
              .prepare(`SELECT ticket_id FROM tasks WHERE id = ?`)
              .get(item.task_id) as { ticket_id: string | null } | undefined;
            tryEmitTicketReady(cdb, ticketRow?.ticket_id ?? null);
          }
        } else {
          // git merge failed → do not leave it merging; terminalize to needs_review (high-1: prevent queue halt).
          db.prepare(
            `UPDATE merge_queue SET state = 'needs_review', precheck = json(?), processed_at = ? WHERE id = ?`,
          ).run(JSON.stringify({ error: res.error }), now, item.id);
          needsReview.push({ task_id: item.task_id, branch: item.branch, contested: [], error: res.error });
          notifyNeedsReview(cdb, item, [], res.error);
          wakeTargets.add(item.agent_id);
        }
      } else {
        // Conflict candidates → send back as needs_review (a human/the assignee resolves it; no hard block).
        db.prepare(
          `UPDATE merge_queue SET state = 'needs_review', precheck = json(?), processed_at = ? WHERE id = ?`,
        ).run(JSON.stringify({ contested }), now, item.id);
        needsReview.push({ task_id: item.task_id, branch: item.branch, contested });
        notifyNeedsReview(cdb, item, contested);
        wakeTargets.add(item.agent_id);
      }
    } catch (e) {
      // high-1 key: swallow unexpected throws from threeWayPrecheck / finalizeMergedTask / anything else
      // here. Do not leave the row merging; terminalize to needs_review and advance the queue.
      const message = errMsg(e);
      db.prepare(
        `UPDATE merge_queue SET state = 'needs_review', precheck = json(?), processed_at = ? WHERE id = ?`,
      ).run(JSON.stringify({ error: message }), unixNow(), item.id);
      needsReview.push({ task_id: item.task_id, branch: item.branch, contested: [], error: message });
      notifyNeedsReview(cdb, item, [], message);
      wakeTargets.add(item.agent_id);
      // continue the loop (no break/throw) — subsequent queued rows are processed normally.
    }
  }

  return { merged, needs_review: needsReview, wake_targets: [...wakeTargets] };
}

/** Notify the assignee of needs_review via board handoff + A2A wake (§4.6). */
function notifyNeedsReview(
  cdb: CoordDb,
  item: MergeQueueRow,
  contested: string[],
  error?: string,
): void {
  const body = error
    ? `merge failed, needs review: ${error}`
    : `merge needs review: ${contested.join(', ')}`;
  postBoard(cdb, {
    agentId: 'system',
    kind: 'handoff',
    toAgent: item.agent_id,
    body,
    refTaskId: item.task_id,
  });
  wake(cdb, item.agent_id, 'board', {
    reason: error ? 'merge_failed' : 'merge_needs_review',
    task: item.task_id,
    contested,
    error,
  });
}

/**
 * §4.1 decideTarget — decide the aggregation target of a task.
 * - no task_id / no ticket_id (a minor task) → merge directly to base (isIntegration=false)
 * - has ticket_id → always aggregate onto the ticket integration branch regardless of task count (isIntegration=true)
 * Tasks under a ticket always go through the integration branch even for a single task (always return to base via a PR).
 */
function decideTarget(
  cdb: CoordDb,
  item: MergeArgs,
): { branch: string | null; isIntegration: boolean; ticketId: string | null } {
  if (!item.taskId) return { branch: null, isIntegration: false, ticketId: null };
  const row = cdb.db
    .prepare(`SELECT ticket_id FROM tasks WHERE id = ?`)
    .get(item.taskId) as { ticket_id: string | null } | undefined;
  const ticketId = row?.ticket_id ?? null;
  if (!ticketId) return { branch: null, isIntegration: false, ticketId: null };
  // With a ticket_id, aggregate onto the integration branch regardless of the sibling count (the
  // degenerate "direct merge to base" special case is dropped).
  const existing = cdb.db
    .prepare(`SELECT integration_branch FROM tickets WHERE id = ?`)
    .get(ticketId) as { integration_branch: string | null } | undefined;
  const intBranch = existing?.integration_branch ?? `lockage/ticket/${short(ticketId)}`;
  return { branch: intBranch, isIntegration: true, ticketId };
}

/**
 * §4.5 ensureIntegrationBranch — lazily create the ticket integration branch (move git out of the DB transaction).
 * (1) CAS integration_branch NULL→value in the DB (BEGIN IMMEDIATE, first wins). Only the winner proceeds to (2).
 * (2) Idempotently create the git branch outside the transaction (a show-ref guard does nothing if it exists).
 * The gap between (1) and (2) (reserved but no real branch) is filled on the next call by the show-ref guard.
 */
function ensureIntegrationBranch(
  cdb: CoordDb,
  ticketId: string,
  repo: string,
  baseBranch: string,
): string {
  const db = cdb.db;
  const intended = `lockage/ticket/${short(ticketId)}`;

  // (1) Reserve the name (a short CAS; git is not called)
  let branchName = intended;
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = db
      .prepare(`SELECT integration_branch FROM tickets WHERE id = ?`)
      .get(ticketId) as { integration_branch: string | null } | undefined;
    if (cur?.integration_branch) {
      branchName = cur.integration_branch; // already reserved by another worker
    } else {
      db.prepare(
        `UPDATE tickets SET integration_branch = ? WHERE id = ? AND integration_branch IS NULL`,
      ).run(intended, ticketId);
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already closed */
    }
    throw e;
  }

  // (2) Idempotently create the git branch outside the transaction (show-ref guard)
  let exists = false;
  try {
    git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists) {
    git(repo, ['branch', branchName, baseBranch]);
  }
  return branchName;
}

/**
 * §4.3 tryEmitTicketReady — if all tasks under the ticket are done, post ticket_ready to the board (idempotent).
 * The NULL→value CAS on tickets.ticket_ready_at (BEGIN IMMEDIATE, first wins) makes it exactly once even across processes.
 * Called from both done-confirmation paths (this process's merge / another process's follow-up).
 */
function tryEmitTicketReady(cdb: CoordDb, ticketId: string | null): void {
  if (!ticketId) return;
  const db = cdb.db;
  let shouldEmit = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ticket_id = ? AND status != 'done'`)
      .get(ticketId) as { n: number };
    if (remaining.n === 0) {
      const info = db
        .prepare(
          `UPDATE tickets SET ticket_ready_at = ? WHERE id = ? AND ticket_ready_at IS NULL`,
        )
        .run(unixNow(), ticketId);
      if (info.changes > 0) shouldEmit = true; // only the NULL→value CAS winner emits
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already closed */
    }
    throw e;
  }
  if (shouldEmit) {
    // After the CAS succeeds, outside the transaction (postBoard opens its own BEGIN IMMEDIATE, so avoid nesting).
    postBoard(cdb, {
      agentId: 'system',
      kind: 'ticket_ready',
      body: `ticket ${ticketId}: all tasks done. ready to open a PR`,
      refTicketId: ticketId,
    });
  }
}

/**
 * §4.6 is_small_task — is it a "small task safe to merge immediately" (the 1-C decision)?
 * Phase 1 default policy (conservative): only merge immediately when there is no divergence and zero conflict candidates.
 *   (a) no parent ticket (no ticket_id). With a ticket_id it is false regardless of task count
 *       (= never take 1-C; always aggregate onto the integration branch via 1-B and always return to base via a PR), and
 *   (b) base_branch has not advanced past my branch point (mainline unchanged = zero divergence)
 * If neither holds, route it to 1-B. The real conflict decision is finalized in try_immediate_merge.
 */
export function isSmallTask(cdb: CoordDb, item: MergeArgs): boolean {
  // (a) leaf check: with a ticket_id it is always non-leaf (= never 1-C). Only proceed to (b) when absent.
  if (item.taskId) {
    const row = cdb.db
      .prepare(`SELECT ticket_id FROM tasks WHERE id = ?`)
      .get(item.taskId) as { ticket_id: string | null } | undefined;
    const ticketId = row?.ticket_id ?? null;
    if (ticketId) return false; // tasks under a ticket always go via the integration branch (1-B)
  }

  // (b) base-not-advanced check: if merge-base(base, branch) == base's tip, the mainline has not advanced since the branch point
  try {
    const baseBranch = resolveBaseBranch(item.repo);
    const base = git(item.repo, ['merge-base', baseBranch, item.branch]);
    const baseTip = git(item.repo, ['rev-parse', baseBranch]);
    return base === baseTip;
  } catch {
    return false; // if base resolution fails, conservatively route to 1-B
  }
}

/**
 * §4.6 try_immediate_merge — 1-C merge-and-discard immediately.
 * Runs the same 3-way precheck as the serial gate "on the spot for just one item". If there are zero
 * conflict candidates, merge immediately, discard the worktree immediately, and set the task done. If
 * there are candidates, return ok:false and demote to 1-B.
 * @returns ok = merge success, wake_targets = peers woken by the unblock (empty when ok:false).
 */
export function tryImmediateMerge(
  cdb: CoordDb,
  item: MergeArgs,
): { ok: boolean; wake_targets: string[] } {
  const contested = threeWayPrecheck(cdb, item);
  if (contested.length > 0) return { ok: false, wake_targets: [] }; // divergence/conflict candidates → to 1-B

  const baseBranch = resolveBaseBranch(item.repo);
  // On git failure safeMerge discards the temporary worktree and restores the original state (high-4:
  // leave no partial state). The merge runs on the temporary worktree, so the main working tree is untouched (Issue #25).
  const res = safeMerge(item.repo, baseBranch, item.branch, '1-C');
  if (!res.ok) {
    // The immediate merge actually failed (a real conflict that slipped past the precheck, etc.). Do not
    // discard the worktree; demote to 1-B and leave the serial gate to terminalize needs_review + notify.
    return { ok: false, wake_targets: [] };
  }

  clearDirty(cdb, item.agentId, item.worktreePath);
  // Merge succeeded → set the task done and wake the assignees of dependent downstream tasks.
  const fin = finalizeMergedTask(cdb, item.agentId, item.taskId ?? null);

  if (!fin.completed) {
    // mid-C (1-C divergence): merged into the mainline, but completeTask's CAS mismatched so it cannot be
    // set to done (15-minute lease sweep reopened it, reassigned, etc.). Discarding the worktree here
    // would leave "merged into mainline, task not done, worktree gone" with no auto-recovery path. Keep
    // the worktree (keepBranch:true) to preserve a clue for manual recovery.
    return { ok: true, wake_targets: fin.woke };
  }

  // 1-C discards immediately (keep_branch=false). On remove failure, releaseWorktree swallows it and returns removed:false (mid-4).
  releaseWorktree(cdb, {
    agentId: item.agentId,
    worktreePath: item.worktreePath,
    repoPath: item.repo,
    keepBranch: false,
  });
  return { ok: true, wake_targets: fin.woke };
}

/**
 * §4.6 on_task_done — the entry point of the task_done tool (FR-1.6.3).
 *
 * Input validation (misuse prevention; stops accidents where git checkout/merge runs on the main working tree):
 *   - no_active_worktree if there is no active worktree assignment for (agent_id, worktree_path)
 *   - branch_is_base if branch equals the base branch (dev/stg/main/master)
 *   - when task_id is given, not_assignee if the caller is not the assignee (another agent owns it, or
 *     the worktree assignment is not tied to that task and is not eligible for rescue). If the
 *     lease-expiry rescue re-claim lost a race and the task is still open and unassigned, lease_expired
 *
 * After validation passes: a small task (zero divergence, zero conflict candidates) is merged immediately
 * via try_immediate_merge (1-C). If there is divergence/conflict candidates, enqueue it on the serial gate
 * via enqueue_merge and drive it with process_merge_queue (1-B). If the immediate merge hits candidates, it
 * demotes to 1-B (fall-through). 1-B is always the safety net. On a successful merge, set the task done
 * (finalizeMergedTask) and wake dependent downstream assignees.
 */
export function onTaskDone(cdb: CoordDb, item: MergeArgs): OnTaskDoneResult {
  const taskId = item.taskId ?? null;

  // 1) Is there an active worktree assignment (the core check that prevents a direct merge on the main
  //    tree)? Also fetch the worktree row's repo_path. This is the source of truth for the merge's git -C.
  //    Read task_id too: used in 3) below to decide whether the lease-expired owner is eligible for rescue
  //    (whether this worktree assignment is tied to that task). The repo_path resolution logic is unchanged.
  const wt = cdb.db
    .prepare(
      `SELECT repo_path, task_id FROM worktree_assignments
        WHERE agent_id = ? AND worktree_path = ? AND status = 'active' LIMIT 1`,
    )
    .get(item.agentId, item.worktreePath) as
    | { repo_path: string | null; task_id: string | null }
    | undefined;
  if (!wt) {
    return {
      ok: false,
      reason: 'no_active_worktree',
      detail: `no active worktree assignment for agent='${item.agentId}' path='${item.worktreePath}'`,
    };
  }

  // Use the worktree row's repo_path as the source of truth for the repo's FS root (the repo argument the
  // caller passes may be an identifier and breaks when used for git -C — bug 2 found during the smoke test).
  // Old DB rows with NULL repo_path fall back to the repo argument for backward compatibility. All
  // subsequent processing uses this resolved item.
  const resolved: MergeArgs =
    wt.repo_path != null && wt.repo_path !== '' ? { ...item, repo: wt.repo_path } : item;
  item = resolved;

  // 2) Is branch not the same as the base branch (do not target main etc. for a direct merge)?
  let baseBranch: string;
  try {
    baseBranch = resolveBaseBranch(item.repo);
  } catch {
    baseBranch = 'main';
  }
  if (item.branch === baseBranch) {
    return {
      ok: false,
      reason: 'branch_is_base',
      detail: `branch '${item.branch}' is the base branch; a worktree branch is required`,
    };
  }

  // 3) When task_id is given, is the assignee the caller?
  //    Proposal 3 (Issue #51)'s lease-expiry rescue goes here. FEAT-002's piggyback extension removed the
  //    main cause, but if the owner called no lockage tool for a long time, the sweep can still reopen it.
  //    When that owner (= whose worktree assignment is tied to that task and remains active) calls
  //    task_done, if no one has re-claimed it, the owner re-claims it and continues. If another agent has
  //    already claimed it, return not_assignee as before and prevent double work (no stealing).
  //
  //    Approach: make "rescue and re-claim it yourself" the main path (of Proposal 3's two options, take
  //    the one that transparently succeeds on the server side). On a successful rescue it is not
  //    distinguished from a normal task_done. On a failed rescue, split the two cases where the caller's
  //    next move differs into two reasons. If merged into one, the caller cannot tell whether it may retry
  //    the re-claim in case (A).
  //      (A) the caller is not the assignee (another agent owns it, or the assignment is not tied to this
  //          task and is not eligible for rescue) → not_assignee (repeating the same call will not go through)
  //      (B) the re-claim lost the CAS, but the task is still open and unassigned → lease_expired (safe to retry)
  if (taskId) {
    const row = cdb.db
      .prepare(`SELECT assignee, status, version FROM tasks WHERE id = ?`)
      .get(taskId) as
      | { assignee: string | null; status: string; version: number }
      | undefined;
    if (row && row.assignee !== item.agentId) {
      // Decide the rescuable case:
      //   (a) the task has status='open' and assignee IS NULL (= the sweep reopened it on lease expiry and
      //       no one has re-claimed it yet), and
      //   (b) the active worktree assignment fetched at the top is tied to this task_id (= continuation of
      //       the owner's work).
      // Only when both hold does the owner re-claim it. Otherwise (another agent already holds it
      // in_progress, etc.) return not_assignee as before.
      // An assignment with NULL task_id (a leftover from the old path that called assign_worktree without
      // passing task_id) does not satisfy (b), so it is not rescued. When the lease expires the assignee is
      // cleared, so the only remaining evidence that the caller is this task's owner is the assignment's
      // task_id link. With NULL there is no such evidence, and rescuing could pull unrelated work in as this
      // task. In that case too return not_assignee, so the owner re-claims it first and then calls task_done.
      const rescuable =
        row.status === 'open' && row.assignee === null && wt.task_id === taskId;
      if (rescuable) {
        // claimTask is expected_version + CAS (BEGIN IMMEDIATE). Pass the version read here so it detects
        // the "another agent cut in between the read and the claim" race. If it fails on a race, do not
        // rescue; reject (no stealing = prevent double work).
        // Note: claimTask opens its own BEGIN IMMEDIATE, so do not nest another transaction here.
        const claimed = claimTask(cdb, taskId, item.agentId, row.version);
        if (!claimed.ok) {
          // Dispatch by the state at the moment of failure (the current that claimTask re-read within the
          // same transaction). If it is still open and unassigned, only the version moved — a transient
          // race — so lease_expired (retryable). If another agent owns it, the task is gone, etc., not_assignee.
          const current = claimed.reason === 'conflict' ? claimed.current : undefined;
          if (current && current.status === 'open' && current.assignee === null) {
            return {
              ok: false,
              reason: 'lease_expired',
              detail: `task '${taskId}' lease expired and re-claim lost a race; it is still open and unassigned, retry task_done`,
            };
          }
          return {
            ok: false,
            reason: 'not_assignee',
            detail: `task '${taskId}' was reassigned before re-claim (lease expired); assigned to '${current?.assignee ?? '(none)'}', not '${item.agentId}'`,
          };
        }
        // Rescue succeeded → the assignee is back to the owner. Continue as a normal task_done from here.
      } else {
        return {
          ok: false,
          reason: 'not_assignee',
          detail: `task '${taskId}' is assigned to '${row.assignee ?? '(none)'}', not '${item.agentId}'`,
        };
      }
    }
  }

  // Validation passed → decide the aggregation target (A-2). With a ticket_id, always aggregate onto the
  // ticket integration branch. Only minor tasks without a ticket_id merge directly to base (no targetBranch).
  const target = decideTarget(cdb, item);
  if (target.isIntegration) {
    const intBranch = ensureIntegrationBranch(cdb, target.ticketId!, item.repo, baseBranch);
    item = { ...item, targetBranch: intBranch };
  }

  // Merge
  // Note: with a ticket_id, always aggregate onto the integration branch. isSmallTask's (a) check returns
  //       false and does not take 1-C (always goes to 1-B below). Only minor tasks without a ticket_id take
  //       1-C and merge directly to base.
  if (isSmallTask(cdb, item)) {
    const r = tryImmediateMerge(cdb, item);
    if (r.ok) {
      return {
        ok: true,
        merged: [{ task_id: taskId, branch: item.branch, path: '1-C' }],
        needs_review: [],
        wake_targets: r.wake_targets,
      };
    }
    // the immediate merge hit conflict candidates → demote to 1-B (fall-through)
  }
  // mid (2-process miss): keep the merge_id we enqueued. processMergeQueue silently breaks on the side that
  // sees inflight, so if another process handles our item it does not appear in r. Avoid over-engineering;
  // limit it to "fill the final state of our own merge_id into the result" (hand-off policy).
  const { merge_id } = enqueueMerge(cdb, item);
  const r = processMergeQueue(cdb);

  const merged = [...r.merged];
  const needsReview = [...r.needs_review];
  const wakeTargets = new Set(r.wake_targets);

  // If our merge_id is not included in r (= another process handled it, or it was broken out on inflight),
  // fetch the row's current state and reflect it into the result. If state=queued/merging it is "still
  // processing", so leave it untouched.
  const mine = cdb.db
    .prepare(`SELECT * FROM merge_queue WHERE id = ?`)
    .get(merge_id) as MergeQueueRow | undefined;
  if (mine) {
    const alreadyMerged = merged.some((m) => m.task_id === mine.task_id && m.branch === mine.branch);
    const alreadyNeedsReview = needsReview.some(
      (n) => n.task_id === mine.task_id && n.branch === mine.branch,
    );
    if (mine.state === 'merged' && !alreadyMerged) {
      merged.push({ task_id: mine.task_id, branch: mine.branch, path: '1-B' });
      // A-3 path 2 (miss 2): if another process merged our task, the ticket_ready check inside
      // processMergeQueue (path 1) did not run. Fill it here. Only when aggregating (target_branch present).
      // tryEmitTicketReady is idempotent via the ticket_ready_at CAS, so it does not double-emit with path 1.
      if (mine.target_branch) {
        const ticketRow = mine.task_id
          ? (cdb.db
            .prepare(`SELECT ticket_id FROM tasks WHERE id = ?`)
            .get(mine.task_id) as { ticket_id: string | null } | undefined)
          : undefined;
        tryEmitTicketReady(cdb, ticketRow?.ticket_id ?? null);
      }
    } else if (mine.state === 'needs_review' && !alreadyNeedsReview) {
      let contested: string[] = [];
      let error: string | undefined;
      if (mine.precheck) {
        try {
          const p = JSON.parse(mine.precheck) as { contested?: string[]; error?: string };
          contested = p.contested ?? [];
          error = p.error;
        } catch {
          /* if precheck cannot be parsed, leave it empty */
        }
      }
      needsReview.push({ task_id: mine.task_id, branch: mine.branch, contested, error });
      wakeTargets.add(mine.agent_id);
    }
    // queued / merging are not finalized yet (another process is handling them), so do not fill them.
  }

  return {
    ok: true,
    merged,
    needs_review: needsReview,
    wake_targets: [...wakeTargets],
  };
}

/** The merge queue listing in needs_review / all states (for observation). */
export function listMergeQueue(
  cdb: CoordDb,
  state?: MergeQueueRow['state'],
): MergeQueueRow[] {
  if (state) {
    return cdb.db
      .prepare(`SELECT * FROM merge_queue WHERE state = ? ORDER BY seq ASC`)
      .all(state) as unknown as MergeQueueRow[];
  }
  return cdb.db
    .prepare(`SELECT * FROM merge_queue ORDER BY seq ASC`)
    .all() as unknown as MergeQueueRow[];
}
