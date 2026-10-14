import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ulid } from 'ulid';
import { unixNow, type CoordDb } from '../db/index.js';
import {
  git,
  resolveBaseBranch,
  resolveRefSha,
  resolveRemoteName,
  fetchBase,
  remoteTrackingRef,
  countBehind,
  safeSlug,
  short,
} from './git.js';

export interface WorktreeAssignment {
  id: string;
  agent_id: string;
  worktree_path: string;
  branch: string;
  task_id: string | null;
  status: 'active' | 'released';
  created_at: number;
  released_at: number | null;
  host_id: string;
  origin: string;
  /** The repo's FS root (the `git -C` target). NULL on old DB rows. */
  repo_path?: string | null;
  /** The commit SHA of the branch point. Used later to compute the diff from base. NULL on old DB rows / resolution failure. */
  base_sha?: string | null;
}

export interface AssignResult {
  worktree_path: string;
  branch: string;
  /** true when an existing active assignment was reused (idempotent call). */
  reused: boolean;
  /**
   * Issue #8: どこから worktree を切ったか。'remote' = リモート追跡 ref（origin/<base> 等）から、
   * 'local' = ローカルの base ブランチから。既存の active 割り当てを再利用した場合（reused=true）は
   * 新たに fetch しないため省略（undefined）。
   */
  base_source?: 'remote' | 'local';
  /**
   * Issue #8: 実際に切り元に使った ref 名（例 'origin/dev' または 'dev'）。再利用パスでは省略。
   */
  base_ref_used?: string;
  /**
   * Issue #8 提案 2: ローカル base がリモート追跡から遅れている件数。計算不能・remote 無し・再利用パス
   * では null。
   */
  behind?: number | null;
}

/**
 * #36 / #41: a helper that realpath-normalizes a path to absorb symlink-resolution differences.
 *
 * `git worktree list --porcelain` may return a normalized path with symlinks resolved (e.g. on macOS
 * `/var/...` → `/private/var/...`). On the other hand, the ledger (worktree_assignments.worktree_path)
 * used to hold the path assignWorktree built with `join(...)` (a path that does not resolve symlinks).
 *
 * The #41 fix made assignWorktree normalize with normalizePath before saving, but existing ledger rows
 * (saved un-normalized before #41) remain with symlinks unresolved, so normalization on the read side of
 * reclaimOrphanWorktrees is still needed as a "backward-compatibility layer for old rows". We do not run a
 * migration to bulk realpath-rewrite existing ledger rows. Reasons:
 *   (1) rows for already-deleted worktrees make realpathSync fail.
 *   (2) it would require touching released history rows too.
 *   (3) normalization on the read side (reclaimOrphanWorktrees) already absorbs matching old rows.
 *
 * realpathSync throws when, e.g., the target does not exist, so in that case best-effort return the input
 * path as-is (cannot normalize = fall back to the original string comparison). In assignWorktree's
 * pre-save normalization (#41) it is called "after the physical worktree is created with git worktree
 * add", so in the normal path it always resolves. In reclaimOrphanWorktrees' read-side normalization
 * (#36), the ledger path of an already-deleted worktree may fall back, in which case we warn via console.error.
 */
function normalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch (e) {
    // When the target does not exist / permission is insufficient, etc., we cannot normalize, so return
    // the input as-is (best effort). But a silent fallback would mean that if only one side fails to
    // normalize and an orphan is misidentified, no one notices in operation. Leave a warning for which
    // path realpathSync failed on (this codebase's convention is to emit diagnostic logs to console.error).
    const detail = e instanceof Error ? e.message : String(e);
    console.error(
      `[worktree] normalizePath: realpathSync failed, using the input path as-is (path=${p}): ${detail}`,
    );
    return p;
  }
}

