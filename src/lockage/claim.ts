import type { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';
import { unixNow, type CoordDb } from '../db/index.js';

// Task lease (the grace period before heartbeat lapse returns it to open). Distinct from claims' lease_ttl.
export const TASK_LEASE_SEC = 15 * 60; // 15 minutes

export interface Task {
  id: string;
  ticket_id: string | null;
  repo: string;
  title: string;
  description: string | null;
  status: 'open' | 'in_progress' | 'done' | 'abandoned' | 'blocked';
  assignee: string | null;
  priority: number;
  version: number;
  heartbeat_at: number | null;
  created_at: number;
  updated_at: number;
  host_id: string;
  origin: string;
}

export type ClaimResult =
  | { ok: true; task: Task }
  | {
    ok: false;
    reason: 'conflict' | 'not_found';
    current?: Pick<Task, 'assignee' | 'status' | 'version'>;
  };

/**
 * Create a task. ticket_id is nullable (model 3: minor tasks without a ticket are allowed).
 * Passing depends_on adds edges to the dependency DAG (blocks). It cycle-checks before adding edges
 * and rejects depends_on that would form a cycle with { ok:false, reason:'cycle' } (§4.8 DAG invariant).
 */
export interface CycleError {
  ok: false;
  reason: 'cycle';
  detail: string;
}

export function createTask(
  cdb: CoordDb,
  args: {
    repo: string;
    title: string;
    description?: string;
    ticketId?: string | null;
    priority?: number;
  },
): Task;
export function createTask(
  cdb: CoordDb,
  args: {
    repo: string;
    title: string;
    description?: string;
    ticketId?: string | null;
    priority?: number;
    dependsOn: string[];
  },
): Task | CycleError;
export function createTask(
  cdb: CoordDb,
  args: {
    repo: string;
    title: string;
    description?: string;
    ticketId?: string | null;
    priority?: number;
    dependsOn?: string[];
  },
): Task | CycleError {
  const dependsOn = args.dependsOn ?? [];

  // If there is an existing cycle among depends_on, reject before adding edges.
  // Invariant: the new task T has no edges yet, so "a cycle forms after adding T" happens only if
  // there is an existing path D_i → … → D_j among depends_on and D_j also blocks T (= D_j is also in
  // depends_on). Therefore it suffices to check, for every ordered pair (d, other) of depends_on,
  // only "whether there is an existing path from other to d" (no need to traverse T itself).
  for (const d of dependsOn) {
    for (const other of dependsOn) {
      if (d === other) continue;
      // Reachable from d to other and other also tries to block d → the seed of a cycle
      if (isReachable(cdb.db, other, d)) {
        return {
          ok: false,
          reason: 'cycle',
          detail: `depends_on would create a dependency cycle (${other} ⇄ ${d})`,
        };
      }
    }
  }

  const now = unixNow();
  const id = ulid();
  const ticketId = args.ticketId ?? null;

  // Fix option A (F2 re-arm): when adding a task under a ticket, if the parent ticket already emitted
  // ready (ticket_ready_at IS NOT NULL), reset ticket_ready_at to NULL to make ticket_ready re-emit.
  // A task created by createTask is always open (unfinished), so the trigger condition is only "the
  // ticket already emitted ready". The task INSERT and the ticket re-arm are atomized in the same
  // BEGIN IMMEDIATE transaction (so consistency does not break if only one succeeds). The reverse CAS
  // symmetric to tickets.ts's rearmTicketReady is written directly here to unify the transaction
  // boundary (importing claim.ts→tickets.ts would not be a cycle, but a separate transaction would break atomicity).
  const db = cdb.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO tasks (id, ticket_id, repo, title, description, status, assignee,
                          priority, version, heartbeat_at, created_at, updated_at, host_id, origin)
       VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, 0, NULL, ?, ?, ?, 'local')`,
    ).run(
      id,
      ticketId,
      args.repo,
      args.title,
      args.description ?? null,
      args.priority ?? 0,
      now,
      now,
      cdb.hostId,
    );
    if (ticketId !== null) {
      db.prepare(
        `UPDATE tickets SET ticket_ready_at = NULL, updated_at = ?
          WHERE id = ? AND ticket_ready_at IS NOT NULL`,
      ).run(now, ticketId);
    }
    // For each depends_on D, add D→T (D blocks T). T is new, so no cycle occurs.
    for (const d of dependsOn) {
      db.prepare(
        `INSERT OR IGNORE INTO task_edges (from_task, to_task, kind, host_id, origin)
         VALUES (?, ?, 'blocks', ?, 'local')`,
      ).run(d, id, cdb.hostId);
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
  return getTask(cdb.db, id)!;
}

/** Traverse task_edges (blocks) in the from→to direction and DFS-decide whether to is reachable from from. */
function isReachable(db: DatabaseSync, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const next = db
      .prepare(`SELECT to_task FROM task_edges WHERE from_task = ? AND kind = 'blocks'`)
      .all(cur) as unknown as Array<{ to_task: string }>;
    for (const n of next) stack.push(n.to_task);
  }
  return false;
}

/** Add one blocks edge (from blocks to). Ignore duplicates (idempotent via PK). */
function insertEdge(cdb: CoordDb, fromTask: string, toTask: string): void {
  cdb.db
    .prepare(
      `INSERT OR IGNORE INTO task_edges (from_task, to_task, kind, host_id, origin)
       VALUES (?, ?, 'blocks', ?, 'local')`,
    )
    .run(fromTask, toTask, cdb.hostId);
}

export type AddDependencyResult =
  | { ok: true }
  | { ok: false; reason: 'cycle' | 'not_found' | 'self'; detail: string };

/**
 * Add a dependency (blocks) edge between existing tasks: fromTask blocks toTask
 * (= toTask waits for fromTask to finish). The after-the-fact version of create_task(depends_on).
 * It cycle-checks before adding the edge and rejects with reason:'cycle' if it would form a cycle (§4.8 DAG invariant).
 */
export function addDependency(
  cdb: CoordDb,
  fromTask: string,
  toTask: string,
): AddDependencyResult {
  if (fromTask === toTask) {
    return { ok: false, reason: 'self', detail: 'a task cannot block itself' };
  }
  const db = cdb.db;
  const exists = (id: string): boolean =>
    !!db.prepare(`SELECT 1 FROM tasks WHERE id = ?`).get(id);
  if (!exists(fromTask) || !exists(toTask)) {
    return { ok: false, reason: 'not_found', detail: 'from_task or to_task does not exist' };
  }
  // Adding from→to forms a cycle if to is already reachable from from.
  if (isReachable(db, toTask, fromTask)) {
    return {
      ok: false,
      reason: 'cycle',
      detail: `edge ${fromTask}→${toTask} would create a dependency cycle`,
    };
  }
  insertEdge(cdb, fromTask, toTask);
  return { ok: true };
}

/** Fetch one (undefined if it does not exist). */
export function getTask(db: DatabaseSync, id: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

/** List of open tasks (priority descending → creation order). The client reads version and passes it to claim. */
export interface ListTasksArgs {
  status?: Task['status'];
  assignee?: string;
  ticketId?: string;
  repo?: string;
  readyOnly?: boolean;
}

/**
 * §2.1 list_tasks — list tasks (priority descending → creation order).
 * Filter by status/assignee/ticket_id/repo. With ready_only=true, return only tasks whose
 * from_task blockers are all done (unblocked).
 * When status='blocked', return each row in listBlockedTasks' shape (with blocked_age_sec, etc.).
 *
 * The ready decision is the same logic as board.isReady, but it is kept locally here to avoid a
 * claim.ts→board.ts import cycle (because board.ts imports claim.sweepExpired).
 */
export function listTasks(cdb: CoordDb, args: ListTasksArgs & { status: 'blocked' }): BlockedTaskView[];
export function listTasks(cdb: CoordDb, args?: ListTasksArgs): Task[];
export function listTasks(cdb: CoordDb, args: ListTasksArgs = {}): Task[] {
  const db = cdb.db;
  if (args.status === 'blocked') {
    const rows = listBlockedTasks(cdb, {
      repo: args.repo,
      assignee: args.assignee,
      ticketId: args.ticketId,
      order: 'priority',
    });
    return args.readyOnly ? rows.filter((t) => taskIsReady(db, t.id)) : rows;
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (args.status) {
    clauses.push('status = ?');
    params.push(args.status);
  }
  if (args.assignee) {
    clauses.push('assignee = ?');
    params.push(args.assignee);
  }
  if (args.ticketId) {
    clauses.push('ticket_id = ?');
    params.push(args.ticketId);
  }
  if (args.repo) {
    clauses.push('repo = ?');
    params.push(args.repo);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY priority DESC, created_at ASC`)
    .all(...(params as never[])) as unknown as Task[];

  // ready_only: exclude tasks that have any unfinished blocker.
  return args.readyOnly ? rows.filter((t) => taskIsReady(db, t.id)) : rows;
}

