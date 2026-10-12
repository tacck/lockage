import { ulid } from 'ulid';
import { unixNow, type CoordDb } from '../db/index.js';

/**
 * §2.2 Ticket operations (model 3: a grouping unit for issues).
 *
 * A ticket is a cross-repo, long-lived, unclaimed grouping unit for issues (requirement FR-7). It
 * does not have the heavy claim/lease/worktree machinery and sticks to light operations on status +
 * body FTS5. 1 ticket → N tasks via tasks.ticket_id (nullable FK).
 *
 * - D-1 decided: ticket↔repo is the join table ticket_repos. **A ticket with no rows = fully cross-repo (repo-independent)**.
 * - D-4 decided: concurrent-edit conflicts on body/status are detected by version-CAS (only update_ticket is CAS).
 * - The body is full-text searched via tickets_fts (FTS5 external content). Auto-synced by triggers (schema.sql).
 */

export interface Ticket {
  id: string;
  title: string;
  body: string | null;
  status: 'open' | 'in_progress' | 'closed';
  priority: number;
  assignee: string | null;
  version: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  host_id: string;
  origin: string;
  /** The ticket integration branch name added by problem A (not yet generated = null). Problem B's publisher pushes it. */
  integration_branch: string | null;
  /** The ticket_ready emission time of problem A (not emitted = null). Idempotent emission is ensured by CAS. */
  ticket_ready_at: number | null;
}

/** Fetch one (undefined if it does not exist). */
export function getTicket(cdb: CoordDb, id: string): Ticket | undefined {
  return cdb.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Ticket | undefined;
}

export type ClearIntegrationBranchResult =
  | { ok: true; cleared: boolean }
  | { ok: false; reason: 'not_found' };

/**
 * §4.5 / problem B B-3 — reset the ticket integration branch registration (integration_branch) to NULL.
 *
 * The only core write-back the publisher (problem B) makes during post-merge cleanup.
 * integration_branch is a system column that "problem A reserves at aggregation and problem B
 * releases after merge", not a field users edit. So it is separated from update_ticket (which
 * guards user edits with version-CAS) into a dedicated path that does not bump the version (the D-B1 resolution).
 *
 * Idempotent: if already NULL, just return cleared=false (changes==0) and do nothing. A missing
 * ticket is not_found. Passing expectedBranch is a "reset to NULL only when the name matches" guard,
 * so a new integration_branch re-created by another aggregation is not wrongly cleared (insurance
 * for the case where re-aggregation happened between merge detection and release).
 */
export function clearIntegrationBranch(
  cdb: CoordDb,
  ticketId: string,
  expectedBranch?: string,
): ClearIntegrationBranchResult {
  const db = cdb.db;
  const exists = db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(ticketId);
  if (!exists) return { ok: false, reason: 'not_found' };
  let info;
  if (expectedBranch !== undefined) {
    info = db
      .prepare(
        `UPDATE tickets SET integration_branch = NULL, updated_at = ?
          WHERE id = ? AND integration_branch = ?`,
      )
      .run(unixNow(), ticketId, expectedBranch);
  } else {
    info = db
      .prepare(
        `UPDATE tickets SET integration_branch = NULL, updated_at = ?
          WHERE id = ? AND integration_branch IS NOT NULL`,
      )
      .run(unixNow(), ticketId);
  }
  return { ok: true, cleared: info.changes > 0 };
}

/**
 * §4.3 fix option A (F2 re-arm) — reset ticket_ready_at to NULL to make ticket_ready be emitted "again".
 *
 * When an unfinished task is added/linked to a ticket that already emitted ready (ticket_ready_at IS
 * NOT NULL), merge.ts's tryEmitTicketReady loses the NULL→value CAS and cannot re-emit (= a B added
 * later does not make it into the PR). To solve this, issue a reverse CAS that resets ticket_ready_at
 * from value→NULL. Then on the new task's done, tryEmitTicketReady's NULL→value CAS passes again and
 * ticket_ready is re-emitted.
 *
 * A local CAS symmetric to tryEmitTicketReady's NULL→value CAS (WHERE ticket_ready_at IS NOT NULL).
 * Does not change integration_branch (the integration branch name) or version (ticket_ready_at is a
 * system column with an unchanged version; same idea as clearIntegrationBranch).
 *
 * @returns true if changes>0 (= actually re-armed). false if already NULL (not emitted).
 */
export function rearmTicketReady(cdb: CoordDb, ticketId: string): boolean {
  const info = cdb.db
    .prepare(
      `UPDATE tickets SET ticket_ready_at = NULL, updated_at = ?
        WHERE id = ? AND ticket_ready_at IS NOT NULL`,
    )
    .run(unixNow(), ticketId);
  return info.changes > 0;
}

