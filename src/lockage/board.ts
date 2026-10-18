import { ulid } from 'ulid';
import { unixNow, type CoordDb } from '../db/index.js';
import { sweepExpired } from './claim.js';

/**
 * §2.4 asynchronous board (board) + §4.8 A2A wake (long-poll).
 *
 * - board_messages: the shared board / directed handoff. Diff-fetched by seq (a monotonically increasing cursor).
 * - wakes: a pending queue for transient resume signals such as overlap (not left on the board).
 * - wait_for_unblock: a long-poll that blocks in a single call until one of "waited task ready /
 *   board addressed to self / overlap / timeout". Removes client-side polling (A2A wake).
 */

export interface BoardMessage {
  id: string;
  seq: number;
  author: string;
  to_agent: string | null;
  kind: 'note' | 'handoff' | 'question' | 'ticket_ready' | 'pr_opened' | 'pr_updated' | 'pr_merged';
  body: string;
  ref_task_id: string | null;
  ref_ticket_id: string | null;
  // Issue #49: a question's resolution state. NULL = unresolved / non-NULL = resolved (at that time).
  // resolved_by is the resolving subject (auto-resolution = the assignee that set the task to done/abandoned; manual = resolve_question's agent_id).
  // postBoard does not explicitly specify both columns in the INSERT, so they enter as the default NULL = unresolved (a new post is always unresolved).
  resolved_at: number | null;
  resolved_by: string | null;
  created_at: number;
  host_id: string;
  origin: string;
}

export interface WakeRow {
  id: string;
  target: string;
  kind: 'overlap' | 'task_ready' | 'board';
  payload: string | null;
  created_at: number;
  consumed_at: number | null;
  host_id: string;
  origin: string;
}

export interface PostBoardArgs {
  agentId: string;
  kind?: 'note' | 'handoff' | 'question' | 'ticket_ready' | 'pr_opened' | 'pr_updated' | 'pr_merged';
  body: string;
  toAgent?: string | null;
  refTaskId?: string | null;
  refTicketId?: string | null;
}

/**
 * §2.4 post_board — post to the shared board. Specifying to_agent makes it a directed handoff.
 * seq is assigned as MAX+1 within BEGIN IMMEDIATE (the discipline shared by board and merge_queue).
 * handoff/question wake the target agent via wait_for_unblock's board path.
 */
export function postBoard(cdb: CoordDb, args: PostBoardArgs): { message_id: string } {
  const db = cdb.db;
  const now = unixNow();
  const id = ulid();
  const kind = args.kind ?? 'note';

  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM board_messages`)
      .get() as { next: number };
    db.prepare(
      `INSERT INTO board_messages
         (id, seq, author, to_agent, kind, body, ref_task_id, ref_ticket_id, created_at, host_id, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')`,
    ).run(
      id,
      row.next,
      args.agentId,
      args.toAgent ?? null,
      kind,
      args.body,
      args.refTaskId ?? null,
      args.refTicketId ?? null,
      now,
      cdb.hostId,
    );
    db.exec('COMMIT');
    return { message_id: id };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already closed */
    }
    throw e;
  }
}

/** The return of resolveQuestion. Aligned with the existing tools' `{ ok: ... }` / `{ ok:false, reason }` convention. */
export type ResolveQuestionResult =
  | { ok: true; already_resolved: boolean }
  | { ok: false; reason: 'not_found' | 'not_question' };

/**
 * Issue #49 manual resolution (complement, option A) — resolve_question.
 * Mark a question resolved. As a complement to auto-resolution (when a task reaches done/abandoned,
 * auto-resolve the unresolved questions that have that task as ref_task_id), a path to explicitly
 * close a question with no ref_task_id, or a question a human wants to close with just an answer
 * without resuming the task.
 *
 * Within BEGIN IMMEDIATE, check the target row and:
 *   - a nonexistent message_id         → { ok:false, reason:'not_found' }
 *   - kind !== 'question'              → { ok:false, reason:'not_question' }
 *   - already resolved_at IS NOT NULL  → no-op, { ok:true, already_resolved:true } (idempotent)
 *   - otherwise                        → UPDATE resolved_at=unixNow(), resolved_by=agentId and
 *                                        { ok:true, already_resolved:false }
 * Aligned with the same try/catch + ROLLBACK pattern as postBoard / takePendingWakes.
 */