/** Whether all from_task blockers (blocks edges) are done. Same meaning as board.isReady. */
function taskIsReady(db: DatabaseSync, taskId: string): boolean {
  const blockers = db
    .prepare(
      `SELECT t.status AS status
         FROM task_edges e JOIN tasks t ON t.id = e.from_task
        WHERE e.to_task = ? AND e.kind = 'blocks'`,
    )
    .all(taskId) as unknown as Array<{ status: string }>;
  return blockers.every((b) => b.status === 'done');
}

/**
 * §4.1 atomic claim — SQLite CAS.
 * Take an immediate write lock with BEGIN IMMEDIATE, put all current-value conditions in WHERE, and
 * treat changes==0 as a conflict. expected_version also detects the "someone touched it between read
 * and claim" conflict.
 */
export function claimTask(
  cdb: CoordDb,
  taskId: string,
  agentId: string,
  expectedVersion: number,
): ClaimResult {
  const db = cdb.db;
  const now = unixNow();

  db.exec('BEGIN IMMEDIATE');
  try {
    const info = db
      .prepare(
        `UPDATE tasks
            SET assignee = ?,
                status = 'in_progress',
                version = version + 1,
                heartbeat_at = ?,
                updated_at = ?
          WHERE id = ?
            AND assignee IS NULL
            AND status = 'open'
            AND version = ?`,
      )
      .run(agentId, now, now, taskId, expectedVersion);

    if (info.changes === 0) {
      // Conflict or absence. Read the current value to distinguish the reason (read in the same transaction).
      const current = db
        .prepare('SELECT assignee, status, version FROM tasks WHERE id = ?')
        .get(taskId) as Pick<Task, 'assignee' | 'status' | 'version'> | undefined;
      db.exec('ROLLBACK');
      if (!current) return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'conflict', current };
    }

    const task = getTask(db, taskId)!;

    // 1A: when any task under it is claimed, auto-transition the parent ticket open→in_progress.
    // Only when ticket_id is non-null (a minor task = ticket_id null has no ticket, so do nothing).
    // For atomicity, bundle the claim success (tasks CAS) and the ticket transition in the same
    // BEGIN IMMEDIATE transaction. With the same policy as createTask ("write the tasks INSERT +
    // ticket re-arm SQL directly within the transaction boundary"), write here the same local CAS as
    // tickets.ts's markTicketInProgressOnClaim (importing claim.ts→tickets.ts would not be a cycle,
    // but a separate transaction would break the atomicity of claim success and the ticket transition).
    // A one-way CAS that does not bump the version (WHERE status='open'): a ticket already
    // in_progress/closed is untouched (idempotent = spec 2A's "do not automatically return to open").
    // Do not use version-CAS so a user's concurrent edit of body etc. is not lost-updated (same idea as D-B1).
    if (task.ticket_id !== null) {
      db.prepare(
        `UPDATE tickets SET status = 'in_progress', updated_at = ?
          WHERE id = ? AND status = 'open'`,
      ).run(now, task.ticket_id);
    }

    db.exec('COMMIT');
    // The ticket transition's success/failure is not included in ClaimResult (backward compatible).
    // The claim success is the primary contract, and the ticket transition is an idempotent side
    // effect (no-op if already in_progress/closed), so the return contract is unchanged.
    return { ok: true, task };
  } catch (e) {
    // Always roll back on exception (do not exit while holding the lock).
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore if already closed */
    }
    throw e;
  }
}

