import type { DatabaseSync } from 'node:sqlite';
import { unixNow } from '../db/index.js';

/**
 * Creating an agent's board read position (board_cursors), kept apart from board.ts so claim.ts's
 * heartbeat can create it too: board.ts imports claim.ts, so claim.ts cannot import board.ts.
 */

/** An agent's board read position (board_cursors). */
export interface BoardCursor {
  directed_seq: number;
  broadcast_seq: number;
}

/**
 * Read an agent's read position, creating it on first sight. A new agent starts directed at 0 (so a
 * post addressed to it before it started, e.g. a handoff_task to a not-yet-launched worker, is still
 * unread) and broadcast at the current MAX(seq) (so past posts to everyone do not flood in).
 *
 * SELECT first: this runs on every poll of wait_for_unblock, and INSERT OR IGNORE would take the
 * write lock even when the row already exists. INSERT OR IGNORE then keeps concurrent first sights
 * from overwriting each other.
 */
export function ensureBoardCursor(db: DatabaseSync, agentId: string): BoardCursor {
  const select = db.prepare(
    `SELECT directed_seq, broadcast_seq FROM board_cursors WHERE agent_id = ?`,
  );
  let row = select.get(agentId) as BoardCursor | undefined;
  if (!row) {
    db.prepare(
      `INSERT OR IGNORE INTO board_cursors (agent_id, directed_seq, broadcast_seq, updated_at)
       VALUES (?, 0, (SELECT COALESCE(MAX(seq), 0) FROM board_messages), ?)`,
    ).run(agentId, unixNow());
    row = select.get(agentId) as unknown as BoardCursor;
  }
  return { directed_seq: row.directed_seq, broadcast_seq: row.broadcast_seq };
}