/** Result of closeTicketOnMerge. */
export type CloseTicketOnMergeResult =
  | { ok: true; closed: boolean }
  | { ok: false; reason: 'not_found' };

/**
 * Problem B B-3 — set the ticket to closed during post-merge cleanup (reconcile only).
 *
 * "Marking a ticket merged (closed)" is the publisher's mechanical post-merge cleanup, not the kind
 * of edit where a user rewrites the body. So, aligned with clearIntegrationBranch / rearmTicketReady
 * (D-B1), it is separated from update_ticket (which guards user edits with version-CAS) into a
 * dedicated path that does not bump the version. As a result:
 *   - reconcile's cleanup (① integration_branch release / ② status close) is symmetric as "system
 *     operations that do not bump the version".
 *   - It does not use version-CAS, so a version conflict cannot occur structurally and reconcile's
 *     conflict retry is unnecessary. Even if a human/other agent is concurrently editing the ticket's
 *     body etc., it does not steal that version and induce a lost update (a local CAS that only closes
 *     status one-way, so it does not interfere with edits).
 *
 * Idempotent: if already closed (status='closed'), just return closed=false (changes==0) and do
 * nothing. A missing ticket is not_found. A local CAS symmetric to rearmTicketReady (WHERE status != 'closed').
 *
 * Note: this path only flips status one-way to closed and never re-opens (reconcile never re-opens).
 * If a ticket needs to be re-opened, the user does it via update_ticket as before.
 */
export function closeTicketOnMerge(cdb: CoordDb, ticketId: string): CloseTicketOnMergeResult {
  const db = cdb.db;
  const exists = db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(ticketId);
  if (!exists) return { ok: false, reason: 'not_found' };
  const info = db
    .prepare(
      `UPDATE tickets SET status = 'closed', updated_at = ?
        WHERE id = ? AND status != 'closed'`,
    )
    .run(unixNow(), ticketId);
  return { ok: true, closed: info.changes > 0 };
}

/** Result of markTicketInProgressOnClaim. Follows closeTicketOnMerge's CloseTicketOnMergeResult. */
export type MarkTicketInProgressResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: 'not_found' };

/**
 * 1A — when any task under it is claimed, flip the parent ticket open→in_progress (reconcile only).
 *
 * "Marking a ticket in progress (in_progress)" is a status operation done automatically in step with
 * the mechanical event of a claim, not the kind of edit where a user rewrites the body. So, aligned
 * with closeTicketOnMerge / clearIntegrationBranch / rearmTicketReady (D-B1), it is separated from
 * update_ticket (which guards user edits with version-CAS) into a dedicated path that does not bump
 * the version. As a result:
 *   - It does not use version-CAS, so a version conflict cannot occur structurally, and even if a
 *     human/other agent is concurrently editing the ticket's body etc., it does not steal that
 *     version and induce a lost update (a local CAS that only flips status one-way, so it does not interfere with edits).
 *   - A local CAS dedicated to open → in_progress, symmetric to closeTicketOnMerge (open/in_progress → closed).
 *
 * One-way transition (spec 2A): open → in_progress only. It does not automatically return to open
 * (even if a task returns to open via release/sweep, the ticket stays in_progress until it becomes
 * closed). If a re-open is needed, the user does it via update_ticket.
 *
 * Idempotent: a ticket already in_progress / closed falls out of WHERE status = 'open' and is not
 * touched (just returns changed=false and does nothing). A local CAS symmetric to closeTicketOnMerge
 * (WHERE status = 'open'). A missing ticket is not_found.
 *
 * This function assumes the same SQL is written inline inside claimTask's transaction (for
 * atomicity), but like closeTicketOnMerge / rearmTicketReady it is exported to be unit-testable.
 */
export function markTicketInProgressOnClaim(
  cdb: CoordDb,
  ticketId: string,
): MarkTicketInProgressResult {
  const db = cdb.db;
  const exists = db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(ticketId);
  if (!exists) return { ok: false, reason: 'not_found' };
  const info = db
    .prepare(
      `UPDATE tickets SET status = 'in_progress', updated_at = ?
        WHERE id = ? AND status = 'open'`,
    )
    .run(unixNow(), ticketId);
  return { ok: true, changed: info.changes > 0 };
}

/** The list of repos tied to the ticket (fully cross-repo = empty array). */
export function ticketRepos(cdb: CoordDb, ticketId: string): string[] {
  const rows = cdb.db
    .prepare('SELECT repo FROM ticket_repos WHERE ticket_id = ? ORDER BY repo')
    .all(ticketId) as unknown as Array<{ repo: string }>;
  return rows.map((r) => r.repo);
}