/**
 * Explicit release. Only the claim holder can transition (the assignee match is a CAS condition).
 * outcome='open' (default) = return to open (abandon so it can be re-claimed).
 * outcome='abandoned'      = make it abandoned (no longer worked on; not a re-claim target).
 * The done transition is a separate path (the merge gate = task_done), so it is not handled here.
 */
export function releaseTask(
  cdb: CoordDb,
  taskId: string,
  agentId: string,
  outcome: 'open' | 'abandoned' = 'open',
): { ok: boolean } {
  const now = unixNow();
  const newStatus = outcome === 'abandoned' ? 'abandoned' : 'open';
  const info = cdb.db
    .prepare(
      `UPDATE tasks
          SET assignee = NULL, status = ?, version = version + 1, heartbeat_at = NULL, updated_at = ?
        WHERE id = ? AND assignee = ? AND status = 'in_progress'`,
    )
    .run(newStatus, now, taskId, agentId);

  // Issue #45 item 2: when a task is released (returned to open / abandoned), also release the active
  // claims that have that task_id together. release is a "give up the work" operation, so leaving the
  // tied claims would keep them appearing in overlaps as "finished work". Release for both open and
  // abandoned. claim.ts cannot import files.ts (which exports sweepExpired) due to a cycle, so, like
  // sweepExpired and heartbeat, write a raw UPDATE claims directly. Release by task_id match regardless of holder.
  if (info.changes > 0) {
    cdb.db
      .prepare(
        `UPDATE claims SET released_at = ?
          WHERE task_id = ? AND released_at IS NULL`,
      )
      .run(now, taskId);

    // Issue #49 auto-resolution (main path, abandoned side): only when the task is dropped to
    // abandoned (outcome='abandoned' and it actually transitioned, info.changes>0), auto-resolve the
    // unresolved questions that have that task as ref_task_id. On a return to open (outcome='open'),
    // the task is not finished yet, so do not resolve. resolvedBy is the releasing subject (agentId).
    // Only unresolved ones are targeted, so it is idempotent (a double resolve is a no-op). board.ts
    // imports claim.ts's sweepExpired, so importing claim.ts→board.ts would be a cycle. So instead of
    // calling board.resolveQuestionsForTask, write the equivalent raw UPDATE here (the same style as
    // releaseTask writing a raw UPDATE to claims).
    if (outcome === 'abandoned') {
      cdb.db
        .prepare(
          `UPDATE board_messages
              SET resolved_at = ?, resolved_by = ?
            WHERE ref_task_id = ? AND kind = 'question' AND resolved_at IS NULL`,
        )
        .run(now, agentId, taskId);
    }
  }
  return { ok: info.changes > 0 };
}

