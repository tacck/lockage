import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, migrateBoardCursors, unixNow, type CoordDb } from '../src/db/index.js';
import { createTask, claimTask, releaseTask, heartbeat } from '../src/lockage/claim.js';
import {
  postBoard,
  readBoard,
  resolveQuestion,
  resolveQuestionsForTask,
  currentMaxBoardSeq,
  wake,
  takePendingWakes,
  isReady,
  waitForUnblock,
  getBoardCursor,
  listUnread,
  countUnread,
  summarizeUnread,
  readUnread,
  consumeUnread,
  UNREAD_RETURN_LIMIT,
  type BoardMessage,
} from '../src/lockage/board.js';
import { publishDirty, claimFiles } from '../src/lockage/files.js';

let cdb: CoordDb;

beforeEach(() => {
  cdb = openDb({ path: ':memory:', hostId: 'host-test' });
});
afterEach(() => {
  cdb?.close();
});

// ---- board ----

test('post_board/read_board: seq ascending, fetch deltas with the since cursor', () => {
  postBoard(cdb, { agentId: 'A', body: 'm1' });
  postBoard(cdb, { agentId: 'A', body: 'm2' });
  const all = readBoard(cdb);
  assert.equal(all.messages.length, 2);
  assert.equal(all.messages[0]?.seq, 1);
  assert.equal(all.messages[1]?.seq, 2);
  // since=1 returns only m2
  const diff = readBoard(cdb, { since: 1 });
  assert.equal(diff.messages.length, 1);
  assert.equal(diff.messages[0]?.body, 'm2');
});

test('read_board: specifying to_agent returns messages for me + for everyone (NULL)', () => {
  postBoard(cdb, { agentId: 'A', body: 'to-B', toAgent: 'B', kind: 'handoff' });
  postBoard(cdb, { agentId: 'A', body: 'to-C', toAgent: 'C' });
  postBoard(cdb, { agentId: 'A', body: 'broadcast' }); // to_agent NULL
  const forB = readBoard(cdb, { toAgent: 'B' });
  const bodies = forB.messages.map((m) => m.body).sort();
  assert.deepEqual(bodies, ['broadcast', 'to-B']);
});

test('post_board: seq is MAX+1, monotonically increasing, UNIQUE', () => {
  postBoard(cdb, { agentId: 'A', body: 'x' });
  const before = currentMaxBoardSeq(cdb);
  postBoard(cdb, { agentId: 'A', body: 'y' });
  assert.equal(currentMaxBoardSeq(cdb), before + 1);
});

// ---- Issue #49: question resolution ----

test('resolve_question: resolving a question sets resolved_at/resolved_by', () => {
  const { message_id } = postBoard(cdb, { agentId: 'A', body: 'q', kind: 'question' });
  const r = resolveQuestion(cdb, { agentId: 'B', messageId: message_id });
  assert.deepEqual(r, { ok: true, already_resolved: false });
  const row = cdb.db
    .prepare('SELECT resolved_at, resolved_by FROM board_messages WHERE id = ?')
    .get(message_id) as { resolved_at: number | null; resolved_by: string | null };
  assert.notEqual(row.resolved_at, null);
  assert.equal(row.resolved_by, 'B');
});

test('resolve_question: the second time is a no-op with already_resolved:true (idempotent)', () => {
  const { message_id } = postBoard(cdb, { agentId: 'A', body: 'q', kind: 'question' });
  const first = resolveQuestion(cdb, { agentId: 'B', messageId: message_id });
  assert.equal(first.ok, true);
  const before = cdb.db
    .prepare('SELECT resolved_by FROM board_messages WHERE id = ?')
    .get(message_id) as { resolved_by: string | null };
  // the second time does not overwrite resolved_by even for a different agent (no-op).
  const second = resolveQuestion(cdb, { agentId: 'C', messageId: message_id });
  assert.deepEqual(second, { ok: true, already_resolved: true });
  const after = cdb.db
    .prepare('SELECT resolved_by FROM board_messages WHERE id = ?')
    .get(message_id) as { resolved_by: string | null };
  assert.equal(after.resolved_by, before.resolved_by);
});

test('resolve_question: a message_id whose kind is not question is not_question', () => {
  const { message_id } = postBoard(cdb, { agentId: 'A', body: 'note', kind: 'note' });
  const r = resolveQuestion(cdb, { agentId: 'B', messageId: message_id });
  assert.deepEqual(r, { ok: false, reason: 'not_question' });
});