/**
 * §2.2 open_ticket — create a ticket.
 * repos omitted or empty array = fully cross-repo (no row inserted into ticket_repos). The body is FTS5-indexed (triggers).
 */
export function openTicket(
  cdb: CoordDb,
  args: {
    title: string;
    body?: string | null;
    repos?: string[];
    priority?: number;
    createdBy?: string | null;
  },
): Ticket {
  const db = cdb.db;
  const now = unixNow();
  const id = ulid();
  const repos = args.repos ?? [];

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO tickets (id, title, body, status, priority, assignee, version,
                           created_by, created_at, updated_at, host_id, origin)
       VALUES (?, ?, ?, 'open', ?, NULL, 0, ?, ?, ?, ?, 'local')`,
    ).run(
      id,
      args.title,
      args.body ?? null,
      args.priority ?? 0,
      args.createdBy ?? null,
      now,
      now,
      cdb.hostId,
    );
    // Insert join rows only when repos is specified (empty = the fully-cross-repo convention). Ignore duplicates.
    const seen = new Set<string>();
    for (const repo of repos) {
      if (seen.has(repo)) continue;
      seen.add(repo);
      db.prepare(
        `INSERT OR IGNORE INTO ticket_repos (ticket_id, repo, host_id, origin)
         VALUES (?, ?, ?, 'local')`,
      ).run(id, repo, cdb.hostId);
    }
    db.exec('COMMIT');
    return getTicket(cdb, id)!;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already closed */
    }
    throw e;
  }
}

export type UpdateTicketResult =
  | { ok: true; ticket: Ticket }
  | {
    ok: false;
    reason: 'conflict' | 'not_found';
    current?: Pick<Ticket, 'status' | 'version'>;
  };

/**
 * §2.2 update_ticket — update a ticket (D-4: version-CAS).
 * Partially updates status/body/priority/assignee. expected_version prevents lost updates.
 * A conflict (version mismatch) is ok:false + the current value; absence is not_found.
 */
export function updateTicket(
  cdb: CoordDb,
  args: {
    ticketId: string;
    expectedVersion: number;
    status?: Ticket['status'];
    body?: string | null;
    priority?: number;
    assignee?: string | null;
  },
): UpdateTicketResult {
  const db = cdb.db;
  const now = unixNow();

  // Build the SET clause dynamically (update only the passed fields). version is always +1; the CAS is in WHERE.
  const sets: string[] = ['version = version + 1', 'updated_at = ?'];
  const params: unknown[] = [now];
  if (args.status !== undefined) {
    sets.push('status = ?');
    params.push(args.status);
  }
  if (args.body !== undefined) {
    sets.push('body = ?');
    params.push(args.body);
  }
  if (args.priority !== undefined) {
    sets.push('priority = ?');
    params.push(args.priority);
  }
  if (args.assignee !== undefined) {
    sets.push('assignee = ?');
    params.push(args.assignee);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const info = db
      .prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ? AND version = ?`)
      .run(...(params as never[]), args.ticketId, args.expectedVersion);

    if (info.changes === 0) {
      const current = db
        .prepare('SELECT status, version FROM tickets WHERE id = ?')
        .get(args.ticketId) as Pick<Ticket, 'status' | 'version'> | undefined;
      db.exec('ROLLBACK');
      if (!current) return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'conflict', current };
    }
    const ticket = getTicket(cdb, args.ticketId)!;
    db.exec('COMMIT');
    return { ok: true, ticket };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already closed */
    }
    throw e;
  }
}

export interface TicketListItem extends Ticket {
  repos: string[]; // empty = fully cross-repo
}

/**
 * §2.2 list_tickets — list/search.
 * - Filter by status.
 * - When repo is specified, return "tickets having that repo + fully cross-repo (no ticket_repos row)" (the D-1 query convention).
 * - When query is specified, full-text search the body/title via tickets_fts (FTS5).
 * priority descending → creation order. Each ticket carries repos.
 */
