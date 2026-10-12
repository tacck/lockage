import { ulid } from 'ulid';
import { unixNow, type CoordDb } from '../db/index.js';
import { sweepExpired } from './claim.js';
import { fileIntersect, globsMatchAny, globsOverlap, normalizePath } from './globs.js';
import { wake } from './board.js';
import { committedChangedFiles, workingTreeChangedFiles } from './git.js';

/** Default TTL of an advisory lease (8h; matches the schema default). */
export const DEFAULT_CLAIM_TTL_SEC = 8 * 60 * 60;

/**
 * The minimum interval (seconds) for throttling git reads against the same worktree in the dirty
 * auto-compute (reconcileDirtyFromWorktrees). The default matches Issue #52 proposal 2's "e.g. 30 seconds".
 *
 * Since dirty recompute is called from multiple paths such as heartbeat / claim_files / task_done /
 * publish_dirty, hitting `git status` / `git diff` every time is wasteful under high-frequency tool
 * calls. If the latest dirty_sets.updated_at is newer than now - this many seconds, skip the git read
 * and use the existing dirty as-is (do not break the already-published content).
 */
export const DIRTY_RECONCILE_MIN_INTERVAL_SEC = 30;

export interface ClaimRow {
  id: string;
  holder: string;
  globs: string; // JSON array string
  task_id: string | null;
  lease_ttl_sec: number;
  heartbeat_at: number;
  expires_at: number;
  released_at: number | null;
  created_at: number;
  host_id: string;
  origin: string;
}

export interface GlobOverlap {
  agent_id: string;
  globs: string[];
}
export interface FileOverlap {
  agent_id: string;
  files: string[];
}

export interface ClaimFilesResult {
  claim_id: string;
  /** Overlap with another agent's active claim (warning only; does not block). */
  overlaps: GlobOverlap[];
}

export interface DirtyOverlap {
  /** Overlap between dirty sets (per file). */
  dirty: FileOverlap[];
  /** Overlap with an active claim (glob). */
  claims: GlobOverlap[];
}

export interface PublishDirtyResult {
  ok: true;
  overlaps: DirtyOverlap;
  /** The peers woken by an A2A wake (kind='overlap') because of an overlap. Their wait_for_unblock returns. */
  wake_targets: string[];
  /**
   * Of the dirty files, those that match none of your (agentId's) active claim globs (Issue #52 proposal 3).
   * Lets the caller (agent) notice it is "touching outside the claim scope".
   * If you have no claim at all, all dirty files become unclaimed.
   */
  unclaimed: string[];
}

/**
 * The return of reconcileDirtyFromWorktrees (aggregated form). Each tool handler in index.ts puts it
 * on the response. Keeps the same shape as publishDirty's result while also returning which worktrees
 * were recomputed and the dirty_files after union.
 */
export interface ReconcileDirtyResult {
  ok: true;
  overlaps: DirtyOverlap;
  /** The aggregation of peers woken by an A2A wake (kind='overlap') because of an overlap. */
  wake_targets: string[];
  /** Of the dirty files, those outside your active claim globs (union of all target worktrees). */
  unclaimed: string[];
  /** The dirty files after recompute (union of all target worktrees; normalized and deduplicated). */
  dirty_files: string[];
  /** The worktree paths actually git-read (does not include ones throttled by the minimum interval). */
  reconciled_worktrees: string[];
}