/**
 * §4.x block_task — suspend to wait for a human decision (in_progress → blocked).
 *
 * Called before exiting when a headless worker cannot finish due to lacking permission / waiting for
 * a design decision, etc. The decisive difference from release_task (return to open) / complete_task
 * (done) is that it **keeps the assignee and heartbeat_at**: even suspended, it leaves "who got stuck
 * in which worktree" in the state and preserves the worktree (assignment continuity = option (b)).
 *
 * blocked is excluded from the lease sweep (sweepExpired reclaims only status='in_progress'), so even
 * if the worker process dies and heartbeat stops, it is **kept indefinitely** (the machine does not
 * return it on its own). It is returned only by a human-decided resume_task (same-agent resume) /
 * handoff (hand to another worker) / release_task (abandoned = cancel).
 *
 * The stuck reason is externalized to the board (post_board kind='question', ref_task_id) rather than
 * adding a column to the task itself. Worker convention: leave the question first, then call
 * block_task (since heartbeat stops at blocked, if it dies before writing the reason the way it got stuck is unknown).
 *
 * CAS: conditioned on "assignee = agentId and status = 'in_progress'". If it does not match, ok:false.
 *
 * Not taking expected_version is asymmetric with claimTask but intentional: claim needs version to
 * detect the conflict where "multiple unassigned agents read the same open task and someone snatched
 * it before claim". block/resume/handoff are transitions on a task whose assignee is already fixed to
 * a single subject, and only that assignee is eligible. The only real conflict leaving blocked
 * (concurrent resume ⇄ handoff) is serialized by the status condition + handoff's BEGIN IMMEDIATE,
 * functioning as "status itself is the CAS" (leaving blocked happens only once). resume has no
 * "freshness at read time" dependency like claim, so ABA is not harmful either.
 */
export function blockTask(
  cdb: CoordDb,
  taskId: string,
  agentId: string,
): { ok: boolean } {
  const now = unixNow();
  const info = cdb.db
    .prepare(
      `UPDATE tasks
          SET status = 'blocked', version = version + 1, updated_at = ?
        WHERE id = ? AND assignee = ? AND status = 'in_progress'`,
    )
    .run(now, taskId, agentId);
  // assignee / heartbeat_at are intentionally not updated (kept).
  return { ok: info.changes > 0 };
}

/**
 * §4.x resume_task — same-agent resume when a human says "continue" (blocked → in_progress).
 *
 * Since blockTask keeps the claim, the same logical agent can return it with an assignee match. The
 * worktree stays as-is. heartbeat_at is updated to now to revive the lease (afterward it returns to
 * being under sweep supervision as a normal in_progress). Handing to another worker is done not by
 * resume but by handoff (only when a human says so explicitly).
 *
 * CAS: conditioned on "assignee = agentId and status = 'blocked'". If it does not match, ok:false
 * (held by another agent / already in_progress/open, etc.).
 *
 * Like blockTask, it does not take expected_version (intentional; see blockTask's doc for the
 * reason). Even if resume ⇄ handoff run concurrently, the status='blocked' in both WHERE clauses lets
 * only one win first and the other gets changes==0, so it is serialized without needing version.
 */