/** Whether the branch already exists in the repo (local ref). */
function branchExists(repoPath: string, branch: string): boolean {
  try {
    git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * §4.5 Automatic worktree assignment.
 * Physically isolate each agent with a git worktree (the core that makes "two agents writing the same
 * file at once" physically impossible). The advisory claim is the coordination layer on top of this.
 *
 * - Reuse an existing active assignment if present (idempotent).
 * - The branch name/path are deterministic (lockage/<agent>/<slug>). On reconnect you return to the same worktree.
 * - The UNIQUE constraint on worktree_path guarantees "1 worktree = 1 agent" at the DB level.
 *
 * #41 fix: worktree_path is normalized with realpathSync after the physical worktree is created and then
 * saved to the ledger, and the return value is the normalized value too. Downstream exact-match
 * comparisons on worktree_path (releaseWorktree, merge.ts's onTaskDone, files.ts's publish_dirty,
 * claim.ts's handoff) all have the structure of either "the caller passes the worktree_path that
 * assignWorktree returned as the key" or "use the worktree_path read from the ledger", so once the saved
 * value is normalized they naturally match normalized-against-normalized and no new normalization call is
 * needed (fixing #36's one-sided fallback mismatch on the write side).
 *
 * @param repoPath  the filesystem root of the target repo (the multi-repo `git -C` target).
 */
export function assignWorktree(
  cdb: CoordDb,
  args: {
    agentId: string;
    repoPath: string;
    taskId?: string | null;
    baseRef?: string;
    /**
     * Issue #8: base_ref 省略時にローカル base をリモート追跡 (origin/<base>) に追従させてから切るか。
     * 既定（undefined）は true 相当。false で従来どおりローカル base から切る。base_ref を明示した
     * 呼び出しはこのオプションに関係なくその ref をそのまま使う。
     */
    baseFromRemote?: boolean;
  },
): AssignResult {
  const db = cdb.db;
  const now = unixNow();

  // Generate the branch name/path deterministically (avoid collisions). Because it includes the repo name
  // + agent + task slug, only calls with the "same agent, same repo, same task" land on the same path;
  // different repo / different task become different paths. The reuse decision keys on this deterministic
  // path (keying on agent_id alone would return the first worktree even when a different repo or task is
  // requested — wrong for multi-repo / multiple assigned tasks).
  const slug = args.taskId ? short(args.taskId) : short(args.agentId);
  const agentSlug = safeSlug(args.agentId);
  const branch = `lockage/${agentSlug}/${slug}`;
  // Dig a .lockage-worktrees/ under the repo's parent directory.
  const repoParent = dirname(args.repoPath);
  const repoName = basename(args.repoPath);
  const path = join(
    repoParent,
    '.lockage-worktrees',
    `${repoName}-${agentSlug}-${slug}`,
  );

  // 1) Reuse an existing active assignment if present (idempotent). Key on the active row of this deterministic path.
  // #41: the ledger now saves normalized paths, but old ledger rows (saved un-normalized before #41) remain
  // as the original join() path. Because the deterministic path for the same agent/repo/task matches as a
  // string, the reuse decision picks up both old and new rows whether on path (un-normalized) or
  // canonicalPath (normalized). However, for a new assignment where the physical worktree does not exist
  // yet, realpathSync fails, so here we query with the un-normalized path and re-check with the normalized
  // path after the physical worktree is created.
  const existing = db
    .prepare(
      `SELECT * FROM worktree_assignments
        WHERE agent_id = ? AND worktree_path = ? AND status = 'active' LIMIT 1`,
    )
    .get(args.agentId, path) as WorktreeAssignment | undefined;
  if (existing) {
    // #41 follow-up (review finding #2): when reusing an old ledger row (saved un-normalized before #41),
    // if the return value stays un-normalized, downstream exact-match comparisons on worktree_path diverge
    // between the "normalized new row" and the "un-normalized old row", leaving the theoretical room for a
    // normalized and an un-normalized row to coexist for the same worktree (a re-INSERT after release
    // slips past UNIQUE as a different string). To close this, lazily normalize the saved value on reuse too.
    //
    // Safety: normalizePath only folds to the real path when the target physically exists, and returns the
    // input as-is when it does not (= an old row for a deleted worktree). Therefore:
    //   - an old row whose physical worktree remains is rewritten to normalized here and converges
    //     (thereafter all comparisons for that worktree match normalized-against-normalized).
    //   - an old row for a deleted worktree returns the original value on realpath failure (keeps backward compatibility).
    // If the UPDATE would violate the partial UNIQUE (idx_wt_path_active) (= the rare case where a
    // normalized active row for the same real path already exists), give up the rewrite and return the
    // original saved value as-is (fail-safe).
    const reusedCanonical = normalizePath(existing.worktree_path);
    if (reusedCanonical !== existing.worktree_path) {
      try {
        db.prepare(
          `UPDATE worktree_assignments SET worktree_path = ? WHERE id = ?`,
        ).run(reusedCanonical, existing.id);
        return {
          worktree_path: reusedCanonical,
          branch: existing.branch,
          reused: true,
        };
      } catch {
        // If it cannot be rewritten due to a UNIQUE collision etc., return the old value as-is (status quo = fail-safe).
      }
    }
    return {
      worktree_path: existing.worktree_path,
      branch: existing.branch,
      reused: true,
    };
  }

  // Issue #8 (レビュー指摘 1 対応): リモート追従の fetch 判定・切り元 ref の決定・base_sha の算出は、
  // 上の再利用（reused=true）早期 return より「後」に置く。これにより冪等な再 assign が再利用でヒット
  // する場合は fetch を一切行わずに return でき、「再利用パスでは fetch しない」という設計意図を満たす。
  // 新規割り当てのときだけ、以下で fetch → 追跡 ref 確認 → 切り元差し替え → base_sha 算出を行う。
  //
  // 切り元 ref の決定方針:
  // - args.baseRef が明示されていれば従来どおりその ref をそのまま使う（呼び出し側の明示指定を尊重。
  //   follow-up タスクが base_ref:<integration_branch> を渡すケースを壊さない）。この場合はリモート
  //   追従を行わない。
  // - args.baseRef 省略時は resolveBaseBranch でローカル base 名（例 dev）を決め、baseFromRemote が
  //   無効でない限りリモート追跡 (origin/<base>) への追従を試みる。
  const baseFromRemote = args.baseFromRemote ?? true;
  const explicitBaseRef = args.baseRef !== undefined;
  // 既定の切り元 ref（ローカル base 名、または明示指定された ref）。
  const localBase = args.baseRef ?? resolveBaseBranch(args.repoPath);
  // 実際に worktree add と base_sha に使う切り元 ref。初期値はローカル（＝従来挙動）。
  let baseRef = localBase;
  let baseSource: 'remote' | 'local' = 'local';
  let behind: number | null = null;

  // base_ref 省略かつ baseFromRemote 有効のときのみ、リモート追跡からの切り出しを試みる。
  if (!explicitBaseRef && baseFromRemote) {
    const remote = resolveRemoteName(args.repoPath);
    if (remote) {
      // 本流を checkout しない安全な fetch。失敗しても best-effort で続行する。
      fetchBase(args.repoPath, remote, localBase);
      const tracking = remoteTrackingRef(args.repoPath, remote, localBase);
      if (tracking) {
        // 追跡 ref が取れたら切り元を origin/<base> に差し替える（base_sha もこれに合う）。
        baseRef = tracking;
        baseSource = 'remote';
        // ローカル base が追跡からどれだけ遅れているかを best-effort で算出し応答に含める。
        behind = countBehind(args.repoPath, localBase, tracking);
      }
      // 追跡 ref が取れない（fetch 失敗・ブランチ未追跡等）場合は切り元をローカルのまま維持する。
    }
    // remote が無い場合（リモート無し環境）は従来どおりローカル base から切る。
  }

  // Best-effort resolve the real existing SHA of the branch point (FEAT-002). Used later to compute the
  // diff from base (git diff --name-only <base_sha>...HEAD); recorded only at new assignment time. When it
  // cannot be resolved (ref missing, empty repo, etc.) it is null → base_sha is saved as NULL and the diff
  // computation falls back to status only when base_sha is absent. On the idempotent-reuse path of an
  // existing active assignment, base_sha is not overwritten (keep the first branch point).
  // Issue #8: baseRef がリモート追跡 (origin/<base>) に差し替わっていれば、base_sha も origin/<base> の
  // SHA になる（古いローカル SHA を記録しない）。worktree add に baseRef が必要なため、物理作成の前に算出する。
  const baseSha = resolveRefSha(args.repoPath, baseRef);

  // 2) Physically create the worktree (if it exists, skip creation and only record).
  //    Pass the original pre-normalization path to git worktree add as-is. normalizePath is used only for
  //    matching/saving; passing a realpath to the git command could cause other problems depending on the
  //    environment, so follow the existing reclaimOrphanWorktrees convention of "pass the original p to remove" (#41).
  if (!existsSync(path)) {
    if (branchExists(args.repoPath, branch)) {
      // Add an existing branch without -b (reconnect / continuation of previous work)
      git(args.repoPath, ['worktree', 'add', path, branch]);
    } else {
      git(args.repoPath, ['worktree', 'add', '-b', branch, path, baseRef]);
    }
  }

  // #41 fix: with the physical worktree present, realpathSync-normalize and make the ledger-saved value and
  // the return value normalized. This makes downstream exact-match comparisons on worktree_path
  // (releaseWorktree, merge.ts's onTaskDone, files.ts's publish_dirty, claim.ts's handoff) naturally match
  // normalized-against-normalized, fixing the "one-sided fallback mismatch" raised in #36 on the write
  // side. realpathSync throws when the target does not exist, so it must be called after git worktree add
  // creates the physical directory.
  const canonicalPath = normalizePath(path);

  // #41: do the reuse decision with the normalized path too. If an old ledger row is saved with an
  // un-normalized path, the SELECT above on path picks it up, while a row newly saved with a normalized
  // path can differ as a string (symlink environments). Conversely, querying with the normalized path picks
  // up rows saved since #41. For the same agent/repo/task's deterministic path, many normal environments
  // have path === canonicalPath, but to safely handle the symlink case we check both.
  if (canonicalPath !== path) {
    const existingCanonical = db
      .prepare(
        `SELECT * FROM worktree_assignments
          WHERE agent_id = ? AND worktree_path = ? AND status = 'active' LIMIT 1`,
      )
      .get(args.agentId, canonicalPath) as WorktreeAssignment | undefined;
    if (existingCanonical) {
      return {
        worktree_path: existingCanonical.worktree_path,
        branch: existingCanonical.branch,
        reused: true,
      };
    }
  }

  // 3) Record. The UNIQUE constraint on worktree_path rejects double assignment at the DB.
  //    BEGIN IMMEDIATE serializes numbering through INSERT (avoids the concurrent-assignment race).
  //    #41: the saved value uses the normalized canonicalPath. The return value is the same.
  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-check in case another path recorded the same worktree just before (query with the normalized path)
    const racer = db
      .prepare(
        `SELECT * FROM worktree_assignments WHERE worktree_path = ? AND status = 'active'`,
      )
      .get(canonicalPath) as WorktreeAssignment | undefined;
    if (racer) {
      db.exec('ROLLBACK');
      return {
        worktree_path: racer.worktree_path,
        branch: racer.branch,
        reused: true,
      };
    }
    db.prepare(
      `INSERT INTO worktree_assignments
         (id, agent_id, worktree_path, repo_path, branch, base_sha, task_id, status, created_at, released_at, host_id, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, 'local')`,
    ).run(ulid(), args.agentId, canonicalPath, args.repoPath, branch, baseSha, args.taskId ?? null, now, cdb.hostId);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already closed */
    }
    throw e;
  }

  // Issue #8: 新規割り当て時のみ、どこから切ったか（base_source）／切り元 ref（base_ref_used）／
  // ローカル base の遅れ件数（behind）を応答に含める。
  return {
    worktree_path: canonicalPath,
    branch,
    reused: false,
    base_source: baseSource,
    base_ref_used: baseRef,
    behind,
  };
}

/**
 * Infer why `git worktree remove` was refused from the worktree's working-tree state.
 *
 * Classify by the leading 2 characters of each `git status --porcelain` line:
 *   - starts with `??` = untracked file.
 *   - otherwise (` M`/`M `/`A `/`D `, etc.) = a tracked uncommitted diff.
 * If there is even one tracked diff, prefer 'dirty' (because the information lost is larger); if only
 * untracked, return 'untracked'. If fetching the status itself fails, treat it as 'dirty' as the cause is
 * unknown (fail-safe: keep it active so it can be reclaimed).
 */
function classifyRemoveFailure(worktreePath: string): 'untracked' | 'dirty' {
  let porcelain: string;
  try {
    porcelain = git(worktreePath, ['status', '--porcelain']);
  } catch {
    // When even status cannot be fetched (abnormal), treat it as dirty (keep active, fail-safe).
    return 'dirty';
  }
  const lines = porcelain.split('\n').filter((l) => l.length > 0);
  let hasTracked = false;
  let hasUntracked = false;
  for (const line of lines) {
    if (line.startsWith('??')) hasUntracked = true;
    else hasTracked = true;
  }
  // Prefer 'dirty' if there is a tracked diff. If none and only untracked, 'untracked'.
  if (hasTracked) return 'dirty';
  if (hasUntracked) return 'untracked';
  // remove was refused even though no diff is found (locked, etc.). Dirty on the fail-safe side.
  return 'dirty';
}

/**
 * §4.5 Worktree release.
 * - keep_branch defaults to true (branch deletion is destructive, so only when explicitly false).
 * - Runs `git worktree remove` (does not use --force because git refuses when there are uncommitted changes).
 * - Only when remove succeeds does it set the ledger to released and clear that worktree's dirty set
 *   (§4.4 — cleared on mainline reflection or discard).
 *
 * The #33 fix: previously, even when remove was refused due to untracked files / uncommitted diffs
 * (removed=false), the ledger was unconditionally flipped to released and dirty_sets was deleted. As a
 * result, the physical worktree and its `git worktree list` registration remained while the active ledger
 * row disappeared, becoming an "orphan" that does not appear in list_worktrees and cannot be re-released.
 * This is changed to "only when removed=true, set the ledger to released and clear dirty_sets. When
 * removed=false, leave the status active, touch neither the ledger nor dirty_sets, and put 'untracked' /
 * 'dirty' in the returned reason so the caller can notice". Branch deletion (keep_branch=false) is also
 * done only when removed=true (deleting the branch while the worktree remains breaks the worktree).
 */
export function releaseWorktree(
  cdb: CoordDb,
  args: {
    agentId: string;
    worktreePath: string;
    repoPath: string;
    keepBranch?: boolean;
  },
): { ok: boolean; removed: boolean; reason?: 'untracked' | 'dirty' } {
  const db = cdb.db;
  const now = unixNow();
  const keepBranch = args.keepBranch ?? true;

  const row = db
    .prepare(
      `SELECT * FROM worktree_assignments
        WHERE worktree_path = ? AND agent_id = ? AND status = 'active'`,
    )
    .get(args.worktreePath, args.agentId) as WorktreeAssignment | undefined;
  if (!row) return { ok: false, removed: false };

  // Detach the physical worktree. If it does not exist, only update the record.
  // When there are uncommitted changes `git worktree remove` refuses (do not use --force = avoid destruction).
  // Swallow the failure and return removed:false + reason (do not let the exception escape).
  let removed = false;
  let reason: 'untracked' | 'dirty' | undefined;
  if (existsSync(args.worktreePath)) {
    try {
      git(args.repoPath, ['worktree', 'remove', args.worktreePath]);
      removed = true;
    } catch {
      // Refused due to untracked files / uncommitted diffs → keep the physical worktree.
      // Attach a reason so the caller can tell the cause (#33).
      removed = false;
      reason = classifyRemoveFailure(args.worktreePath);
    }
  } else {
    // The directory is gone but git may still have debris, so prune.
    // A missing directory means "the working tree is already gone" = treat as released and set removed=true.
    try {
      git(args.repoPath, ['worktree', 'prune']);
    } catch {
      /* best effort */
    }
    removed = true;
  }

  // When removed=false, touch neither the ledger, dirty_sets, nor the branch; leave it active (#33).
  // Releasing again later (e.g. after stashing uncommitted diffs) can reclaim it.
  if (!removed) {
    return { ok: true, removed: false, reason };
  }

  // Delete the branch only when removed=true (deleting the branch while the worktree remains breaks it).
  if (!keepBranch) {
    try {
      git(args.repoPath, ['branch', '-D', row.branch]);
    } catch {
      /* ignore when the branch is missing / checked out, etc. */
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `UPDATE worktree_assignments SET status = 'released', released_at = ?
        WHERE id = ?`,
    ).run(now, row.id);
    // On discard, clear that worktree's dirty-set row (the discipline at the end of §4.5)
    db.prepare(`DELETE FROM dirty_sets WHERE worktree_path = ?`).run(
      args.worktreePath,
    );
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already closed */
    }
    throw e;
  }

  return { ok: true, removed: true };
}

/** The per-worktree result of one release attempt by releaseWorktreesForTicket. */
export interface TicketWorktreeRelease {
  /** The assignee agent_id of the worktree targeted for release. */
  agent_id: string;
  /** The physical worktree path. */
  worktree_path: string;
  /** The corresponding task (the row that qualified with status='done'). */
  task_id: string;
  /** Whether `git worktree remove` succeeded and the ledger became released. */
  removed: boolean;
  /** The reason remove was refused (when removed=false). */
  reason?: 'untracked' | 'dirty';
}

export interface ReleaseTicketWorktreesResult {
  /** The result for each worktree release was attempted on. */
  released: TicketWorktreeRelease[];
  /** The count that became removed=true (the number of worktrees actually cleaned up). */
  removed_count: number;
}

/**
 * §4.5 addendum (#32 option 1): release in bulk the active worktree assignments tied to done tasks under
 * the given ticket.
 *
 * Since #16 changed "tasks under a ticket are 1-B even for a single one", the 1-B path (processMergeQueue→
 * finalizeMergedTask) did not release worktrees and reconcile did not touch worktrees either, so under
 * ticket operation the worktrees and lockage/<agent>/<slug> branches of completed tasks kept piling up.
 * Clean them up by calling this from reconcile's MERGED path (after confirming all tasks are done and the PR is merged).
 *
 * Conditions for release:
 *   - worktree_assignments.status = 'active'
 *   - task_id is not NULL (worktree_assignments.task_id can become NULL via ON DELETE SET NULL, but with
 *     NULL the ticket link cannot be traced, so exclude it).
 *   - that task_id's tasks.ticket_id matches the given ticket, and tasks.status = 'done'.
 *
 * For each target row call releaseWorktree keyed on (agent_id, worktree_path). Because the calling
 * publisher needs to release worktrees of multiple agents under the ticket, use each assignment row's
 * agent_id (not the publisher's own agent_id). Call it with keep_branch=false equivalent to also clean up
 * the task branch (lockage/<agent>/<slug>) merged via the integration branch.
 *
 * By the FEAT-002 fix, releaseWorktree returns removed:false on remove failure (uncommitted diffs present)
 * and leaves the ledger active, so a worktree not released here does not become an orphan; it remains
 * active and can be reclaimed later (safe). Because releaseWorktree is idempotent on the presence of the
 * active row, a double reconcile run does not double-release.
 *
 * @param ticketId   the target ticket (matched against tasks.ticket_id).
 * @param repoPath  the FS root of the repo where the worktrees physically live (the `git -C` target). The
 *                  assignment row's repo_path is preferred; this value is used as a fallback when it is
 *                  absent (old DB row).
 */
export function releaseWorktreesForTicket(
  cdb: CoordDb,
  args: { ticketId: string; repoPath: string; keepBranch?: boolean },
): ReleaseTicketWorktreesResult {
  const db = cdb.db;
  // keep_branch defaults to false (merged via the integration branch, so the task branch may be deleted too = #32 option 1).
  const keepBranch = args.keepBranch ?? false;

  // Enumerate active assignments tied to done tasks under the ticket. Rows with NULL task_id drop out of
  // the JOIN (= excluded). tasks.status='done' avoids wrongly deleting worktrees of incomplete tasks.
  const rows = db
    .prepare(
      `SELECT wa.agent_id AS agent_id,
              wa.worktree_path AS worktree_path,
              wa.repo_path AS repo_path,
              wa.task_id AS task_id
         FROM worktree_assignments wa
         JOIN tasks t ON t.id = wa.task_id
        WHERE wa.status = 'active'
          AND t.ticket_id = ?
          AND t.status = 'done'
        ORDER BY wa.created_at ASC`,
    )
    .all(args.ticketId) as Array<{
      agent_id: string;
      worktree_path: string;
      repo_path: string | null;
      task_id: string;
    }>;

  const released: TicketWorktreeRelease[] = [];
  let removedCount = 0;

  for (const r of rows) {
    // Old DB rows may have NULL repo_path, so use the repoPath argument as a fallback.
    const repoPath = r.repo_path ?? args.repoPath;
    const res = releaseWorktree(cdb, {
      agentId: r.agent_id,
      worktreePath: r.worktree_path,
      repoPath,
      keepBranch,
    });
    if (res.removed) removedCount += 1;
    released.push({
      agent_id: r.agent_id,
      worktree_path: r.worktree_path,
      task_id: r.task_id,
      removed: res.removed,
      ...(res.reason ? { reason: res.reason } : {}),
    });
  }

  return { released, removed_count: removedCount };
}

/**
 * List of active worktrees.
 * @param ticketId when given, narrow to only worktrees assigned to tasks under that ticket
 *   (assignments with NULL task_id are excluded).
 */
export function listWorktrees(
  cdb: CoordDb,
  agentId?: string,
  ticketId?: string,
): WorktreeAssignment[] {
  const clauses: string[] = [`status = 'active'`];
  const params: string[] = [];
  if (agentId) {
    clauses.push('agent_id = ?');
    params.push(agentId);
  }
  if (ticketId) {
    clauses.push('task_id IN (SELECT id FROM tasks WHERE ticket_id = ?)');
    params.push(ticketId);
  }
  return cdb.db
    .prepare(
      `SELECT * FROM worktree_assignments WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`,
    )
    .all(...params) as unknown as WorktreeAssignment[];
}

/**
 * One entry returned by listStaleWorktrees: a worktree assignment still active even though it is tied to a
 * done task. A read-only shape for showing operators the "candidates that failed to release (mainly dirty)".
 */
export interface StaleWorktree extends WorktreeAssignment {
  /** The linked task id (always non-NULL via the JOIN). */
  task_id: string;
  /** The task's status (this function's targets are always 'done'). */
  task_status: string;
  /** The task's parent ticket id (nullable. NULL when it comes from a minor task with no ticket). */
  ticket_id: string | null;
}

/**
 * §4.5 addendum (#35 option 2, visualization): a read-only pure function that enumerates worktrees still
 * active even though they are tied to done tasks.
 *
 * Background: release_worktree / release_ticket_worktrees have `git worktree remove` (without --force)
 * refused when there are uncommitted tracked diffs (dirty), and prioritize data protection by leaving the
 * ledger active (#33's orphan fix). reconcile's MERGED path auto-releases done-task worktrees (#32), but it
 * is made idempotent by the pr_merged post and does not reprocess that ticket thereafter, so a worktree
 * left active due to dirty is never auto-retried again. The purpose of this function is to let operators
 * observe this asymmetry where it does not orphan yet is not auto-reclaimed. A worktree listed here is
 * handled by stashing the diff (commit/stash/discard) and then calling release_worktree (it cannot be
 * reclaimed by reclaim_orphan_worktrees, which only handles orphans, because it is still active in the ledger).
 *
 * Like releaseWorktreesForTicket, the query JOINs worktree_assignments to tasks via task_id and targets
 * only rows with status='active' and the corresponding task status='done'. Assignments with NULL task_id
 * drop out of the JOIN (= excluded). Whereas list_worktrees returns all active, this function narrows to
 * done tasks and shows only the "unreleased candidates". The server itself releases nothing (observation only).
 *
 * @param args.ticketId  when given, narrow with t.ticket_id = ? (all tickets when omitted).
 * @param args.agentId  when given, narrow with wa.agent_id = ? (all agents when omitted).
 */
export function listStaleWorktrees(
  cdb: CoordDb,
  args?: { ticketId?: string; agentId?: string },
): StaleWorktree[] {
  const conditions: string[] = [
    "wa.status = 'active'",
    "t.status = 'done'",
  ];
  const params: string[] = [];
  if (args?.ticketId !== undefined) {
    conditions.push('t.ticket_id = ?');
    params.push(args.ticketId);
  }
  if (args?.agentId !== undefined) {
    conditions.push('wa.agent_id = ?');
    params.push(args.agentId);
  }

  return cdb.db
    .prepare(
      `SELECT wa.*,
              t.status AS task_status,
              t.ticket_id AS ticket_id
         FROM worktree_assignments wa
         JOIN tasks t ON t.id = wa.task_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY wa.created_at ASC`,
    )
    .all(...params) as unknown as StaleWorktree[];
}

/** One orphan worktree (physically present but not active in the ledger). */
export interface OrphanWorktree {
  /** The physical worktree path (from `git worktree list`). */
  worktree_path: string;
  /** The ledger status: 'none' if there is no active row, 'released' if there is a released row. */
  ledger_status: 'none' | 'released';
  /** The result of the reclaim attempt when dry_run=false (undefined for enumeration only). */
  removed?: boolean;
  /** The reason the reclaim failed (when removed=false). */
  reason?: 'untracked' | 'dirty';
}

export interface ReclaimOrphanResult {
  /** The list of detected orphans (returned even on dry_run). */
  orphans: OrphanWorktree[];
  /** The number actually reclaimed (removed) when dry_run=false. */
  removed_count: number;
}

/**
 * §4.5 addendum (together with #33): enumerate/reclaim already-orphaned worktrees.
 *
 * A means to reclaim in operation the orphans born before the #33 fix (the physical worktree and its
 * `git worktree list` registration remain while there is no active ledger row). Read the given repo's
 * `git worktree list --porcelain`, target only the paths under lockage's dug `.lockage-worktrees/`, and
 * match them against the ledger (worktree_assignments).
 *
 * "Physically present but not active in the ledger" = treat as an orphan:
 *   - if there is an active row for that worktree_path in the ledger, it is normal (excluded).
 *   - if there is no active row but a released row, ledger_status='released' (a pre-#33 orphan).
 *   - if there is no row at all, ledger_status='none' (the ledger split / was manually deleted, etc.).
 *
 * dry_run=true (default) only enumerates. When false, attempt `git worktree remove` (without --force) on
 * each orphan. Those with untracked files or tracked uncommitted diffs remaining return removed=false +
 * reason and are not destroyed (do not use --force).
 *
 * @param repoPath  the filesystem root of the target repo (the `git -C` target = the main repo).
 * @param dryRun    defaults to true (enumeration only). false to attempt reclaim.
 */
export function reclaimOrphanWorktrees(
  cdb: CoordDb,
  args: { repoPath: string; dryRun?: boolean },
): ReclaimOrphanResult {
  const db = cdb.db;
  const dryRun = args.dryRun ?? true;

  // Collect physical paths from the `worktree <path>` lines of `git worktree list --porcelain`.
  // On failure (not a repo, etc.) return empty as "no orphans" (best effort).
  let porcelain: string;
  try {
    porcelain = git(args.repoPath, ['worktree', 'list', '--porcelain']);
  } catch {
    return { orphans: [], removed_count: 0 };
  }

  const physicalPaths: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      physicalPaths.push(line.slice('worktree '.length));
    }
  }

  // #36: the ledger's worktree_path is the path assignWorktree built with join() (symlinks unresolved),
  // so matching it against the git-derived path (sometimes realpath-resolved) with an exact string compare
  // diverges in some environments. So pull all active/released rows from the ledger, pre-build a set of
  // realpath-normalized worktree_path values, and match by whether the normalized value of the git-derived
  // path is in that set (drop the SQL `= ?` direct comparison). The path count is at most the worktree
  // count, assumed to be not that many. Also keep normalized value → original DB-saved value.
  const activeNorm = new Set<string>();
  const releasedNorm = new Set<string>();
  for (const row of db
    .prepare(
      `SELECT worktree_path, status FROM worktree_assignments WHERE status IN ('active', 'released')`,
    )
    .all() as Array<{ worktree_path: string; status: 'active' | 'released' }>) {
    const norm = normalizePath(row.worktree_path);
    if (row.status === 'active') activeNorm.add(norm);
    else releasedNorm.add(norm);
  }

  // #36: exclude the main repo itself with normalized-against-normalized values too (repoPath and git get the same normalization).
  const repoNorm = normalizePath(args.repoPath);

  const orphans: OrphanWorktree[] = [];
  let removedCount = 0;

  for (const p of physicalPaths) {
    // #36: use the normalized value of the git-derived path for matching (pass the original p to remove as-is).
    const pNorm = normalizePath(p);

    // Do not target the main repo itself or worktrees unmanaged by lockage (only under .lockage-worktrees/).
    if (p === args.repoPath || pNorm === repoNorm) continue;
    // The .lockage-worktrees inclusion check targets it if either the original path or the normalized path
    // contains it (do not miss cases where .lockage-worktrees does not appear in the symlink name but only
    // in the real path).
    if (!p.includes('.lockage-worktrees') && !pNorm.includes('.lockage-worktrees')) continue;

    // If there is an active row in the ledger, it is normal (not an orphan). Match normalized-against-normalized (#36).
    if (activeNorm.has(pNorm)) continue;

    // A physical worktree with no active = an orphan. Split ledger_status by the presence of a released row (decided by normalized value).
    const orphan: OrphanWorktree = {
      worktree_path: p,
      ledger_status: releasedNorm.has(pNorm) ? 'released' : 'none',
    };

    if (!dryRun) {
      // Do not use --force. If untracked files or tracked uncommitted diffs remain, git refuses, so leave
      // it with a reason (do not destroy).
      try {
        git(args.repoPath, ['worktree', 'remove', p]);
        orphan.removed = true;
        removedCount += 1;
      } catch {
        orphan.removed = false;
        orphan.reason = classifyRemoveFailure(p);
      }
    }

    orphans.push(orphan);
  }

  return { orphans, removed_count: removedCount };
}