test('resolve_question: a non-existent message_id is not_found', () => {
  const r = resolveQuestion(cdb, { agentId: 'B', messageId: 'nope' });
  assert.deepEqual(r, { ok: false, reason: 'not_found' });
});

test('read_board: unresolved_only=true excludes resolved questions', () => {
  const q1 = postBoard(cdb, { agentId: 'A', body: 'q1', kind: 'question' });
  postBoard(cdb, { agentId: 'A', body: 'q2', kind: 'question' });
  resolveQuestion(cdb, { agentId: 'B', messageId: q1.message_id });
  const unresolved = readBoard(cdb, { unresolvedOnly: true });
  const bodies = unresolved.messages.map((m) => m.body).sort();
  assert.deepEqual(bodies, ['q2']);
  // without the filter both are returned.
  assert.equal(readBoard(cdb).messages.length, 2);
});

test('read_board: even with unresolved_only=true, non-questions always remain (resolved_at stays NULL)', () => {
  postBoard(cdb, { agentId: 'A', body: 'note', kind: 'note' });
  const unresolved = readBoard(cdb, { unresolvedOnly: true });
  assert.equal(unresolved.messages.length, 1);
  assert.equal(unresolved.messages[0]?.body, 'note');
});

test('auto-resolution (abandoned path): release_task(abandoned) resolves the linked unresolved question', () => {
  const t = createTask(cdb, { repo: 'r', title: 't' });
  const c = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(c.ok, true);
  const q = postBoard(cdb, { agentId: 'A', body: 'got stuck', kind: 'question', refTaskId: t.id });
  const rel = releaseTask(cdb, t.id, 'A', 'abandoned');
  assert.equal(rel.ok, true);
  const row = cdb.db
    .prepare('SELECT resolved_at, resolved_by FROM board_messages WHERE id = ?')
    .get(q.message_id) as { resolved_at: number | null; resolved_by: string | null };
  assert.notEqual(row.resolved_at, null);
  assert.equal(row.resolved_by, 'A'); // the one who released
});

test('auto-resolution (open return): release_task(open) leaves the question unresolved', () => {
  const t = createTask(cdb, { repo: 'r', title: 't' });
  claimTask(cdb, t.id, 'A', t.version);
  const q = postBoard(cdb, { agentId: 'A', body: 'got stuck', kind: 'question', refTaskId: t.id });
  const rel = releaseTask(cdb, t.id, 'A', 'open'); // an open return does not resolve because the task is not complete
  assert.equal(rel.ok, true);
  const row = cdb.db
    .prepare('SELECT resolved_at FROM board_messages WHERE id = ?')
    .get(q.message_id) as { resolved_at: number | null };
  assert.equal(row.resolved_at, null);
});

test('resolveQuestionsForTask: the done-confirmation-point helper resolves only unresolved questions and returns the count (idempotent)', () => {
  const t = createTask(cdb, { repo: 'r', title: 't' });
  postBoard(cdb, { agentId: 'A', body: 'q1', kind: 'question', refTaskId: t.id });
  postBoard(cdb, { agentId: 'A', body: 'q2', kind: 'question', refTaskId: t.id });
  // note is not a target.
  postBoard(cdb, { agentId: 'A', body: 'note', kind: 'note', refTaskId: t.id });
  const first = resolveQuestionsForTask(cdb, { taskId: t.id, resolvedBy: 'A' });
  assert.equal(first.resolved, 2);
  // the second time there is nothing unresolved so 0 (idempotent = double resolution is a no-op).
  const second = resolveQuestionsForTask(cdb, { taskId: t.id, resolvedBy: 'A' });
  assert.equal(second.resolved, 0);
});

// ---- Issue #49: migration (adding new columns to an old-schema DB) ----