function parseGlobs(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** List active (unreleased and unexpired) claims. */
function activeClaims(cdb: CoordDb, now: number, excludeHolder?: string): ClaimRow[] {
  const rows = cdb.db
    .prepare(
      `SELECT * FROM claims
        WHERE released_at IS NULL AND expires_at >= ?
        ORDER BY created_at ASC`,
    )
    .all(now) as unknown as ClaimRow[];
  return excludeHolder ? rows.filter((r) => r.holder !== excludeHolder) : rows;
}

/**
 * §4.3 claim_files — warn, never block (advisory).
 *
 * Real file conflicts are prevented by worktree physical isolation (§4.5), so this sticks to the
 * logical visualization of "who is responsible for where". Overlaps are detected and returned to
 * `overlaps` as a warning only, not an error. Since they auto-expire by lease (TTL+heartbeat), there
 * is no permanent lock or deadlock (hard locks not adopted, requirement §9.2).
 */
export function claimFiles(
  cdb: CoordDb,
  args: {
    agentId: string;
    globs: string[];
    ttlSec?: number;
    taskId?: string | null;
  },
): ClaimFilesResult {
  const now = unixNow();
  sweepExpired(cdb, now);

  const ttl = args.ttlSec ?? DEFAULT_CLAIM_TTL_SEC;

  // Detect overlaps but do not block (advisory)
  const overlaps: GlobOverlap[] = [];
  for (const c of activeClaims(cdb, now, args.agentId)) {
    const cg = parseGlobs(c.globs);
    if (globsOverlap(cg, args.globs)) {
      overlaps.push({ agent_id: c.holder, globs: cg });
    }
  }

  const claimId = ulid();
  cdb.db
    .prepare(
      `INSERT INTO claims
         (id, holder, globs, task_id, lease_ttl_sec, heartbeat_at, expires_at, created_at, host_id, origin)
       VALUES (?, ?, json(?), ?, ?, ?, ?, ?, ?, 'local')`,
    )
    .run(
      claimId,
      args.agentId,
      JSON.stringify(args.globs),
      args.taskId ?? null,
      ttl,
      now,
      now + ttl,
      now,
      cdb.hostId,
    );

  return { claim_id: claimId, overlaps };
}

/**
 * Explicit release of a claim (§2.3 release_claim). Only the holder can logically release (no physical DELETE = for provenance tracking).
 */
export function releaseClaim(
  cdb: CoordDb,
  claimId: string,
  agentId: string,
): { ok: boolean } {
  const now = unixNow();
  const info = cdb.db
    .prepare(
      `UPDATE claims SET released_at = ?
        WHERE id = ? AND holder = ? AND released_at IS NULL`,
    )
    .run(now, claimId, agentId);
  return { ok: info.changes > 0 };
}

/**
 * Issue #45 item 1/2: in step with a task's end, logically release the active claims that have that
 * task_id together (no physical DELETE = for provenance tracking).
 *
 * Regardless of holder: even after a handoff_task move to another worker, release them without
 * leftovers as long as task_id matches (the aim is to close the structural miss of "no trigger to
 * release", not "a specific agent's procedural omission"). Claims with task_id NULL (declarations not
 * tied to a task) are not targeted (those are handled by release_claim and TTL).
 *
 * Assumed to be called from both task_done (via merge.ts's finalizeMergedTask) and release_task
 * (claim.ts). It only sets released_at, so it does not affect already-released claims (WHERE released_at IS NULL).
 *
 * @returns released_count = the number of claims released.
 */
export function releaseClaimsForTask(
  cdb: CoordDb,
  taskId: string,
  now: number = unixNow(),
): { released_count: number } {
  const info = cdb.db
    .prepare(
      `UPDATE claims SET released_at = ?
        WHERE task_id = ? AND released_at IS NULL`,
    )
    .run(now, taskId);
  return { released_count: Number(info.changes) };
}

/**
 * Issue #45 item 3 (the claim version of the #32 worktree pattern): logically release the active
 * claims tied to done / abandoned tasks under the specified ticket, together.
 *
 * A reclamation path called from reconcile (lockage-publish's MERGED path). It follows up to tidy
 * leftovers created before item 1 (task_done) and claims of tasks that ended without going through
 * task_done. It targets only claims tied to tasks whose tasks.status is done / abandoned, and
 * preserves claims of still-ongoing (in_progress / blocked) or not-started (open) tasks.
 *
 * Logical release that only sets released_at (no physical DELETE). It does not affect
 * already-released/expired claims (WHERE released_at IS NULL). It is idempotent on the presence of
 * active rows, so even if reconcile runs twice it does not double-release.
 *
 * @param ticketId the target ticket (matched against tasks.ticket_id).
 * @returns released_count = the number of claims released.
 */
export function releaseClaimsForFinishedTicketTasks(
  cdb: CoordDb,
  args: { ticketId: string; now?: number },
): { released_count: number } {
  const now = args.now ?? unixNow();
  const info = cdb.db
    .prepare(
      `UPDATE claims SET released_at = ?
        WHERE released_at IS NULL
          AND task_id IN (
            SELECT id FROM tasks
             WHERE ticket_id = ? AND status IN ('done', 'abandoned')
          )`,
    )
    .run(now, args.ticketId);
  return { released_count: Number(info.changes) };
}

/** The holder's active claim list. */
export function listClaims(cdb: CoordDb, holder?: string): ClaimRow[] {
  const now = unixNow();
  // When holder is specified, narrow in the SQL WHERE (leverage idx_claims_holder; avoid an in-memory filter).
  if (holder) {
    return cdb.db
      .prepare(
        `SELECT * FROM claims
          WHERE released_at IS NULL AND expires_at >= ? AND holder = ?
          ORDER BY created_at ASC`,
      )
      .all(now, holder) as unknown as ClaimRow[];
  }
  return activeClaims(cdb, now);
}

export interface DirtyRow {
  id: string;
  agent_id: string;
  worktree_path: string;
  files: string; // JSON array string
  updated_at: number;
  host_id: string;
  origin: string;
}

/**
 * §4.4 publish_dirty — publish the dirty set and early overlap warning (requirement FR-1.5).
 *
 * Against claim (intent), the dirty set is "the fact that it was already changed". Publishing
 * pre-commit changes as they go moves conflict discovery forward from "the final merge" to "before
 * you start writing". Overlaps are returned as a warning only and do not stop the write. The dirty
 * set is not cleared by commit alone; it is cleared at the merge gate's merged or at worktree
 * disposal (§4.5). The granularity is per file (D-2).
 */
/**
 * The core of dirty-set overlap detection + A2A wake (§4.4, FR-1.5.1).
 *
 * An internal helper carved out of publishDirty. It is centralized here so that explicit publish
 * (publishDirty) and auto-compute (reconcileDirtyFromWorktrees) share the logic of "detecting files
 * overlapping others' dirty / claims" and "waking the overlapping peer with an overlap wake". The
 * behavior is identical to the former in-publishDirty implementation (= the existing files.test.ts passes).
 *
 * - The intersection (fileIntersect) of another agent's dirty set and files is a dirty overlap.
 * - If a non-self active claim's glob matches any of files (globsMatchAny), it is a claim overlap.
 * - Wake the overlapping peer with an overlap wake (kind='overlap') (move conflict discovery forward to before writing).
 *
 * @param files normalization not required beforehand (fileIntersect/globsMatchAny normalizePath internally).
 */
function applyDirtyOverlaps(
  cdb: CoordDb,
  agentId: string,
  files: string[],
  now: number,
): { overlaps: DirtyOverlap; wakeTargets: string[] } {
  // Detect files overlapping another agent's dirty set / claim (do not block)
  const dirtyOverlaps: FileOverlap[] = [];
  const otherDirty = cdb.db
    .prepare(`SELECT * FROM dirty_sets WHERE agent_id != ?`)
    .all(agentId) as unknown as DirtyRow[];
  for (const d of otherDirty) {
    const inter = fileIntersect(parseGlobs(d.files), files);
    if (inter.length > 0) dirtyOverlaps.push({ agent_id: d.agent_id, files: inter });
  }

  const claimOverlaps: GlobOverlap[] = [];
  for (const c of activeClaims(cdb, now, agentId)) {
    const cg = parseGlobs(c.globs);
    if (globsMatchAny(cg, files)) {
      claimOverlaps.push({ agent_id: c.holder, globs: cg });
    }
  }

  // If there is an overlap, wake the relevant agent with an A2A wake (FR-1.5.1).
  // Push the overlap wake onto the wakes queue → the peer's wait_for_unblock returns with woke_by:"overlap".
  const wakeTargets = [
    ...new Set([
      ...dirtyOverlaps.map((o) => o.agent_id),
      ...claimOverlaps.map((o) => o.agent_id),
    ]),
  ];
  for (const target of wakeTargets) {
    const wfiles = [
      ...new Set([
        ...dirtyOverlaps.filter((o) => o.agent_id === target).flatMap((o) => o.files),
        ...claimOverlaps.filter((o) => o.agent_id === target).flatMap((o) => o.globs),
      ]),
    ];
    wake(cdb, target, 'overlap', { by: agentId, files: wfiles });
  }

  return { overlaps: { dirty: dirtyOverlaps, claims: claimOverlaps }, wakeTargets };
}

/**
 * A pure helper that computes, of the dirty files, those matching none of your (agentId's) active
 * claim globs (Issue #52 proposal 3's unclaimed computation).
 *
 * Collect all globs of your (holder=agentId) active claims (released_at IS NULL and expires_at >=
 * now), and use globs.ts's globsMatchAny to return "files matching none of your globs" as unclaimed.
 * If you have no claim at all, all dirty files become unclaimed (= touching with zero scope declaration).
 *
 * The return is a file set normalized and deduplicated by normalizePath. A pure function (DB read only, no side effects).
 */
export function computeUnclaimed(
  cdb: CoordDb,
  agentId: string,
  files: string[],
  now: number,
): string[] {
  // Collect all globs of your active claims.
  const myGlobs: string[] = [];
  for (const c of listClaims(cdb, agentId)) {
    myGlobs.push(...parseGlobs(c.globs));
  }
  void now; // listClaims(holder) narrows active by unixNow() internally, so now is unused (received for future expansion).

  const unclaimed: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const nf = normalizePath(f);
    if (seen.has(nf)) continue;
    seen.add(nf);
    // Unclaimed if it matches none of your globs. If there is no claim, myGlobs is empty = all unclaimed.
    if (!globsMatchAny(myGlobs, [nf])) unclaimed.push(nf);
  }
  return unclaimed;
}