export function listTickets(
  cdb: CoordDb,
  args: { status?: Ticket['status']; repo?: string; query?: string; limit?: number } = {},
): TicketListItem[] {
  const db = cdb.db;
  const limit = args.limit ?? 100;
  const clauses: string[] = [];
  const params: unknown[] = [];
  const q = args.query?.trim();
  // trigram cannot index 2 chars or fewer, so a short query falls back to LIKE.
  const useLike = !!q && [...q].length < 3;

  // FTS5 search: narrow rowids with tickets_fts MATCH and JOIN to the main table.
  let from = 'tickets i';
  if (q && !useLike) {
    from = 'tickets i JOIN tickets_fts f ON f.rowid = i.rowid';
    clauses.push('tickets_fts MATCH ?');
    params.push(q);
  } else if (q && useLike) {
    const like = `%${q}%`;
    clauses.push('(i.title LIKE ? OR i.body LIKE ?)');
    params.push(like, like);
  }
  if (args.status) {
    clauses.push('i.status = ?');
    params.push(args.status);
  }
  if (args.repo) {
    // Has that repo OR fully cross-repo (no ticket_repos row)
    clauses.push(
      `( EXISTS (SELECT 1 FROM ticket_repos r WHERE r.ticket_id = i.id AND r.repo = ?)
         OR NOT EXISTS (SELECT 1 FROM ticket_repos r WHERE r.ticket_id = i.id) )`,
    );
    params.push(args.repo);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT i.* FROM ${from} ${where}
        ORDER BY i.priority DESC, i.created_at ASC LIMIT ?`,
    )
    .all(...(params as never[]), limit) as unknown as Ticket[];

  return rows.map((r) => ({ ...r, repos: ticketRepos(cdb, r.id) }));
}

export type LinkTaskResult =
  | { ok: true }
  | { ok: false; reason: 'task_not_found' | 'ticket_not_found'; detail: string };

/**
 * §2.2 link_task_to_ticket — re-link a task to a parent ticket (ticket_id=null to unlink).
 * Cross-project decomposition is expressed by "creating N tasks per repo under the same ticket_id".
 *
 * Fix option A (F2 re-arm): if the link-target ticket already emitted ready (ticket_ready_at IS NOT
 * NULL) and the task being linked is unfinished (tasks.status != 'done'), reset ticket_ready_at to
 * NULL to make ticket_ready re-emit (equivalent to rearmTicketReady). Re-linking an already-done task
 * does not break the all-done decision, so it does not re-arm (the trigger condition is "the task
 * being linked is unfinished AND the link-target ticket already emitted ready"). The tasks UPDATE and
 * the re-arm are atomized in the same BEGIN IMMEDIATE transaction (so consistency does not break if only one succeeds).
 *
 * 1A (auto-transition on late link / symmetric to claimTask): when an already-claimed task
 * (status === 'in_progress') is later linked to an open ticket, auto-transition the parent ticket
 * open → in_progress. This is symmetric to claimTask flipping the parent ticket on a successful
 * claim; because the parent of a claimed task may be left open (e.g. the ticket was unlinked at claim
 * time), the late link supplements the same transition. The trigger condition is only
 * task.status === 'in_progress' (do not transition for blocked/open/done/abandoned; aligned
 * symmetric to claimTask). When ticketId is null (unlink), it does not touch the ticket. With the
 * same idea as markTicketInProgressOnClaim / closeTicketOnMerge (D-B1), it uses a one-way, idempotent
 * local CAS that does not bump the version (WHERE status = 'open'). This way a ticket already
 * in_progress/closed is untouched, and a user's/other agent's concurrent edit of the ticket body is
 * not lost-updated. For atomicity, like the re-arm SQL above, this transition SQL is also written
 * inline in the same transaction (the LinkTaskResult return contract is unchanged).
 */
export function linkTaskToTicket(
  cdb: CoordDb,
  taskId: string,
  ticketId: string | null,
): LinkTaskResult {
  const db = cdb.db;
  const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as
    | { status: string }
    | undefined;
  if (!task) {
    return { ok: false, reason: 'task_not_found', detail: `task '${taskId}' does not exist` };
  }
  if (ticketId !== null) {
    const ticket = db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(ticketId);
    if (!ticket) {
      return {
        ok: false,
        reason: 'ticket_not_found',
        detail: `ticket '${ticketId}' does not exist`,
      };
    }
  }

  const now = unixNow();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE tasks SET ticket_id = ?, updated_at = ? WHERE id = ?').run(
      ticketId,
      now,
      taskId,
    );
    // Re-arm (reverse CAS) only when linking an unfinished task to a ticket that already emitted ready.
    if (ticketId !== null && task.status !== 'done') {
      db.prepare(
        `UPDATE tickets SET ticket_ready_at = NULL, updated_at = ?
          WHERE id = ? AND ticket_ready_at IS NOT NULL`,
      ).run(now, ticketId);
    }
    // 1A: when an already-claimed (in_progress) task is late-linked, auto-transition the parent
    // ticket open→in_progress (symmetric to claimTask). The trigger condition is only
    // task.status === 'in_progress'. A one-way, idempotent local CAS that does not bump the version
    // (WHERE status = 'open'): a ticket already in_progress/closed is untouched.
    if (ticketId !== null && task.status === 'in_progress') {
      db.prepare(
        `UPDATE tickets SET status = 'in_progress', updated_at = ?
          WHERE id = ? AND status = 'open'`,
      ).run(now, ticketId);
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
  return { ok: true };
}