test('migrate: adds the new columns to an old-schema (with CHECK, without resolved_*) board_messages, and an existing question reads as unresolved', () => {
  const db = cdb.db;
  // reproduce the old schema: drop the current table and recreate it with a definition that has no
  // resolved_at/resolved_by and has the old kind CHECK.
  db.exec('DROP TABLE board_messages');
  db.exec(`
    CREATE TABLE board_messages (
      id           TEXT PRIMARY KEY,
      seq          INTEGER NOT NULL,
      author       TEXT NOT NULL,
      to_agent     TEXT,
      kind         TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','handoff','question')),
      body         TEXT NOT NULL,
      ref_task_id  TEXT,
      ref_ticket_id TEXT,
      created_at   INTEGER NOT NULL,
      host_id      TEXT NOT NULL,
      origin       TEXT NOT NULL DEFAULT 'local'
    );
  `);
  // INSERT one question row into the old schema.
  db.prepare(
    `INSERT INTO board_messages (id, seq, author, to_agent, kind, body, ref_task_id, ref_ticket_id, created_at, host_id, origin)
     VALUES ('old1', 1, 'A', NULL, 'question', 'old question', NULL, NULL, ?, 'host-test', 'local')`,
  ).run(unixNow());

  // run the migration.
  migrate(db);

  // the new columns exist.
  const cols = (db.prepare('PRAGMA table_info(board_messages)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  assert.ok(cols.includes('resolved_at'), 'the resolved_at column was not added');
  assert.ok(cols.includes('resolved_by'), 'the resolved_by column was not added');

  // the existing question reads as unresolved (resolved_at IS NULL).
  const unresolved = readBoard(cdb, { unresolvedOnly: true });
  assert.equal(unresolved.messages.length, 1);
  assert.equal(unresolved.messages[0]?.id, 'old1');
  assert.equal(unresolved.messages[0]?.resolved_at, null);

  // now that the new columns are in, resolve_question works too.
  const r = resolveQuestion(cdb, { agentId: 'B', messageId: 'old1' });
  assert.deepEqual(r, { ok: true, already_resolved: false });
});

// ---- wakes ----

test('wake/take_pending_wakes: consumes a pending wake exactly once', () => {
  wake(cdb, 'A', 'overlap', { by: 'B', files: ['x.ts'] });
  wake(cdb, 'A', 'overlap', { by: 'C', files: ['y.ts'] });
  const first = takePendingWakes(cdb, 'A', 'overlap');
  assert.equal(first.length, 2);
  // the second time is empty (already consumed)
  const second = takePendingWakes(cdb, 'A', 'overlap');
  assert.equal(second.length, 0);
});

test('take_pending_wakes: filtered by target/kind', () => {
  wake(cdb, 'A', 'overlap', { by: 'B' });
  wake(cdb, 'B', 'overlap', { by: 'A' });
  assert.equal(takePendingWakes(cdb, 'B', 'overlap').length, 1);
  assert.equal(takePendingWakes(cdb, 'A', 'overlap').length, 1);
});

// ---- is_ready ----

test('is_ready: ready if there are no block edges', () => {
  const t = createTask(cdb, { repo: 'r', title: 't' });
  assert.equal(isReady(cdb, t.id), true);
});

test('is_ready: ready only once the blocker becomes done', () => {
  const blocker = createTask(cdb, { repo: 'r', title: 'blocker' });
  const blocked = createTask(cdb, { repo: 'r', title: 'blocked' });
  // draw the edge where blocker blocks blocked
  cdb.db
    .prepare(
      `INSERT INTO task_edges (from_task, to_task, kind, host_id, origin)
       VALUES (?, ?, 'blocks', 'host-test', 'local')`,
    )
    .run(blocker.id, blocked.id);
  assert.equal(isReady(cdb, blocked.id), false);
  // make blocker done
  cdb.db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(blocker.id);
  assert.equal(isReady(cdb, blocked.id), true);
});

// ---- wait_for_unblock (long-poll) ----

test('wait_for_unblock: a board message for me returns with woke_by=board', async () => {
  // place one board message first to advance the cursor (only pick up posts after it)
  postBoard(cdb, { agentId: 'X', body: 'old' });
  const p = waitForUnblock(cdb, { agentId: 'A', timeoutSec: 5, pollMs: 20 });
  // post one for A a bit later
  setTimeout(() => postBoard(cdb, { agentId: 'X', body: 'hey A', toAgent: 'A', kind: 'handoff' }), 60);
  const r = await p;
  assert.equal(r.woke_by, 'board');
  const msgs = r.payload as Array<{ body: string }>;
  assert.equal(msgs[0]?.body, 'hey A');
});

test('wait_for_unblock: returns on an overlap wake and returns the payload', async () => {
  const p = waitForUnblock(cdb, { agentId: 'A', timeoutSec: 5, pollMs: 20 });
  setTimeout(() => wake(cdb, 'A', 'overlap', { by: 'B', files: ['z.ts'] }), 60);
  const r = await p;
  assert.equal(r.woke_by, 'overlap');
  const payload = r.payload as Array<{ by: string; files: string[] }>;
  assert.equal(payload[0]?.by, 'B');
});

test('wait_for_unblock: returns with task_ready once the waited task becomes ready', async () => {
  const blocker = createTask(cdb, { repo: 'r', title: 'blocker' });
  const blocked = createTask(cdb, { repo: 'r', title: 'blocked' });
  cdb.db
    .prepare(
      `INSERT INTO task_edges (from_task, to_task, kind, host_id, origin)
       VALUES (?, ?, 'blocks', 'host-test', 'local')`,
    )
    .run(blocker.id, blocked.id);
  const p = waitForUnblock(cdb, { agentId: 'A', taskId: blocked.id, timeoutSec: 5, pollMs: 20 });
  setTimeout(() => cdb.db.prepare(`UPDATE tasks SET status='done' WHERE id=?`).run(blocker.id), 60);
  const r = await p;
  assert.equal(r.woke_by, 'task_ready');
});

test('wait_for_unblock: timeout if nothing happens', async () => {
  const r = await waitForUnblock(cdb, { agentId: 'A', timeoutSec: 1, pollMs: 50 });
  assert.equal(r.woke_by, 'timeout');
});

// ---- connection: publishDirty actually delivers an overlap wake ----

test('publishDirty → wait_for_unblock: a dirty overlap wakes the peer (wake connection)', async () => {
  // A publishes shared.ts as dirty
  publishDirty(cdb, { agentId: 'A', worktreePath: '/wt/A', files: ['src/shared.ts'] });
  // A starts waiting
  const p = waitForUnblock(cdb, { agentId: 'A', timeoutSec: 5, pollMs: 20 });
  // B publishes the same file as dirty → an overlap wake should fly to A
  setTimeout(
    () => publishDirty(cdb, { agentId: 'B', worktreePath: '/wt/B', files: ['src/shared.ts'] }),
    60,
  );
  const r = await p;
  assert.equal(r.woke_by, 'overlap');
  const payload = r.payload as Array<{ by: string; files: string[] }>;
  assert.equal(payload[0]?.by, 'B');
  assert.deepEqual(payload[0]?.files, ['src/shared.ts']);
});

test('publishDirty: the returned wake_targets contains the peer actually woken', () => {
  claimFiles(cdb, { agentId: 'A', globs: ['src/**'] });
  const r = publishDirty(cdb, { agentId: 'B', worktreePath: '/wt/B', files: ['src/x.ts'] });
  // B's dirty (src/x.ts) overlaps A's claim (src/**)
  assert.deepEqual(r.wake_targets, ['A']);
  // an overlap wake is stacked for A
  assert.equal(takePendingWakes(cdb, 'A', 'overlap').length, 1);
});

// one light regression so the releaseTask import does not become unused
test('claim→release does not affect board/wake (regression)', () => {
  const t = createTask(cdb, { repo: 'r', title: 't' });
  const c = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(c.ok, true);
  assert.equal(releaseTask(cdb, t.id, 'A').ok, true);
});

// ---- board read position (board_cursors) ----

test('unread: counts posts addressed to me and to everyone, but not to others, my own, or system kinds', () => {
  getBoardCursor(cdb, 'A'); // first sight at seq 0
  postBoard(cdb, { agentId: 'B', toAgent: 'A', kind: 'question', body: 'to A' });
  postBoard(cdb, { agentId: 'B', body: 'to everyone' });
  postBoard(cdb, { agentId: 'B', toAgent: 'C', body: 'to C' });
  postBoard(cdb, { agentId: 'A', body: 'my own' });
  postBoard(cdb, { agentId: 'system', kind: 'ticket_ready', body: 'ready' });
  postBoard(cdb, { agentId: 'publisher', kind: 'pr_opened', body: 'opened' });
  postBoard(cdb, { agentId: 'publisher', kind: 'pr_updated', body: 'updated' });
  postBoard(cdb, { agentId: 'publisher', kind: 'pr_merged', body: 'merged' });

  assert.deepEqual(
    listUnread(cdb, 'A').map((m) => m.body),
    ['to A', 'to everyone'],
  );
  assert.equal(countUnread(cdb, 'A'), 2);
  // system kinds are still readable through the normal read_board
  assert.equal(readBoard(cdb, { kind: 'ticket_ready' }).messages.length, 1);
});

test('unread: a new agent starts directed at 0 and broadcast at the latest seq', () => {
  postBoard(cdb, { agentId: 'B', toAgent: 'A', kind: 'handoff', body: 'handoff before start' });
  postBoard(cdb, { agentId: 'B', body: 'old broadcast' });

  const cursor = getBoardCursor(cdb, 'A');
  assert.deepEqual(cursor, { directed_seq: 0, broadcast_seq: 2 });
  assert.deepEqual(
    listUnread(cdb, 'A').map((m) => m.body),
    ['handoff before start'],
  );

  // a broadcast after first sight is unread
  postBoard(cdb, { agentId: 'B', body: 'new broadcast' });
  assert.deepEqual(
    listUnread(cdb, 'A').map((m) => m.body),
    ['handoff before start', 'new broadcast'],
  );
  // the first-sight position does not move on later reads
  assert.deepEqual(getBoardCursor(cdb, 'A'), { directed_seq: 0, broadcast_seq: 2 });
});

test('consumeUnread: advances directed and broadcast separately and does not touch other agents', () => {
  getBoardCursor(cdb, 'A');
  getBoardCursor(cdb, 'C');
  postBoard(cdb, { agentId: 'B', toAgent: 'A', body: 'd1' }); // seq 1
  postBoard(cdb, { agentId: 'B', body: 'b1' }); // seq 2
  postBoard(cdb, { agentId: 'B', toAgent: 'A', body: 'd2' }); // seq 3

  assert.deepEqual(consumeUnread(cdb, 'A', { limit: 2 }).map((m) => m.body), ['d1', 'b1']);
  assert.deepEqual(getBoardCursor(cdb, 'A'), { directed_seq: 1, broadcast_seq: 2 });
  assert.deepEqual(consumeUnread(cdb, 'A').map((m) => m.body), ['d2']);
  assert.equal(countUnread(cdb, 'A'), 0);

  // C's position is untouched; the broadcast is still unread for C
  assert.deepEqual(getBoardCursor(cdb, 'C'), { directed_seq: 0, broadcast_seq: 0 });
  assert.deepEqual(
    listUnread(cdb, 'C').map((m) => m.body),
    ['b1'],
  );
});

test('board_cursors: adding the table to an existing DB seeds agents that ran at the latest seq, not workers that only received a handoff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockage-cursor-'));
  const path = join(dir, 'db.sqlite');
  try {
    const first = openDb({ path, hostId: 'host-test' });
    heartbeat(first, 'A'); // A ran (in agents)
    postBoard(first, { agentId: 'B', toAgent: 'A', kind: 'question', body: 'old, long resolved' });
    postBoard(first, { agentId: 'B', body: 'old broadcast' });
    // W was handed a task but has not launched: it only appears as a to_agent
    postBoard(first, { agentId: 'B', toAgent: 'W', kind: 'handoff', body: 'handoff to W' });
    first.db.exec('DROP TABLE board_cursors'); // reproduce a DB from before this table
    first.close();

    const second = openDb({ path, hostId: 'host-test' });
    // A (agents) and B (author) start at the latest seq: no old post floods in
    for (const agent of ['A', 'B']) {
      assert.deepEqual(getBoardCursor(second, agent), { directed_seq: 3, broadcast_seq: 3 }, agent);
      assert.equal(countUnread(second, agent), 0, agent);
    }
    const w = second.db.prepare(`SELECT 1 FROM board_cursors WHERE agent_id = 'W'`).get();
    assert.equal(w, undefined, 'W was seeded although it never ran');
    // W starts like any newcomer: its handoff from before the upgrade is still unread
    assert.deepEqual(listUnread(second, 'W').map((m) => m.body), ['handoff to W']);
    postBoard(second, { agentId: 'B', toAgent: 'A', body: 'new for A' });
    assert.deepEqual(consumeUnread(second, 'A').map((m) => m.body), ['new for A']);
    second.close();

    // reopening does not migrate again and the positions survive
    const third = openDb({ path, hostId: 'host-test' });
    assert.equal(countUnread(third, 'A'), 0, 'the read position survives a reopen');
    assert.equal(countUnread(third, 'W'), 1);
    third.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('heartbeat (own liveness) starts tracking broadcasts; a touchAgent:false heartbeat does not', () => {
  postBoard(cdb, { agentId: 'B', body: 'before anyone' });
  heartbeat(cdb, 'A');
  heartbeat(cdb, 'W', { touchAgent: false }); // e.g. handoff_task to a worker not launched yet
  postBoard(cdb, { agentId: 'B', body: 'after A appeared' });
  assert.deepEqual(listUnread(cdb, 'A').map((m) => m.body), ['after A appeared']);
  const w = cdb.db.prepare(`SELECT 1 FROM board_cursors WHERE agent_id = 'W'`).get();
  assert.equal(w, undefined, 'W got a read position before it launched');
});

// ---- wait_for_unblock from the stored read position ----

const quickWait = (agentId: string, timeoutSec = 1) =>
  waitForUnblock(cdb, { agentId, timeoutSec, pollMs: 20 });

test('wait_for_unblock: a directed post that arrived while not waiting wakes the next wait (problem 1)', async () => {
  assert.equal((await quickWait('A')).woke_by, 'timeout');
  // A is "working" (not waiting) when B posts
  postBoard(cdb, { agentId: 'B', toAgent: 'A', kind: 'question', body: 'please check' });
  const r = await quickWait('A');
  assert.equal(r.woke_by, 'board');
  assert.deepEqual(
    (r.payload as BoardMessage[]).map((m) => m.body),
    ['please check'],
  );
});

test('wait_for_unblock: a broadcast between a timeout and the re-call still wakes', async () => {
  assert.equal((await quickWait('A')).woke_by, 'timeout');
  postBoard(cdb, { agentId: 'B', body: 'to everyone' });
  const r = await quickWait('A');
  assert.equal(r.woke_by, 'board');
  assert.equal((r.payload as BoardMessage[])[0]?.body, 'to everyone');
});

test('wait_for_unblock: a post already returned does not wake the next wait', async () => {
  getBoardCursor(cdb, 'A');
  postBoard(cdb, { agentId: 'B', toAgent: 'A', body: 'once' });
  assert.equal((await quickWait('A')).woke_by, 'board');
  assert.equal((await quickWait('A')).woke_by, 'timeout');
  assert.equal(countUnread(cdb, 'A'), 0);
});

test('wait_for_unblock: a directed post before the agent ever appeared wakes its first wait (pre-start handoff)', async () => {
  postBoard(cdb, { agentId: 'B', body: 'old broadcast' });
  postBoard(cdb, { agentId: 'A', toAgent: 'W', kind: 'handoff', body: 'task handed to W' });
  const r = await quickWait('W');
  assert.equal(r.woke_by, 'board');
  assert.deepEqual(
    (r.payload as BoardMessage[]).map((m) => m.body),
    ['task handed to W'],
  );
});

test('wait_for_unblock: system kinds and my own posts do not wake', async () => {
  getBoardCursor(cdb, 'A');
  postBoard(cdb, { agentId: 'A', body: 'my own note' });
  postBoard(cdb, { agentId: 'system', kind: 'ticket_ready', body: 'ready' });
  postBoard(cdb, { agentId: 'publisher', kind: 'pr_opened', body: 'opened' });
  postBoard(cdb, { agentId: 'publisher', kind: 'pr_updated', body: 'updated' });
  postBoard(cdb, { agentId: 'publisher', kind: 'pr_merged', body: 'merged' });
  assert.equal((await quickWait('A')).woke_by, 'timeout');
});

test('wait_for_unblock: a post plus a leftover board wake (old DB) wakes only once (problem 2)', async () => {
  const p = waitForUnblock(cdb, { agentId: 'A', timeoutSec: 3, pollMs: 20 });
  setTimeout(() => {
    postBoard(cdb, { agentId: 'B', toAgent: 'A', kind: 'handoff', body: 'handoff' });
    wake(cdb, 'A', 'board', { reason: 'handoff' }); // what the old handoff_task also stacked
  }, 60);
  assert.equal((await p).woke_by, 'board');
  assert.equal((await quickWait('A')).woke_by, 'timeout', 'the leftover board wake woke A again');
});

test('wait_for_unblock: a leftover board wake alone (old DB) is still honored', async () => {
  getBoardCursor(cdb, 'A');
  wake(cdb, 'A', 'board', { reason: 'merge_needs_review' });
  const r = await quickWait('A');
  assert.equal(r.woke_by, 'board');
  assert.deepEqual(r.payload, [{ reason: 'merge_needs_review' }]);
});

// ---- heartbeat preview / read_board(unread_only) ----

test('summarizeUnread: the count and the newest 3 unread as short previews, without advancing the read position', () => {
  getBoardCursor(cdb, 'A');
  const task = createTask(cdb, { repo: 'r', title: 't' });
  for (let i = 1; i <= 4; i++) postBoard(cdb, { agentId: 'B', toAgent: 'A', body: `m${i}` });
  postBoard(cdb, {
    agentId: 'B',
    kind: 'question',
    body: 'x'.repeat(100),
    refTaskId: task.id,
  });

  const { unread_count, unread_preview: p } = summarizeUnread(cdb, 'A');
  assert.equal(unread_count, 5);
  assert.deepEqual(
    p.map((m) => m.seq),
    [3, 4, 5],
  );
  assert.equal(p[2]?.kind, 'question');
  assert.equal(p[2]?.ref_task_id, task.id);
  assert.equal(p[2]?.body_head, `${'x'.repeat(80)}…`);
  assert.equal(p[0]?.body_head, 'm3');
  assert.equal(countUnread(cdb, 'A'), 5, 'the summary does not mark anything read');
});

test('readUnread: returns only unread, marks them read, and is empty when called again', () => {
  getBoardCursor(cdb, 'A');
  postBoard(cdb, { agentId: 'B', toAgent: 'A', body: 'to A' });
  postBoard(cdb, { agentId: 'B', body: 'to everyone' });
  postBoard(cdb, { agentId: 'A', body: 'my own' });
  postBoard(cdb, { agentId: 'system', kind: 'ticket_ready', body: 'ready' });

  assert.deepEqual(
    readUnread(cdb, 'A').messages.map((m) => m.body),
    ['to A', 'to everyone'],
  );
  assert.deepEqual(readUnread(cdb, 'A').messages, []);
  // the normal read still returns everything
  assert.equal(readBoard(cdb).messages.length, 4);
});

test('readUnread: limit returns the oldest unread first and leaves the rest unread', () => {
  getBoardCursor(cdb, 'A');
  for (let i = 1; i <= 3; i++) postBoard(cdb, { agentId: 'B', toAgent: 'A', body: `m${i}` });
  assert.deepEqual(
    readUnread(cdb, 'A', { limit: 2 }).messages.map((m) => m.body),
    ['m1', 'm2'],
  );
  assert.deepEqual(
    readUnread(cdb, 'A').messages.map((m) => m.body),
    ['m3'],
  );
});


/** Run an ES module snippet in a separate node process that can import the TypeScript sources. */
function spawnTs(script: string) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: root });
}