/**
 * The merged result for the publish_dirty handler (overlaps / wake_targets / unclaimed only).
 * The form that merges publishDirty's (explicit publish) result and reconcileDirtyFromWorktrees'
 * (worktree auto-compute) result. Does not include reconcile-specific aggregates such as dirty_files
 * (narrowed to the 3 items the handler needs to put on the response).
 */
export interface MergedDirtyResult {
  overlaps: DirtyOverlap;
  wake_targets: string[];
  unclaimed: string[];
}

/**
 * A pure helper that merges and deduplicates per-agent_id overlap (FileOverlap / GlobOverlap) arrays.
 *
 * applyDirtyOverlaps pushes only one row per agent_id within "a single detection", but adding results
 * detected separately on the publishDirty side and the reconcileDirtyFromWorktrees side can make the
 * same agent_id's row appear in both. So, keyed by agent_id, unify files / globs (both string[], so
 * handled by the same logic) with a Set into a single deduplicated row. Preserves input order and
 * returns in first-seen agent_id order.
 *
 * A pure function (DB-independent, no side effects). Because FileOverlap (files) and GlobOverlap
 * (globs) have different key names, the extract/build are received from the caller as functions.
 */
function mergeAgentOverlaps<T extends { agent_id: string }>(
  a: T[],
  b: T[],
  getItems: (o: T) => string[],
  build: (agentId: string, items: string[]) => T,
): T[] {
  const order: string[] = [];
  const byAgent = new Map<string, Set<string>>();
  for (const o of [...a, ...b]) {
    let set = byAgent.get(o.agent_id);
    if (!set) {
      set = new Set<string>();
      byAgent.set(o.agent_id, set);
      order.push(o.agent_id);
    }
    for (const item of getItems(o)) set.add(item);
  }
  return order.map((agentId) => build(agentId, [...byAgent.get(agentId)!]));
}