export function resumeTask(
  cdb: CoordDb,
  taskId: string,
  agentId: string,
): { ok: boolean } {
  const now = unixNow();
  const info = cdb.db
    .prepare(
      `UPDATE tasks
          SET status = 'in_progress', heartbeat_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND assignee = ? AND status = 'blocked'`,
    )
    .run(now, now, taskId, agentId);
  return { ok: info.changes > 0 };
}

export type HandoffResult =
  | {
    ok: true;
    /** Counts of the accompanying state that was moved (for the caller's confirmation/logs). */
    moved: { worktrees: number; claims: number; dirty_sets: number };
    /** The list of worktree paths after the move (where the new agent cd's to). */
    worktrees: string[];
  }
  | {
    ok: false;
    reason: 'not_found' | 'conflict';
    current?: Pick<Task, 'assignee' | 'status' | 'version'>;
  };

/**
 * §4.7 handoff — **move a blocked task to another worker per worktree, all at once** (briefing D-3 decided).
 *
 * Adopted operation: resuming from suspension is, in principle, resume_task (same agent). Handing to
 * another worker is **only when a human says so explicitly**, and this handoff is the sole path. So
 * when this function is called, a human decision has already been made (the gate is outside the MCP
 * tool = on the orchestrator/human side).
 *
 * "Per-worktree bulk move" means reassigning the following that the stuck agent A held to agent B, all
 * in the **same CAS transaction**:
 *   1. the task itself      : blocked(assignee=A) → in_progress(assignee=B), heartbeat revived
 *   2. worktree_assignments : this task's active worktree from agent A → B (branch/path unchanged = physical side as-is)
 *   3. claims (glob lease)  : active claims with task_id=this task and holder=A to holder B
 *   4. dirty_sets           : the (agent_id=A) rows of the moved worktree to agent_id=B
 * This way B inherits "the worktree A physically created, the claims it held, and the published dirty
 * set" wholesale and can continue from where the predecessor's work surface left off (the process
 * cannot be switched over, but the work can).
 *
 * Preventing double handoff: BEGIN IMMEDIATE + a CAS of "assignee=fromAgent and status='blocked'".
 * If it was already moved to another agent / resumed / is held by someone other than A, changes==0 →
 * conflict and nothing moves. No new exclusion mechanism is added (follows the existing CAS style).
 *
 * worktree_path/branch are not changed: the physical worktree stays as-is on the FS, and only the
 * owner (agent_id) is reassigned. B cd's into this worktree path and continues. As a measure for
 * dirty_sets' UNIQUE(agent_id, worktree_path), in case B previously left a dirty row for the same
 * worktree, DELETE B's leftover for the same worktree in the same transaction before the UPDATE
 * (since a history of A↔B going back and forth over the same deterministic worktree via §4.5
 * reconnection could make (B, path) duplicate).
 *
 * Limiting the entry condition to blocked is intentional: being able to snatch-move an in_progress
 * task would be a "steal work from a live worker" accident. A move always follows the order "suspend
 * (blocked), then a human names another worker".
 */