/** Collect a spawned process's stdout as JSON, or reject with its stderr. */
function jsonOut<T>(p: ReturnType<typeof spawnTs>): Promise<T> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out) as T) : reject(new Error(err))));
  });
}

// ---- consuming unread: paging and concurrency ----

test('consumeUnread: a limit boundary across directed and broadcast leaves the rest unread', () => {
  getBoardCursor(cdb, 'A');
  postBoard(cdb, { agentId: 'B', toAgent: 'A', body: 'd1' }); // seq 1
  postBoard(cdb, { agentId: 'B', body: 'b1' }); // seq 2
  postBoard(cdb, { agentId: 'B', toAgent: 'A', body: 'd2' }); // seq 3
  postBoard(cdb, { agentId: 'B', body: 'b2' }); // seq 4
  assert.deepEqual(consumeUnread(cdb, 'A', { limit: 3 }).map((m) => m.body), ['d1', 'b1', 'd2']);
  assert.deepEqual(getBoardCursor(cdb, 'A'), { directed_seq: 3, broadcast_seq: 2 });
  assert.deepEqual(consumeUnread(cdb, 'A', { limit: 3 }).map((m) => m.body), ['b2']);
});

test('wait_for_unblock: more unread than the return limit comes back over several calls', async () => {
  getBoardCursor(cdb, 'A');
  for (let i = 1; i <= UNREAD_RETURN_LIMIT + 1; i++) {
    postBoard(cdb, { agentId: 'B', toAgent: 'A', body: `m${i}` });
  }
  const first = await waitForUnblock(cdb, { agentId: 'A', timeoutSec: 1, pollMs: 20 });
  assert.equal((first.payload as BoardMessage[]).length, UNREAD_RETURN_LIMIT);
  const second = await waitForUnblock(cdb, { agentId: 'A', timeoutSec: 1, pollMs: 20 });
  assert.deepEqual(
    (second.payload as BoardMessage[]).map((m) => m.body),
    [`m${UNREAD_RETURN_LIMIT + 1}`],
  );
});