/**
 * A pure helper that "merges" rather than "swallows" the explicit-publish (publishDirty) result res
 * and the worktree auto-compute (reconcileDirtyFromWorktrees) result rc (Issue #52's regression fix).
 *
 * The publish_dirty handler used to overwrite res wholesale with rc, so when the worktree_path passed
 * to publish_dirty was not in worktree_assignments' active rows (e.g. no assign_worktree), rc was
 * empty (overlaps/wake/unclaimed all empty) and the overlap/wake/unclaimed res actually detected
 * disappeared from the response. By unioning the two, res's detection always remains even if
 * reconcile cannot find the worktree.
 *
 * - overlaps.dirty / overlaps.claims: unify both res and rc per agent_id and deduplicate files/globs
 *   (no double counting even in the normal case where both return the same overlap).
 * - wake_targets: the union of res and rc (deduplicated).
 * - unclaimed: the union of res and rc (deduplicated).
 *
 * Receives the shape applyDirtyOverlaps / computeUnclaimed return (DirtyOverlap, string[]) and
 * returns the same shape. A pure function (DB-independent, no side effects).
 */
export function mergeDirtyResults(
  res: { overlaps: DirtyOverlap; wake_targets: string[]; unclaimed: string[] },
  rc: { overlaps: DirtyOverlap; wake_targets: string[]; unclaimed: string[] },
): MergedDirtyResult {
  const dirty = mergeAgentOverlaps<FileOverlap>(
    res.overlaps.dirty,
    rc.overlaps.dirty,
    (o) => o.files,
    (agent_id, files) => ({ agent_id, files }),
  );
  const claims = mergeAgentOverlaps<GlobOverlap>(
    res.overlaps.claims,
    rc.overlaps.claims,
    (o) => o.globs,
    (agent_id, globs) => ({ agent_id, globs }),
  );
  return {
    overlaps: { dirty, claims },
    wake_targets: [...new Set([...res.wake_targets, ...rc.wake_targets])],
    unclaimed: [...new Set([...res.unclaimed, ...rc.unclaimed])],
  };
}