export function resolveQuestion(
  cdb: CoordDb,
  args: { agentId: string; messageId: string },
): ResolveQuestionResult {
  const db = cdb.db;
  const now = unixNow();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare(`SELECT kind, resolved_at FROM board_messages WHERE id = ?`)
      .get(args.messageId) as { kind: string; resolved_at: number | null } | undefined;
    if (!row) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    if (row.kind !== 'question') {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'not_question' };
    }
    if (row.resolved_at !== null) {
      // Idempotent: if already resolved, do nothing and return success.
      db.exec('COMMIT');
      return { ok: true, already_resolved: true };
    }
    db.prepare(
      `UPDATE board_messages SET resolved_at = ?, resolved_by = ? WHERE id = ?`,
    ).run(now, args.agentId, args.messageId);
    db.exec('COMMIT');
    return { ok: true, already_resolved: false };
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
 * Issue #49 auto-resolution (main path) — when a task drops to done or abandoned, mark the
 * unresolved questions (resolved_at IS NULL) that have that task as ref_task_id resolved, together.
 *
 * Only unresolved ones are targeted, so it is idempotent (even if called twice, already-resolved rows
 * are filtered out by WHERE and it is a no-op). A single UPDATE, so no BEGIN IMMEDIATE here (to not
 * nest if the caller invokes it within its own transaction; the current callers finalizeMergedTask /
 * releaseTask invoke it outside a transaction).
 *
 * The basis for resolvedBy: the done path is the assignee that confirmed completion (finalizeMergedTask's `by`),
 * the abandoned path is the releasing subject (releaseTask's agentId). Both represent "the subject that answered and closed the task".
 *
 * @returns resolved = the number of questions resolved this time (for the caller's logs).
 */
export function resolveQuestionsForTask(
  cdb: CoordDb,
  args: { taskId: string; resolvedBy: string },
): { resolved: number } {
  const info = cdb.db
    .prepare(
      `UPDATE board_messages
          SET resolved_at = ?, resolved_by = ?
        WHERE ref_task_id = ? AND kind = 'question' AND resolved_at IS NULL`,
    )
    .run(unixNow(), args.resolvedBy, args.taskId);
  return { resolved: Number(info.changes) };
}

/**
 * §2.4 read_board — read the board. Diff-fetched by since (seq cursor).
 * When to_agent is specified, return "addressed to self (to_agent) + addressed to everyone (NULL)".
 */
export function readBoard(
  cdb: CoordDb,
  args: {
    since?: number;
    toAgent?: string;
    kind?: BoardMessage['kind'];
    limit?: number;
    unresolvedOnly?: boolean;
  } = {},
): { messages: BoardMessage[] } {
  const since = args.since ?? 0;
  const limit = args.limit ?? 100;
  const clauses: string[] = ['seq > ?'];
  const params: unknown[] = [since];
  if (args.toAgent) {
    clauses.push('(to_agent = ? OR to_agent IS NULL)');
    params.push(args.toAgent);
  }
  if (args.kind) {
    clauses.push('kind = ?');
    params.push(args.kind);
  }
  // Issue #49: unresolved only (resolved_at IS NULL). Kinds other than question always keep
  // resolved_at NULL, so this condition effectively becomes "unresolved questions + all non-questions" (harmless). Not added to params.
  if (args.unresolvedOnly) {
    clauses.push('resolved_at IS NULL');
  }
  const rows = cdb.db
    .prepare(
      `SELECT * FROM board_messages WHERE ${clauses.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
    )
    .all(...(params as never[]), limit) as unknown as BoardMessage[];
  return { messages: rows };
}

/**
 * The read-all limit for the board. The board is a cumulative log whose rows remain even after
 * ticket_ready / pr_opened / pr_merged are reconciled, so this is the limit for both the publisher's
 * observation (computePublisherStatus) and execution (publishReadyTickets / reconcileMergedPrs) paths
 * to read "the same reference range = all, up to a realistic count ceiling". This prevents the latest
 * ticket_ready from spilling out of the default limit=100 (seq ascending = the oldest 100) window.
 * On a Phase 1 single host, 1 million is enough (another operational measure kicks in before board
 * rows pile up this far). Since-cursor paging is not adopted: the board has no concept of a
 * reconciliation cursor, and adopting it would require changing the reconciliation model itself. That
 * is excessive for Phase 1, so align to the simple read-all approach.
 */
export const BOARD_READ_ALL_LIMIT = 1_000_000;

/** One entry of publisher_status: display info for an unprocessed (awaiting PR) ticket. */
export interface PendingTicket {
  /** The id of the ticket ticket_ready points at (board_messages.ref_ticket_id). */
  ref_ticket_id: string;
  /** The ticket's integration branch name (the publisher pushes it). Supplemented from the ticket. null if not generated/absent. */
  integration_branch: string | null;
}

/** The observed publisher state returned by publisher_status. */
export interface PublisherStatus {
  /**
   * The list of tickets purely awaiting a PR (= ticket_ready was emitted but there is no
   * corresponding pr_opened at all). For backward compatibility this field keeps its original meaning
   * of "tickets with no pr_opened" only.
   */
  pending_tickets: PendingTicket[];
  /** pending_tickets.length. The count purely awaiting a PR. */
  pending_count: number;
  /**
   * The list of tickets awaiting an update (= already pr_opened, but a newer ticket_ready was stacked
   * later and it has not been follow-up pushed yet). After re-arming, a "follow-up push wait" where
   * ticket_ready is stacked "after the latest pr_opened / pr_updated (larger seq)" qualifies. When the
   * follow-up push succeeds, the publisher leaves pr_updated on the board, whose seq exceeds
   * ticket_ready and drops it from this list (= a finished ticket does not linger in observation).
   * Computed by the same seq comparison that publishReadyTickets uses to decide an existing PR should
   * be follow-up pushed. Already pr_merged (after a merge there is no integration branch and a
   * follow-up push is impossible) and closed tickets are excluded.
   */
  pending_update_tickets: PendingTicket[];
  /** pending_update_tickets.length. The count awaiting a follow-up push (awaiting an existing PR's update). */
  pending_update_count: number;
  /**
   * The list of tickets awaiting a merge (= already pr_opened but no corresponding pr_merged yet).
   * A "cleanup wait" where the PR was created but not yet merged/reconciled on GitHub qualifies.
   * Without changing pending_count's (purely awaiting a PR) meaning, this surfaces "PR created,
   * awaiting merge" as a separate axis. When this is >0, the agent runs
   * `lockage-publish --mode reconcile` to reclaim merged PRs.
   *
   * ⚠️ The 3 axes (pending / pending_update / awaiting_merge) are not mutually exclusive. They are
   * observation "separate axes", not a partition of tickets, so simply summing counts like
   * `pending_count + pending_update_count + awaiting_merge_count` double-counts (it is not the unique
   * ticket count). The relationship of each axis's population:
   *   - pending        : no pr_opened at all → mutually exclusive with awaiting_merge (has pr_opened).
   *   - pending_update : has pr_opened ∧ a subsequent ticket_ready was stacked (awaiting a follow-up push).
   *   - awaiting_merge : has pr_opened ∧ no pr_merged yet (awaiting merge/cleanup).
   * pending_update and awaiting_merge have overlapping populations, and the same ticket can appear in
   * both at once (a ticket already pr_opened, with a subsequent ticket_ready, and unmerged). Use each axis independently for decisions.
   */
  awaiting_merge_tickets: PendingTicket[];
  /** awaiting_merge_tickets.length. The count awaiting a merge (pr_opened ∧ ¬pr_merged). Not mutually exclusive with pending/pending_update (see the note above). */
  awaiting_merge_count: number;
  /** The latest created_at (unix sec) of pr_opened. null if there is none. */
  last_pr_opened_at: number | null;
  /** The latest created_at (unix sec) of pr_merged. null if there is none. */
  last_pr_merged_at: number | null;
}

/**
 * Fix proposal B (F1 / F3) — observe the publisher's liveness, last-run traces, and unprocessed
 * ticket_ready from the board. Does not start publish (observation only).
 *
 * A pure function computed only from board_messages (kind=ticket_ready / pr_opened / pr_merged), with no
 * side effects (read only). Adds no new table.
 *
 * What it computes:
 *   (1) pending_tickets = the set of tickets that have a ticket_ready but no pr_opened for the same
 *       ref_ticket_id ever (= purely waiting to become a PR). Each ticket is bundled with
 *       integration_branch filled in from the ticket table (this is a core DB read, not starting publish).
 *   (2) pending_update_tickets = the set of tickets that already have pr_opened but a newer ticket_ready
 *       was stacked afterward and has not yet been follow-up pushed (= latest ticket_ready seq > max(latest
 *       pr_opened, latest pr_updated) seq) (= waiting for a follow-up push / waiting to update an existing
 *       PR). When a follow-up push succeeds the publisher leaves a pr_updated, so its seq exceeds
 *       ticket_ready and it drops from this set thereafter (completed tickets do not keep showing up in
 *       observation). Computed with the same seq comparison publishReadyTickets uses to decide an existing
 *       PR should be updated by a follow-up push, closing the observation blind spot where it looks like 0
 *       unprocessed just because pr_opened exists. Note that already-pr_merged (after merge there is no
 *       integration branch and no follow-up push is possible) and already-closed tickets are excluded from
 *       this set (like awaiting_merge, do not keep "finished work" waiting for an update).
 *   (3) awaiting_merge_tickets = the set of tickets that already have pr_opened but no pr_merged yet (=
 *       waiting for merge / cleanup). (1)(2)(3) are different observation axes and not exclusive: a simple
 *       sum of counts double-counts (see the note on PublisherStatus's awaiting_merge_tickets). In
 *       particular (2) and (3) have overlapping populations and the same ticket can appear in both.
 *   (4) last_pr_opened_at / last_pr_merged_at = the latest created_at of pr_opened / pr_merged (null if none).
 *   (5) pending_count = pending_tickets.length / pending_update_count = pending_update_tickets.length /
 *       awaiting_merge_count = awaiting_merge_tickets.length.
 */
export function computePublisherStatus(cdb: CoordDb): PublisherStatus {
  // Read all rows from the board by kind (BOARD_READ_ALL_LIMIT picks up everything unprocessed).
  const ticketReady = readBoard(cdb, { kind: 'ticket_ready', limit: BOARD_READ_ALL_LIMIT }).messages;
  const prOpened = readBoard(cdb, { kind: 'pr_opened', limit: BOARD_READ_ALL_LIMIT }).messages;
  const prUpdated = readBoard(cdb, { kind: 'pr_updated', limit: BOARD_READ_ALL_LIMIT }).messages;
  const prMerged = readBoard(cdb, { kind: 'pr_merged', limit: BOARD_READ_ALL_LIMIT }).messages;

  // The set of tickets cleared by pr_opened (only those that carry a ref_ticket_id).
  const openedTicketIds = new Set<string>();
  for (const m of prOpened) {
    if (m.ref_ticket_id) openedTicketIds.add(m.ref_ticket_id);
  }
  // The set of already-pr_merged tickets (= cleanup complete. drop from waiting-for-merge).
  const mergedTicketIds = new Set<string>();
  for (const m of prMerged) {
    if (m.ref_ticket_id) mergedTicketIds.add(m.ref_ticket_id);
  }

  // The latest seq per ticket (ticket_ready / pr_opened / pr_updated). Kept to decide, with the same seq
  // comparison idea as publishReadyTickets, "a ticket_ready re-emitted after max(pr_opened, pr_updated) (=
  // waiting for a follow-up push)". When a follow-up push succeeds the pr_updated seq rises, so completed
  // tickets drop from this decision.
  const latestReadySeq = latestSeqByTicket(ticketReady);
  const latestOpenedSeq = latestSeqByTicket(prOpened);
  const latestUpdatedSeq = latestSeqByTicket(prUpdated);
  // The per-ticket "seq last reflected into the PR" = max(latest pr_opened, latest pr_updated).
  const latestPrSeq = (id: string): number =>
    Math.max(latestOpenedSeq.get(id) ?? 0, latestUpdatedSeq.get(id) ?? 0);

  // The set of closed tickets (closed by reconcile after merge. drop from waiting-for-update).
  const closedTicketIds = new Set<string>();
  for (const r of cdb.db
    .prepare(`SELECT id FROM tickets WHERE status = 'closed'`)
    .all() as Array<{ id: string }>) {
    closedTicketIds.add(r.id);
  }

  // Tickets that have a ticket_ready but were never cleared by pr_opened (= purely waiting to become a PR; dedup).
  const pendingIds: string[] = [];
  // Tickets that already have pr_opened but a newer ticket_ready was stacked afterward (= waiting for a follow-up push; dedup).
  const pendingUpdateIds: string[] = [];
  const seen = new Set<string>();
  for (const m of ticketReady) {
    const id = m.ref_ticket_id;
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!openedTicketIds.has(id)) {
      pendingIds.push(id); // never pr_opened = purely waiting to become a PR
    } else if (
      // already-pr_merged / closed is "finished work" = no follow-up push possible (no integration branch), so exclude.
      !mergedTicketIds.has(id) &&
      !closedTicketIds.has(id) &&
      (latestReadySeq.get(id) ?? 0) > latestPrSeq(id)
    ) {
      // ticket_ready after max(pr_opened, pr_updated) = waiting for an update not yet follow-up pushed.
      pendingUpdateIds.push(id);
    }
  }

  // Waiting for merge (= tickets that already have pr_opened but no pr_merged; dedup).
  // An axis independent of pending/pending_update. The PR was created but not yet merged/reconciled ("waiting for cleanup").
  const awaitingMergeIds: string[] = [];
  const awaitingSeen = new Set<string>();
  for (const m of prOpened) {
    const id = m.ref_ticket_id;
    if (!id) continue;
    if (awaitingSeen.has(id)) continue;
    awaitingSeen.add(id);
    if (!mergedTicketIds.has(id)) awaitingMergeIds.push(id); // pr_opened ∧ ¬pr_merged
  }

  // Fill in integration_branch from the ticket table (not obtainable from the board alone).
  const toPendingTickets = (ids: string[]): PendingTicket[] =>
    ids.map((id) => {
      const row = cdb.db
        .prepare('SELECT integration_branch FROM tickets WHERE id = ?')
        .get(id) as { integration_branch: string | null } | undefined;
      return { ref_ticket_id: id, integration_branch: row?.integration_branch ?? null };
    });
  const pending_tickets = toPendingTickets(pendingIds);
  const pending_update_tickets = toPendingTickets(pendingUpdateIds);
  const awaiting_merge_tickets = toPendingTickets(awaitingMergeIds);

  // The latest created_at of each kind (readBoard is seq ascending, so the last element is the newest).
  const lastCreatedAt = (msgs: BoardMessage[]): number | null =>
    msgs.length > 0 ? msgs[msgs.length - 1].created_at : null;

  return {
    pending_tickets,
    pending_count: pending_tickets.length,
    pending_update_tickets,
    pending_update_count: pending_update_tickets.length,
    awaiting_merge_tickets,
    awaiting_merge_count: awaiting_merge_tickets.length,
    last_pr_opened_at: lastCreatedAt(prOpened),
    last_pr_merged_at: lastCreatedAt(prMerged),
  };
}

/**
 * Collect the latest seq per ticket from a set of board messages (used by publisher_status's seq comparison).
 * Same idea as publish.ts's same-named helper, but kept self-contained here because board is used by multiple modules.
 */
function latestSeqByTicket(messages: BoardMessage[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const msg of messages) {
    if (!msg.ref_ticket_id) continue;
    const prev = m.get(msg.ref_ticket_id) ?? 0;
    if (msg.seq > prev) m.set(msg.ref_ticket_id, msg.seq);
  }
  return m;
}

/** The current maximum seq of the board (the initial cursor value for wait_for_unblock). */
export function currentMaxBoardSeq(cdb: CoordDb): number {
  const row = cdb.db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM board_messages`)
    .get() as { m: number };
  return row.m;
}

/**
 * Kinds that never wake an agent nor count as unread. They are records for publisher_status /
 * lockage-publish, not messages to an agent; read_board still returns them as before.
 */
export const SYSTEM_BOARD_KINDS: ReadonlyArray<BoardMessage['kind']> = [
  'ticket_ready',
  'pr_opened',
  'pr_updated',
  'pr_merged',
];

/** An agent's board read position (board_cursors). */
export interface BoardCursor {
  directed_seq: number;
  broadcast_seq: number;
}

/**
 * Read an agent's read position, creating it on first sight. A new agent starts directed at 0 (so a
 * post addressed to it before it started, e.g. a handoff_task to a not-yet-launched worker, is still
 * unread) and broadcast at the current MAX(seq) (so past posts to everyone do not flood in).
 * INSERT OR IGNORE keeps concurrent first sights from overwriting each other.
 */
export function getBoardCursor(cdb: CoordDb, agentId: string): BoardCursor {
  cdb.db
    .prepare(
      `INSERT OR IGNORE INTO board_cursors (agent_id, directed_seq, broadcast_seq, updated_at)
       VALUES (?, 0, (SELECT COALESCE(MAX(seq), 0) FROM board_messages), ?)`,
    )
    .run(agentId, unixNow());
  const row = cdb.db
    .prepare(`SELECT directed_seq, broadcast_seq FROM board_cursors WHERE agent_id = ?`)
    .get(agentId) as unknown as BoardCursor;
  return { directed_seq: row.directed_seq, broadcast_seq: row.broadcast_seq };
}

/** The WHERE clause and params shared by listUnread / countUnread. */
function unreadWhere(cursor: BoardCursor, agentId: string): { sql: string; params: unknown[] } {
  const kinds = SYSTEM_BOARD_KINDS.map(() => '?').join(', ');
  return {
    sql: `((to_agent = ? AND seq > ?) OR (to_agent IS NULL AND seq > ?))
          AND author != ? AND kind NOT IN (${kinds})`,
    params: [agentId, cursor.directed_seq, cursor.broadcast_seq, agentId, ...SYSTEM_BOARD_KINDS],
  };
}

/** An agent's unread posts in seq ascending order (does not advance the read position). */
export function listUnread(
  cdb: CoordDb,
  agentId: string,
  opts: { limit?: number } = {},
): BoardMessage[] {
  const w = unreadWhere(getBoardCursor(cdb, agentId), agentId);
  return cdb.db
    .prepare(`SELECT * FROM board_messages WHERE ${w.sql} ORDER BY seq ASC LIMIT ?`)
    .all(...(w.params as never[]), opts.limit ?? BOARD_READ_ALL_LIMIT) as unknown as BoardMessage[];
}

/** The number of an agent's unread posts (does not advance the read position). */
export function countUnread(cdb: CoordDb, agentId: string): number {
  const w = unreadWhere(getBoardCursor(cdb, agentId), agentId);
  const row = cdb.db
    .prepare(`SELECT COUNT(*) AS n FROM board_messages WHERE ${w.sql}`)
    .get(...(w.params as never[])) as { n: number };
  return row.n;
}

/** One line of heartbeat's unread_preview: enough to judge whether to read now. */
export interface UnreadPreview {
  seq: number;
  author: string;
  kind: BoardMessage['kind'];
  body_head: string;
  ref_task_id: string | null;
}

/** How much of the body unread_preview shows. */
const PREVIEW_BODY_CHARS = 80;

/**
 * The newest `n` unread posts (seq ascending) as short previews, for heartbeat. Does not advance the
 * read position: the agent reads the posts themselves with read_board(unread_only).
 */
export function previewUnread(cdb: CoordDb, agentId: string, n = 3): UnreadPreview[] {
  const w = unreadWhere(getBoardCursor(cdb, agentId), agentId);
  const rows = cdb.db
    .prepare(`SELECT * FROM board_messages WHERE ${w.sql} ORDER BY seq DESC LIMIT ?`)
    .all(...(w.params as never[]), n) as unknown as BoardMessage[];
  return rows.reverse().map((m) => ({
    seq: m.seq,
    author: m.author,
    kind: m.kind,
    body_head:
      m.body.length > PREVIEW_BODY_CHARS ? `${m.body.slice(0, PREVIEW_BODY_CHARS)}…` : m.body,
    ref_task_id: m.ref_task_id,
  }));
}

/** read_board(unread_only): return the agent's unread posts and mark them read. */
export function readUnread(
  cdb: CoordDb,
  agentId: string,
  opts: { limit?: number } = {},
): { messages: BoardMessage[] } {
  const messages = listUnread(cdb, agentId, { limit: opts.limit ?? 100 });
  markBoardRead(cdb, agentId, messages);
  return { messages };
}

/**
 * Advance an agent's read position past the posts just returned to it, separately for directed and
 * broadcast. Only moves forward (MAX), so a stale caller cannot move it back. Posts not addressed to
 * the agent are ignored.
 */
export function markBoardRead(cdb: CoordDb, agentId: string, messages: BoardMessage[]): void {
  let directed = 0;
  let broadcast = 0;
  for (const m of messages) {
    if (m.to_agent === agentId) directed = Math.max(directed, m.seq);
    else if (m.to_agent === null) broadcast = Math.max(broadcast, m.seq);
  }
  if (directed === 0 && broadcast === 0) return;
  getBoardCursor(cdb, agentId);
  const db = cdb.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `UPDATE board_cursors
          SET directed_seq = MAX(directed_seq, ?), broadcast_seq = MAX(broadcast_seq, ?), updated_at = ?
        WHERE agent_id = ?`,
    ).run(directed, broadcast, unixNow(), agentId);
    db.exec('COMMIT');
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
 * §4.8 wake — push a transient resume signal onto the pending queue.
 * Used for notifications we do not want to leave on the board, such as overlap (someone else steps into my area).
 * Called from publishDirty / the merge gate's needs_review, connecting the existing wake_targets enumeration to real delivery.
 */
export function wake(
  cdb: CoordDb,
  target: string,
  kind: WakeRow['kind'],
  payload?: Record<string, unknown>,
): void {
  cdb.db
    .prepare(
      `INSERT INTO wakes (id, target, kind, payload, created_at, consumed_at, host_id, origin)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 'local')`,
    )
    .run(
      ulid(),
      target,
      kind,
      payload ? JSON.stringify(payload) : null,
      unixNow(),
      cdb.hostId,
    );
}

/**
 * §4.8 take_pending_wakes — read pending wakes and mark them consumed (consume them).
 * BEGIN IMMEDIATE serializes "read and immediately mark consumed" so the same wake is not consumed twice.
 */
export function takePendingWakes(
  cdb: CoordDb,
  target: string,
  kind: WakeRow['kind'],
): WakeRow[] {
  const db = cdb.db;
  const now = unixNow();
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db
      .prepare(
        `SELECT * FROM wakes WHERE target = ? AND kind = ? AND consumed_at IS NULL ORDER BY created_at ASC`,
      )
      .all(target, kind) as unknown as WakeRow[];
    if (rows.length > 0) {
      db.prepare(
        `UPDATE wakes SET consumed_at = ? WHERE target = ? AND kind = ? AND consumed_at IS NULL`,
      ).run(now, target, kind);
    }
    db.exec('COMMIT');
    return rows;
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
 * §4.8 is_ready — walk task_edges (blocks) and decide whether "every from_task that blocks me is done".
 * ready if there are no block edges.
 */
export function isReady(cdb: CoordDb, taskId: string): boolean {
  const blockers = cdb.db
    .prepare(
      `SELECT t.status AS status
         FROM task_edges e JOIN tasks t ON t.id = e.from_task
        WHERE e.to_task = ? AND e.kind = 'blocks'`,
    )
    .all(taskId) as unknown as Array<{ status: string }>;
  return blockers.every((b) => b.status === 'done');
}

export type WokeBy = 'task_ready' | 'board' | 'overlap' | 'timeout';
export interface UnblockResult {
  woke_by: WokeBy;
  payload?: unknown;
}

/** The most unread posts one wait_for_unblock returns; the rest wake the next call. */
const WAIT_BOARD_LIMIT = 100;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * §4.8 wait_for_unblock — long-poll. In a single call, block until the event that should wake it occurs.
 * Internally it short-interval polls (sufficient for Phase 1 / a single process). Client-side polling disappears.
 *
 *   a) the waited task became ready (all deps done) → woke_by:"task_ready"
 *   b) an unread board message for me or for everyone (from my read position in board_cursors, so a
 *      post that arrived while I was not waiting still counts) → woke_by:"board", and the read
 *      position advances past the returned posts. System kinds and my own posts do not wake.
 *   c) overlap in my area (someone else's dirty/claim overlaps) → woke_by:"overlap"
 *   d) timeout → woke_by:"timeout"
 *
 * @param pollMs internal polling interval (shortenable in tests; defaults to 500ms).
 */
export async function waitForUnblock(
  cdb: CoordDb,
  args: { agentId: string; taskId?: string; timeoutSec?: number; pollMs?: number },
): Promise<UnblockResult> {
  const timeoutSec = args.timeoutSec ?? 60;
  const pollMs = args.pollMs ?? 500;
  const deadline = Date.now() + timeoutSec * 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    sweepExpired(cdb);

    // a) did the waited task become ready (evaluated each time)? Or consume a task_ready wake if stacked
    //    (finalizeMergedTask stacks it on unblock. insurance against missing an event that occurred before the long-poll started).
    if (args.taskId && isReady(cdb, args.taskId)) {
      const task = cdb.db
        .prepare(`SELECT * FROM tasks WHERE id = ?`)
        .get(args.taskId);
      return { woke_by: 'task_ready', payload: task };
    }
    const readyWakes = takePendingWakes(cdb, args.agentId, 'task_ready');
    if (readyWakes.length > 0) {
      return {
        woke_by: 'task_ready',
        payload: readyWakes.map((w) => (w.payload ? JSON.parse(w.payload) : null)),
      };
    }

    // b) unread board messages for me / for everyone, counted from my stored read position.
    //    Returned posts are marked read so the next wait does not return them again. Board wakes are
    //    no longer stacked (handoff / needs_review rely on the post itself), but a DB from before may
    //    still hold some: drain them here so the same notification does not wake twice, and still
    //    honor them below when there is no unread post.
    const unread = listUnread(cdb, args.agentId, { limit: WAIT_BOARD_LIMIT });
    if (unread.length > 0) {
      markBoardRead(cdb, args.agentId, unread);
      takePendingWakes(cdb, args.agentId, 'board');
      return { woke_by: 'board', payload: unread };
    }
    const boardWakes = takePendingWakes(cdb, args.agentId, 'board');
    if (boardWakes.length > 0) {
      return {
        woke_by: 'board',
        payload: boardWakes.map((w) => (w.payload ? JSON.parse(w.payload) : null)),
      };
    }

    // c) overlap in my area (consume the pending wake)
    const pending = takePendingWakes(cdb, args.agentId, 'overlap');
    if (pending.length > 0) {
      return {
        woke_by: 'overlap',
        payload: pending.map((w) => (w.payload ? JSON.parse(w.payload) : null)),
      };
    }

    if (Date.now() >= deadline) return { woke_by: 'timeout' };
    await sleep(pollMs);
  }
}