export function handoffTask(
  cdb: CoordDb,
  args: { taskId: string; fromAgent: string; toAgent: string },
): HandoffResult {
  const db = cdb.db;
  const now = unixNow();
  const { taskId, fromAgent, toAgent } = args;

  db.exec('BEGIN IMMEDIATE');
  try {
    // 1) Move the task itself A→B by CAS (only blocked and assignee=A). This is the gate against double handoff.
    const taskInfo = db
      .prepare(
        `UPDATE tasks
            SET assignee = ?, status = 'in_progress', heartbeat_at = ?,
                version = version + 1, updated_at = ?
          WHERE id = ? AND assignee = ? AND status = 'blocked'`,
      )
      .run(toAgent, now, now, taskId, fromAgent);

    if (taskInfo.changes === 0) {
      const current = db
        .prepare('SELECT assignee, status, version FROM tasks WHERE id = ?')
        .get(taskId) as Pick<Task, 'assignee' | 'status' | 'version'> | undefined;
      db.exec('ROLLBACK');
      if (!current) return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'conflict', current };
    }

    // 2) Move this task's active worktree A→B. Pick up the paths first, then reassign dirty_sets.
    const wtRows = db
      .prepare(
        `SELECT worktree_path FROM worktree_assignments
          WHERE agent_id = ? AND task_id = ? AND status = 'active'`,
      )
      .all(fromAgent, taskId) as unknown as Array<{ worktree_path: string }>;
    const worktrees = wtRows.map((r) => r.worktree_path);

    const wtInfo = db
      .prepare(
        `UPDATE worktree_assignments
            SET agent_id = ?
          WHERE agent_id = ? AND task_id = ? AND status = 'active'`,
      )
      .run(toAgent, fromAgent, taskId);

    // 3) Move active claims tied to this task (holder=A) to B. Narrow by task_id match
    //    (do not sweep in claims A holds for another task = faithful to a per-worktree move).
    const claimInfo = db
      .prepare(
        `UPDATE claims
            SET holder = ?
          WHERE holder = ? AND task_id = ? AND released_at IS NULL`,
      )
      .run(toAgent, fromAgent, taskId);

    // 4) Move the moved worktree's dirty_sets A→B. Per-worktree, so only (agent_id=A and
    //    worktree_path IN moved-worktrees).
    //    UNIQUE(agent_id, worktree_path) measure: if B previously left a dirty_set for the same
    //    worktree_path (a history of A↔B going back and forth over the same deterministic worktree via
    //    §4.5 reconnection), the moment agent_id is rewritten A→B, (B, path) would duplicate, SQLite
    //    raises an exception → full rollback. So before the reassignment, clean up B's leftover for
    //    the same worktree in the same transaction, then UPDATE. The cleanup target is limited to "the
    //    worktree currently being moved from A to B" (B's unrelated dirty_set is preserved).
    let dirtyMoved = 0;
    if (worktrees.length > 0) {
      const placeholders = worktrees.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM dirty_sets
          WHERE agent_id = ? AND worktree_path IN (${placeholders})`,
      ).run(toAgent, ...(worktrees as never[]));
      const dirtyInfo = db
        .prepare(
          `UPDATE dirty_sets
              SET agent_id = ?
            WHERE agent_id = ? AND worktree_path IN (${placeholders})`,
        )
        .run(toAgent, fromAgent, ...(worktrees as never[]));
      dirtyMoved = Number(dirtyInfo.changes);
    }

    db.exec('COMMIT');
    return {
      ok: true,
      moved: {
        worktrees: Number(wtInfo.changes),
        claims: Number(claimInfo.changes),
        dirty_sets: dirtyMoved,
      },
      worktrees,
    };
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
 * Set a task to done (called from the merge gate on a successful merge).
 * The same CAS style as claimTask: conditioned on "assignee = agentId and status = 'in_progress'",
 * update status='done', version+1, and updated_at.
 *
 * The only legitimate basis for the done transition is the fact of "merged into the main line", so
 * this function is called only at merge.ts's merge-success point (follows the role separation from
 * release_task = return-to-open only). If it does not match, ok:false (held by another agent /
 * already done/open, etc.).
 */
export function completeTask(
  cdb: CoordDb,
  taskId: string,
  agentId: string,
): { ok: boolean } {
  const now = unixNow();
  const info = cdb.db
    .prepare(
      `UPDATE tasks
          SET status = 'done', assignee = NULL, version = version + 1,
              heartbeat_at = NULL, updated_at = ?
        WHERE id = ? AND assignee = ? AND status = 'in_progress'`,
    )
    .run(now, taskId, agentId);
  return { ok: info.changes > 0 };
}

/**
 * §4.x list_tasks(status='blocked') — orphan visualization of blocked tasks.
 *
 * blocked is excluded from the lease sweep = kept indefinitely, so a "worker stuck and the human
 * forgot too" orphan can arise. This is **picked up by visualization rather than auto-reclamation**
 * (the adopted operation policy). No new table is added; it is provided as a join view over existing
 * data (tasks.updated_at/assignee + agents.last_seen_at + board_messages).
 *
 * Derived values attached to each row:
 * - blocked_age_sec   = now - tasks.updated_at   (elapsed since it dropped to blocked; older = longer neglected)
 * - agent_silent_sec  = now - agents.last_seen_at (the holder's silence time; null if agent unknown)
 * - last_question     = the latest question body with this task as ref_task_id (the stuck reason; null if none)
 *
 * The threshold (how many seconds counts as an orphan) is not hardcoded; the caller/operation decides
 * by looking at blocked_age_sec and agent_silent_sec.
 *
 * Order: the default is updated_at ascending (longest neglected first). list_tasks(status='blocked')
 * calls it with order='priority' to align with the same priority order as other statuses (a caller
 * wanting longest-neglected-first sorts by blocked_age_sec).
 */
export interface BlockedTaskView extends Task {
  blocked_age_sec: number;
  agent_silent_sec: number | null;
  last_question: string | null;
}

export function listBlockedTasks(
  cdb: CoordDb,
  args: {
    repo?: string;
    assignee?: string;
    ticketId?: string;
    now?: number;
    order?: 'oldest_first' | 'priority';
  } = {},
): BlockedTaskView[] {
  const db = cdb.db;
  const now = args.now ?? unixNow();
  const clauses: string[] = [`t.status = 'blocked'`];
  const params: unknown[] = [];
  if (args.repo) {
    clauses.push('t.repo = ?');
    params.push(args.repo);
  }
  if (args.assignee) {
    clauses.push('t.assignee = ?');
    params.push(args.assignee);
  }
  if (args.ticketId) {
    clauses.push('t.ticket_id = ?');
    params.push(args.ticketId);
  }
  const orderBy =
    args.order === 'priority' ? 't.priority DESC, t.created_at ASC' : 't.updated_at ASC';
  const rows = db
    .prepare(
      `SELECT t.*,
              a.last_seen_at AS _agent_last_seen,
              -- Issue #49 design decision: do not keep emitting a resolved question as last_question
              -- (resolved_at IS NULL = only unresolved). last_question's meaning is unchanged = the
              -- latest unresolved question body (null if none). A resolved question is no longer the
              -- "stuck reason" in the orphan-visualization context.
              (SELECT b.body FROM board_messages b
                 WHERE b.ref_task_id = t.id AND b.kind = 'question' AND b.resolved_at IS NULL
                 ORDER BY b.seq DESC LIMIT 1) AS _last_question
         FROM tasks t
         LEFT JOIN agents a ON a.agent_id = t.assignee
        WHERE ${clauses.join(' AND ')}
        ORDER BY ${orderBy}`,
    )
    .all(...(params as never[])) as unknown as Array<
      Task & { _agent_last_seen: number | null; _last_question: string | null }
    >;
  return rows.map((r) => {
    const { _agent_last_seen, _last_question, ...task } = r;
    return {
      ...(task as Task),
      blocked_age_sec: now - task.updated_at,
      agent_silent_sec: _agent_last_seen == null ? null : now - _agent_last_seen,
      last_question: _last_question ?? null,
    };
  });
}

/**
 * §4.2 lease sweep — reclaim expired claims + return heartbeat-lapsed tasks to open.
 * Assumed to run piggybacked at the head of each tool call rather than a resident cron.
 */
export function sweepExpired(cdb: CoordDb, now: number = unixNow()): void {
  const db = cdb.db;
  // 1) Logically reclaim expired claims (no physical DELETE = for provenance tracking)
  db.prepare(
    `UPDATE claims SET released_at = ?
      WHERE released_at IS NULL AND expires_at < ?`,
  ).run(now, now);

  // 2) Return heartbeat-lapsed in_progress tasks to open
  db.prepare(
    `UPDATE tasks
        SET status = 'open', assignee = NULL, version = version + 1, updated_at = ?
      WHERE status = 'in_progress' AND heartbeat_at < ?`,
  ).run(now, now - TASK_LEASE_SEC);
  // 3) agents' liveness is judged by last_seen (for worktree orphan detection). No auto release.
}

export interface HeartbeatOpts {
  /** Also update the held task's heartbeat_at (a claiming worker specifies its own task). */
  taskId?: string;
  /**
   * Whether to update agents.last_seen_at to now (default true).
   *
   * Set to false for tools where "someone who is not the worker process itself operates the ledger"
   * (block_task / resume_task / handoff_task). These are invoked by the orchestrator/human, so
   * freshening agents.last_seen with that operation time would pollute a blocked task's
   * agent_silent_sec (= the metric for the worker process's liveness) with the "operation time" and
   * skew orphan detection. So, to not confuse "operation time" with "worker liveness time", do not
   * touch the agent's last_seen for operations by non-owners. The claims lease extension is also tied
   * to the owner's liveness, so suppress it likewise.
   */
  touchAgent?: boolean;
  /**
   * Whether to update the heartbeat_at of all in_progress tasks assigned to this agent to now
   * (default equals touchAgent = true only on the owner's liveness signal).
   *
   * Issue #51 handling. Previously heartbeat() updated tasks.heartbeat_at only when opts.taskId was
   * explicit. But the piggyback call at the head of each tool handler passes heartbeat(cdb, agentId)
   * without taskId, so agents.last_seen and the claims lease extended but only the task lease did
   * not; if after claiming you kept calling only publish_dirty etc. at intervals under
   * TASK_LEASE_SEC without calling the heartbeat tool, the sweepExpired running at the head of
   * another agent's tool call would return the task to open — an accident. So, to make the
   * description "heartbeat is piggybacked onto every tool call" (proposal 4) match actual behavior,
   * add a path that extends the lease of owned in_progress tasks even on a piggyback that passes no taskId.
   *
   * For operations invoked by non-owners (block_task / resume_task / handoff_task = touchAgent:false),
   * the task lease must not be freshened (so as not to pollute blocked tasks' orphan decision). So the
   * default is aligned to touchAgent, and if touchAgent=false, touchOwnedTasks is automatically
   * treated as false (the simplest policy to link the owner-liveness-tied behaviors together).
   * blocked tasks are kept indefinitely and excluded from the lease sweep, so they are intentionally
   * excluded (not touched).
   */
  touchOwnedTasks?: boolean;
}

/**
 * The heartbeat piggybacked onto every tool call. Updates the worker's own liveness time
 * (agents.last_seen) and the lease of held tasks/claims.
 *
 * The 3rd argument also accepts a taskId string for backward compatibility (= same as { taskId }).
 * Passing touchAgent=false suppresses the extension of agents.last_seen and the claims lease
 * (for operations invoked by non-owners = the orchestrator/human; prevents polluting orphan detection).
 *
 * Issue #51 handling: even on a piggyback call that passes no taskId (heartbeat(cdb, agentId)), if
 * touchOwnedTasks (default = touchAgent) is true, extend the heartbeat_at of all in_progress tasks
 * assigned to that agent to now. This way the task lease is maintained by the piggyback of each tool
 * call alone, even without calling the heartbeat tool (with taskId), and prevents wrongful
 * reclamation by sweepExpired.
 */
export function heartbeat(
  cdb: CoordDb,
  agentId: string,
  opts?: string | HeartbeatOpts,
): void {
  const db = cdb.db;
  const now = unixNow();
  const o: HeartbeatOpts =
    typeof opts === 'string' ? { taskId: opts } : (opts ?? {});
  const touchAgent = o.touchAgent ?? true;
  // Owned tasks' lease extension only on the owner's liveness signal (do not freshen for non-owner =
  // touchAgent:false operations). So align the default to touchAgent. An explicit value takes precedence.
  const touchOwnedTasks = o.touchOwnedTasks ?? touchAgent;

  if (touchAgent) {
    // Update agents.last_seen (upsert if absent). Only on the worker's own liveness signal.
    db.prepare(
      `INSERT INTO agents (agent_id, label, last_seen_at, created_at, host_id, origin)
       VALUES (?, NULL, ?, ?, ?, 'local')
       ON CONFLICT(agent_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    ).run(agentId, now, now, cdb.hostId);
  }

  if (o.taskId) {
    // When taskId is explicit, update only "that one (assignee match)" as before.
    db.prepare(
      `UPDATE tasks SET heartbeat_at = ? WHERE id = ? AND assignee = ?`,
    ).run(now, o.taskId, agentId);
  } else if (touchOwnedTasks) {
    // Issue #51: even without taskId (= the piggyback of each tool call), extend the lease of all
    // in_progress tasks held by this agent. blocked is kept indefinitely and excluded from sweep, so
    // do not touch it. claim.ts does not import board/files (to avoid a cycle), so write the equivalent raw UPDATE directly.
    db.prepare(
      `UPDATE tasks SET heartbeat_at = ? WHERE assignee = ? AND status = 'in_progress'`,
    ).run(now, agentId);
  }

  if (touchAgent) {
    // Extend the lease of held claims (tied to the owner's liveness, so linked to touchAgent).
    //
    // Issue #45 item 4: narrow the extension target to "claims not tied to a task (task_id IS NULL)"
    // or "claims of still-live tasks (in_progress / blocked)". Previously all active claims the holder
    // had were extended without narrowing by task_id, so as long as the agent continued another task,
    // expires_at kept extending even for claims of tasks already dropped to done / abandoned / open
    // and they were not reclaimed even by TTL (the cause of finished work's claims lingering in
    // overlaps). Exclude claims tied to done / abandoned / open tasks from the extension target and
    // leave them to the item 1-3 release or TTL expiry.
    db.prepare(
      `UPDATE claims SET heartbeat_at = ?, expires_at = ? + lease_ttl_sec
        WHERE holder = ? AND released_at IS NULL
          AND (task_id IS NULL
               OR task_id IN (SELECT id FROM tasks WHERE status IN ('in_progress', 'blocked')))`,
    ).run(now, now, agentId);
  }
}