export function publishDirty(
  cdb: CoordDb,
  args: {
    agentId: string;
    worktreePath: string;
    files: string[];
  },
): PublishDirtyResult {
  const now = unixNow();
  sweepExpired(cdb, now);

  // 1) Overwrite-save the dirty set (1 worktree = 1 row, UPSERT)
  cdb.db
    .prepare(
      `INSERT INTO dirty_sets
         (id, agent_id, worktree_path, files, updated_at, host_id, origin)
       VALUES (?, ?, ?, json(?), ?, ?, 'local')
       ON CONFLICT(agent_id, worktree_path)
         DO UPDATE SET files = json(excluded.files), updated_at = excluded.updated_at`,
    )
    .run(
      ulid(),
      args.agentId,
      args.worktreePath,
      JSON.stringify(args.files),
      now,
      cdb.hostId,
    );

  // 2) overlap detection + wake (via applyDirtyOverlaps, shared with the auto-compute side).
  const { overlaps, wakeTargets } = applyDirtyOverlaps(cdb, args.agentId, args.files, now);

  // 3) Of the explicitly published files, those outside your claim (Issue #52 proposal 3).
  const unclaimed = computeUnclaimed(cdb, args.agentId, args.files, now);

  return {
    ok: true,
    overlaps,
    wake_targets: wakeTargets,
    unclaimed,
  };
}

/**
 * A public function that auto-recomputes the dirty set from the assigned worktree's git state (Issue #52 proposals 2 & 3).
 *
 * Even without the agent explicitly calling publish_dirty, lockage reflects into the dirty set the
 * union of the worktree's `git status --porcelain` (working-tree changes) and
 * `git diff --name-only <base_sha>...HEAD` (committed diff from base_sha). It also unions with the
 * existing explicit-publish content (the announcement) so nothing breaks. Called from index.ts's
 * heartbeat / claim_files / publish_dirty / task_done paths.
 *
 * Processing:
 *   (1) Fetch the target worktrees from worktree_assignments (agent_id match, status='active').
 *       When worktreePath is specified, that one; otherwise all of the agent's active worktrees.
 *   (2) Throttle per worktree by the minimum interval (default DIRTY_RECONCILE_MIN_INTERVAL_SEC): if
 *       the latest dirty_sets.updated_at is newer than now - minIntervalSec, skip the git read and use
 *       that worktree's existing dirty as-is (do not break the already-published content).
 *   (3) For a non-throttled worktree, take workingTreeChangedFiles ∪ committedChangedFiles and union
 *       with the existing dirty_sets.files (the explicit-publish announcement) (normalizePath
 *       normalization, deduplication) and UPSERT dirty_sets (the same UPSERT statement as publishDirty).
 *   (4) Call applyDirtyOverlaps on the union files for overlap detection + wake.
 *   (5) Compute unclaimed with computeUnclaimed.
 *
 * The return is the aggregated form over all target worktrees (overlaps / wake_targets / unclaimed / dirty_files).
 */
