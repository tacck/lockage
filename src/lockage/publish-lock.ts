import { ulid } from 'ulid';
import { unixNow, type CoordDb } from '../db/index.js';

// Default TTL (seconds) of a publish lock. Assuming lockage-publish's single-ticket processing
// finishes within the TTL, this lets another process steal the lock on TTL expiry even if the
// process crashes and cannot release it. The same "reclaim on expiry" idea as claims' lease_ttl.
// Default 5 minutes.
export const PUBLISH_LOCK_TTL_SEC = 300;

/** Result of acquirePublishLock. Returns a holder token if acquired. */
export type AcquirePublishLockResult = { ok: true; holder: string } | { ok: false };

/**
 * Acquire a per-ticket publish advisory lock (§area 1).
 *
 * Blocks the race where two lockage-publish processes pick up the same ticket's ticket_ready at once
 * and both proceed to publish between read→act. Symmetric with claims' lease/TTL, acquired via a CAS
 * under BEGIN IMMEDIATE:
 *   1. If there is a stale row that expired (expires_at < now), DELETE it (prepare to steal).
 *   2. Run INSERT ... ON CONFLICT(ticket_id) DO NOTHING; changes===0 = a live lock exists = acquire
 *      failed (ok:false), changes>0 = acquire succeeded (ok:true).
 *
 * Since PK=ticket_id, it does not block other tickets (processing of other tickets in the batch can
 * continue). holder is a unique ulid() token, used by releasePublishLock to verify ownership.
 *
 * Modeled on the BEGIN IMMEDIATE/ROLLBACK style of claim.ts's claimTask / handoffTask and the
 * expiry reclamation by expires_at in sweepExpired.
 */
export function acquirePublishLock(
  cdb: CoordDb,
  ticketId: string,
  opts?: { ttlSec?: number; now?: number },
): AcquirePublishLockResult {
  const db = cdb.db;
  const now = opts?.now ?? unixNow();
  const ttlSec = opts?.ttlSec ?? PUBLISH_LOCK_TTL_SEC;
  const holder = ulid();
  const expiresAt = now + ttlSec;

  db.exec('BEGIN IMMEDIATE');
  try {
    // Clean up the expired stale row first (prepare to steal). A live lock is not removed here.
    db.prepare(`DELETE FROM publish_locks WHERE ticket_id = ? AND expires_at < ?`).run(ticketId, now);

    // Run the INSERT as a CAS. If a live lock remains, ON CONFLICT DO NOTHING means no row is
    // inserted and changes===0 (= acquire failed). Any other exception is propagated without folding.
    const info = db
      .prepare(
        `INSERT INTO publish_locks (ticket_id, holder, acquired_at, expires_at, host_id, origin)
         VALUES (?, ?, ?, ?, ?, 'local')
         ON CONFLICT(ticket_id) DO NOTHING`,
      )
      .run(ticketId, holder, now, expiresAt, cdb.hostId);

    if (info.changes === 0) {
      // changes===0 under ON CONFLICT DO NOTHING = a live lock exists = acquire failed.
      db.exec('ROLLBACK');
      return { ok: false };
    }

    db.exec('COMMIT');
    return { ok: true, holder };
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
 * Release a publish advisory lock (§area 1).
 *
 * Conditioning on a holder match, it never wrongly deletes a lock stolen by another process after
 * TTL expiry (= the holder has changed). For a row that is not your holder, the DELETE affects 0
 * rows and nothing happens. Assumed to be called from the finally of publishReadyTickets /
 * reconcileMergedPrs on every path.
 */
export function releasePublishLock(cdb: CoordDb, ticketId: string, holder: string): void {
  cdb.db
    .prepare(`DELETE FROM publish_locks WHERE ticket_id = ? AND holder = ?`)
    .run(ticketId, holder);
}
