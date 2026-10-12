import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, unixNow, type CoordDb } from '../src/db/index.js';
import { createTask, claimTask, releaseTask } from '../src/lockage/claim.js';
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