export function reconcileDirtyFromWorktrees(
  cdb: CoordDb,
  args: {
    agentId: string;
    worktreePath?: string;
    now?: number;
    minIntervalSec?: number;
  },
): ReconcileDirtyResult {
  const now = args.now ?? unixNow();
  const minInterval = args.minIntervalSec ?? DIRTY_RECONCILE_MIN_INTERVAL_SEC;
  sweepExpired(cdb, now);

  // (1) Fetch the target worktrees (active only). When worktree_path is specified, narrow to that one.
  const rows = (
    args.worktreePath
      ? cdb.db
        .prepare(
          `SELECT worktree_path, repo_path, base_sha FROM worktree_assignments
              WHERE agent_id = ? AND status = 'active' AND worktree_path = ?`,
        )
        .all(args.agentId, args.worktreePath)
      : cdb.db
        .prepare(
          `SELECT worktree_path, repo_path, base_sha FROM worktree_assignments
              WHERE agent_id = ? AND status = 'active'`,
        )
        .all(args.agentId)
  ) as Array<{ worktree_path: string; repo_path: string | null; base_sha: string | null }>;

  // The union of dirty files across all worktrees (for the aggregated return).
  const allDirty = new Set<string>();
  const reconciledWorktrees: string[] = [];

  for (const r of rows) {
    // Read that worktree's existing dirty row (the explicit-publish announcement).
    const existing = cdb.db
      .prepare(
        `SELECT files, updated_at FROM dirty_sets WHERE agent_id = ? AND worktree_path = ?`,
      )
      .get(args.agentId, r.worktree_path) as
      | { files: string; updated_at: number }
      | undefined;
    const existingFiles = existing ? parseGlobs(existing.files) : [];

    // (2) Throttle by the minimum interval: if the latest update is fresh enough, skip the git read and use the existing as-is.
    const fresh = existing != null && existing.updated_at > now - minInterval;
    if (fresh) {
      for (const f of existingFiles) allDirty.add(normalizePath(f));
      continue;
    }

    // (3) Collect files from the git state and union with the existing (announcement).
    //     git status / diff run against worktree_path (following classifyRemoveFailure).
    const working = workingTreeChangedFiles(r.worktree_path);
    const committed = committedChangedFiles(r.worktree_path, r.base_sha);
    const union = new Set<string>();
    for (const f of [...existingFiles, ...working, ...committed]) {
      union.add(normalizePath(f));
    }
    const unionFiles = [...union];
    for (const f of unionFiles) allDirty.add(f);
    reconciledWorktrees.push(r.worktree_path);

    // UPSERT the union into dirty_sets (the same UPSERT statement as publishDirty).
    cdb.db
      .prepare(
        `INSERT INTO dirty_sets
           (id, agent_id, worktree_path, files, updated_at, host_id, origin)
         VALUES (?, ?, ?, json(?), ?, ?, 'local')
         ON CONFLICT(agent_id, worktree_path)
           DO UPDATE SET files = json(excluded.files), updated_at = excluded.updated_at`,
      )
      .run(
        ulid(),
        args.agentId,
        r.worktree_path,
        JSON.stringify(unionFiles),
        now,
        cdb.hostId,
      );
  }

  const dirtyFiles = [...allDirty];

  // (4) overlap detection + wake on the union files.
  const { overlaps, wakeTargets } = applyDirtyOverlaps(cdb, args.agentId, dirtyFiles, now);

  // (5) Compute unclaimed.
  const unclaimed = computeUnclaimed(cdb, args.agentId, dirtyFiles, now);

  return {
    ok: true,
    overlaps,
    wake_targets: wakeTargets,
    unclaimed,
    dirty_files: dirtyFiles,
    reconciled_worktrees: reconciledWorktrees,
  };
}

/** The dirty set list (filter by agent). */
export function listDirty(cdb: CoordDb, agentId?: string): DirtyRow[] {
  if (agentId) {
    return cdb.db
      .prepare(`SELECT * FROM dirty_sets WHERE agent_id = ? ORDER BY updated_at DESC`)
      .all(agentId) as unknown as DirtyRow[];
  }
  return cdb.db
    .prepare(`SELECT * FROM dirty_sets ORDER BY updated_at DESC`)
    .all() as unknown as DirtyRow[];
}