test('wait_for_unblock: waking on a post drains every leftover board wake, whatever its payload', async () => {
  getBoardCursor(cdb, 'A');
  wake(cdb, 'A', 'board', { reason: 'handoff', task_id: 't1' });
  wake(cdb, 'A', 'board', { reason: 'merge_needs_review', task: 't2' });
  postBoard(cdb, { agentId: 'B', toAgent: 'A', body: 'post' });
  assert.equal((await waitForUnblock(cdb, { agentId: 'A', timeoutSec: 1, pollMs: 20 })).woke_by, 'board');
  assert.deepEqual(takePendingWakes(cdb, 'A', 'board'), []);
});

test('consumeUnread: processes consuming the same agent concurrently never get the same post twice', async () => {
  // Real separate processes on one ledger file, each taking 1 post at a time until none is left.
  const dir = mkdtempSync(join(tmpdir(), 'lockage-consume-'));
  const path = join(dir, 'db.sqlite');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const POSTS = 40;
  try {
    const setup = openDb({ path, hostId: 'host-test' });
    getBoardCursor(setup, 'A');
    for (let i = 1; i <= POSTS; i++) postBoard(setup, { agentId: 'B', toAgent: 'A', body: `m${i}` });
    setup.close();

    const script = `
      const { openDb } = await import(${JSON.stringify(join(root, 'src/db/index.ts'))});
      const { consumeUnread } = await import(${JSON.stringify(join(root, 'src/lockage/board.ts'))});
      const cdb = openDb({ path: ${JSON.stringify(path)}, hostId: 'host-test' });
      const got = [];
      for (;;) {
        const m = consumeUnread(cdb, 'A', { limit: 1 });
        if (m.length === 0) break;
        got.push(m[0].seq);
      }
      cdb.close();
      process.stdout.write(JSON.stringify(got));
    `;
    const run = () => jsonOut<number[]>(spawnTs(script));
    const results = await Promise.all([run(), run(), run(), run()]);
    const all = results.flat().sort((a, b) => a - b);
    assert.deepEqual(all, Array.from({ length: POSTS }, (_, i) => i + 1), 'a post was returned twice or lost');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateBoardCursors: a seed that fails leaves no table behind, so the next open retries', () => {
  postBoard(cdb, { agentId: 'B', toAgent: 'A', body: 'old' });
  cdb.db.exec('DROP TABLE board_cursors');
  // an agents table the seed cannot read makes the seed throw after the CREATE ran
  cdb.db.exec('DROP TABLE agents');
  cdb.db.exec('CREATE TABLE agents (name TEXT)');
  const schema = readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'src/db/schema.sql'), 'utf8');
  assert.throws(() => migrateBoardCursors(cdb.db, schema));
  const table = cdb.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'board_cursors'`).get();
  assert.equal(table, undefined, 'board_cursors survived a failed seed');
});

test('migrateBoardCursors: a ledger without an agents table seeds board authors only', () => {
  postBoard(cdb, { agentId: 'B', toAgent: 'W', kind: 'handoff', body: 'to W' });
  cdb.db.exec('DROP TABLE board_cursors');
  cdb.db.exec('DROP TABLE agents');
  const schema = readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'src/db/schema.sql'), 'utf8');
  migrateBoardCursors(cdb.db, schema);
  const rows = cdb.db.prepare(`SELECT agent_id FROM board_cursors ORDER BY agent_id`).all();
  assert.deepEqual(rows.map((r: any) => r.agent_id), ['B']);
  migrateBoardCursors(cdb.db, schema); // a second call is a no-op
  assert.equal(cdb.db.prepare(`SELECT COUNT(*) AS n FROM board_cursors`).get()?.n, 1);
});

// A smoke test: the race window is a few milliseconds and the child processes start at slightly
// different times, so this passing does not prove the migration is atomic (the two tests above do the
// deterministic part). It guards against a gross regression such as seeding after other work.
test('board_cursors migration: processes opening a pre-upgrade ledger at once seed it exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockage-migrate-'));
  const path = join(dir, 'db.sqlite');
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    const setup = openDb({ path, hostId: 'host-test' });
    heartbeat(setup, 'A');
    for (let i = 1; i <= 5; i++) postBoard(setup, { agentId: 'B', toAgent: 'A', body: `old ${i}` });
    setup.db.exec('DROP TABLE board_cursors');
    setup.close();

    // each process opens the ledger and asks for A's unread right away (which would create A's row
    // at directed 0 if it ran before the seed)
    const script = `
      const { openDb } = await import(${JSON.stringify(join(root, 'src/db/index.ts'))});
      const { countUnread } = await import(${JSON.stringify(join(root, 'src/lockage/board.ts'))});
      const cdb = openDb({ path: ${JSON.stringify(path)}, hostId: 'host-test' });
      const n = countUnread(cdb, 'A');
      cdb.close();
      process.stdout.write(JSON.stringify(n));
    `;
    const counts = await Promise.all([1, 2, 3, 4].map(() => jsonOut<number>(spawnTs(script))));
    assert.deepEqual(counts, [0, 0, 0, 0], 'A saw old posts as unread: the seed raced');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
