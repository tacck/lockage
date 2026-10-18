import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, unixNow } from '../src/db/index.ts';
import {
  createTask,
  claimTask,
  releaseTask,
  getTask,
  listTasks,
  sweepExpired,
  heartbeat,
  addDependency,
  blockTask,
  resumeTask,
  listBlockedTasks,
  handoffTask,
  TASK_LEASE_SEC,
} from '../src/lockage/claim.ts';
import { isReady, postBoard } from '../src/lockage/board.ts';
import {
  openTicket,
  linkTaskToTicket,
  getTicket,
  updateTicket,
  closeTicketOnMerge,
  listTickets,
} from '../src/lockage/tickets.ts';

/** Each test uses an independent in-memory DB. */
function freshDb() {
  return openDb({ path: ':memory:', hostId: 'test-host' });
}

test('the schema is initialized and all tables are created', () => {
  const cdb = freshDb();
  const names = (
    cdb.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
  for (const t of [
    'tickets',
    'ticket_repos',
    'tasks',
    'task_edges',
    'claims',
    'board_messages',
    'worktree_assignments',
    'agents',
    'dirty_sets',
    'merge_queue',
  ]) {
    assert.ok(names.includes(t), `table ${t} should exist`);
  }
  cdb.close();
});

test('openDb: an old DB with leftover retired context_entries / context_fts still opens as-is and the record is not deleted (#69)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockage-legacy-context-'));
  const dbPath = join(dir, 'legacy.sqlite');
  try {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE context_entries (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, what TEXT NOT NULL, why TEXT, decisions TEXT, risks TEXT,
        created_at INTEGER NOT NULL, host_id TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE context_fts USING fts5(
        what, why, decisions, risks, content='context_entries', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER context_ai AFTER INSERT ON context_entries BEGIN
        INSERT INTO context_fts(rowid, what, why, decisions, risks)
        VALUES (new.rowid, new.what, new.why, new.decisions, new.risks);
      END;
      INSERT INTO context_entries (id, agent_id, what, created_at, host_id) VALUES ('c1', 'a', 'old record', 0, 'h');
    `);
    raw.close();

    const cdb = openDb({ path: dbPath, hostId: 'h' });
    try {
      const t = createTask(cdb, { repo: 'r', title: 't' });
      assert.equal(getTask(cdb.db, t.id)?.status, 'open');
      const n = (cdb.db.prepare('SELECT COUNT(*) AS n FROM context_entries').get() as { n: number }).n;
      assert.equal(n, 1, 'the old record remains');
    } finally {
      cdb.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createTask creates an open task with version=0', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'add login' });
  assert.equal(t.status, 'open');
  assert.equal(t.version, 0);
  assert.equal(t.assignee, null);
  assert.equal(t.repo, 'app');
  assert.equal(t.host_id, 'test-host');
  cdb.close();
});

test('claimTask grabs an open task and makes it in_progress / version+1', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  const r = claimTask(cdb, t.id, 'agent-A', t.version);
  assert.ok(r.ok, 'claim should succeed');
  if (r.ok) {
    assert.equal(r.task.assignee, 'agent-A');
    assert.equal(r.task.status, 'in_progress');
    assert.equal(r.task.version, 1);
    assert.ok(r.task.heartbeat_at && r.task.heartbeat_at > 0);
  }
  cdb.close();
});

test('a double claim of the same task makes the later one conflict (mechanical serialization)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });

  const first = claimTask(cdb, t.id, 'agent-A', 0);
  const second = claimTask(cdb, t.id, 'agent-B', 0); // assume B also read version=0

  assert.ok(first.ok, 'first claim wins');
  assert.ok(!second.ok, 'second claim must fail');
  if (!second.ok) {
    assert.equal(second.reason, 'conflict');
    assert.equal(second.current?.assignee, 'agent-A');
    assert.equal(second.current?.status, 'in_progress');
  }
  cdb.close();
});

test('a version mismatch (someone else touched it after the read) is also rejected as conflict', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  // A grabs then releases → version advances to 2
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  assert.ok(releaseTask(cdb, t.id, 'agent-A').ok);
  const afterRelease = getTask(cdb.db, t.id)!;
  assert.equal(afterRelease.version, 2);
  assert.equal(afterRelease.status, 'open');

  // a claim still holding the stale version=0 is rejected
  const stale = claimTask(cdb, t.id, 'agent-C', 0);
  assert.ok(!stale.ok);
  if (!stale.ok) assert.equal(stale.reason, 'conflict');

  // claiming with the latest version goes through
  const fresh = claimTask(cdb, t.id, 'agent-C', afterRelease.version);
  assert.ok(fresh.ok);
  cdb.close();
});

test('claiming a non-existent task is not_found', () => {
  const cdb = freshDb();
  const r = claimTask(cdb, 'NO_SUCH_ID', 'agent-A', 0);
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.reason, 'not_found');
  cdb.close();
});

test('releaseTask is only possible for the holder (others fail)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  assert.equal(releaseTask(cdb, t.id, 'agent-B').ok, false, 'others cannot release');
  assert.equal(releaseTask(cdb, t.id, 'agent-A').ok, true, 'the holder can release');
  cdb.close();
});

test('list_tasks(status:open) excludes in_progress and can be filtered by repo', () => {
  const cdb = freshDb();
  const a = createTask(cdb, { repo: 'app', title: 'a', priority: 1 });
  createTask(cdb, { repo: 'app', title: 'b', priority: 5 });
  createTask(cdb, { repo: 'lib', title: 'c' });
  claimTask(cdb, a.id, 'agent-A', 0); // a goes to in_progress

  const appOpen = listTasks(cdb, { status: 'open', repo: 'app' });
  assert.equal(appOpen.length, 1, 'app\'s open is only b');
  assert.equal(appOpen[0].title, 'b');

  const all = listTasks(cdb, { status: 'open' });
  assert.equal(all.length, 2, 'open across all repos is b and c');
  cdb.close();
});

test('sweepExpired returns in_progress with lapsed heartbeat back to open', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);

  // set heartbeat to a past older than the lease to reproduce a lapse
  const stale = unixNow() - TASK_LEASE_SEC - 60;
  cdb.db.prepare('UPDATE tasks SET heartbeat_at = ? WHERE id = ?').run(stale, t.id);

  sweepExpired(cdb);
  const after = getTask(cdb.db, t.id)!;
  assert.equal(after.status, 'open', 'returns to open on sweep');
  assert.equal(after.assignee, null);

  // after returning, it can be re-claimed (with the new version)
  assert.ok(claimTask(cdb, t.id, 'agent-B', after.version).ok);
  cdb.close();
});

test('sweepExpired logically reclaims expired claims (sets released_at)', () => {
  const cdb = freshDb();
  const now = unixNow();
  // insert an already-expired claim directly
  cdb.db
    .prepare(
      `INSERT INTO claims (id, holder, globs, lease_ttl_sec, heartbeat_at, expires_at, released_at, created_at, host_id, origin)
       VALUES ('c1', 'agent-A', '["src/**"]', 60, ?, ?, NULL, ?, 'test-host', 'local')`,
    )
    .run(now - 120, now - 60, now - 120);

  sweepExpired(cdb, now);
  const c = cdb.db.prepare('SELECT released_at FROM claims WHERE id = ?').get('c1') as {
    released_at: number | null;
  };
  assert.ok(c.released_at !== null, 'an expired claim gets released_at set');
  cdb.close();
});

test('heartbeat upserts agents and extends the claim lease', () => {
  const cdb = freshDb();
  const now = unixNow();
  cdb.db
    .prepare(
      `INSERT INTO claims (id, holder, globs, lease_ttl_sec, heartbeat_at, expires_at, released_at, created_at, host_id, origin)
       VALUES ('c1', 'agent-A', '["src/**"]', 3600, ?, ?, NULL, ?, 'test-host', 'local')`,
    )
    .run(now - 100, now - 100 + 3600, now - 100);

  heartbeat(cdb, 'agent-A');

  const agent = cdb.db.prepare('SELECT * FROM agents WHERE agent_id = ?').get('agent-A');
  assert.ok(agent, 'it is registered in agents');

  const c = cdb.db.prepare('SELECT expires_at FROM claims WHERE id = ?').get('c1') as {
    expires_at: number;
  };
  assert.ok(c.expires_at >= now + 3600 - 1, 'the lease extends relative to the current time');
  cdb.close();
});

test('createTask(dependsOn): draws an edge and is_ready=false if a blocker is incomplete', () => {
  const cdb = freshDb();
  const blocker = createTask(cdb, { repo: 'app', title: 'blocker' });
  const dependent = createTask(cdb, {
    repo: 'app',
    title: 'dependent',
    dependsOn: [blocker.id],
  });
  // dependent is a Task (not a cycle)
  assert.ok('id' in dependent);
  const dep = dependent as typeof blocker;
  // blocker incomplete → not ready
  assert.equal(isReady(cdb, dep.id), false);
  // making the blocker done makes it ready
  cdb.db.prepare(`UPDATE tasks SET status='done' WHERE id=?`).run(blocker.id);
  assert.equal(isReady(cdb, dep.id), true);
  cdb.close();
});

test('createTask(dependsOn): a diamond (depends_on members connected by a path) is not a cycle', () => {
  const cdb = freshDb();
  // a blocks b; T depends on both a and b. a→b plus a→T, b→T is a DAG with a redundant edge.
  const a = createTask(cdb, { repo: 'app', title: 'a' });
  const b = createTask(cdb, { repo: 'app', title: 'b', dependsOn: [a.id] });
  assert.ok('id' in b);
  const t = createTask(cdb, { repo: 'app', title: 't', dependsOn: [a.id, b.id] });
  assert.ok('id' in t, 'a diamond depends_on must not be rejected as a cycle');
  const edges = cdb.db
    .prepare(`SELECT from_task FROM task_edges WHERE to_task = ? AND kind = 'blocks' ORDER BY from_task`)
    .all(t.id) as Array<{ from_task: string }>;
  assert.deepEqual(
    edges.map((e) => e.from_task),
    [a.id, b.id].sort(),
  );
  // the order of depends_on does not matter
  const t2 = createTask(cdb, { repo: 'app', title: 't2', dependsOn: [b.id, a.id] });
  assert.ok('id' in t2);
  cdb.close();
});

test('addDependency: a real cycle through a diamond is still rejected', () => {
  const cdb = freshDb();
  const a = createTask(cdb, { repo: 'app', title: 'a' });
  const b = createTask(cdb, { repo: 'app', title: 'b', dependsOn: [a.id] });
  const t = createTask(cdb, { repo: 'app', title: 't', dependsOn: [a.id, b.id] });
  assert.ok('id' in b && 'id' in t);
  // t→a would close a→t→a (and a→b→t→a)
  const r = addDependency(cdb, t.id, a.id);
  assert.ok(!r.ok && r.reason === 'cycle');
  // t→b would close b→t→b
  const r2 = addDependency(cdb, t.id, b.id);
  assert.ok(!r2.ok && r2.reason === 'cycle');
  cdb.close();
});

test('addDependency: can draw an edge between existing tasks', () => {
  const cdb = freshDb();
  const x = createTask(cdb, { repo: 'app', title: 'x' });
  const y = createTask(cdb, { repo: 'app', title: 'y' });
  const r = addDependency(cdb, x.id, y.id); // x blocks y
  assert.equal(r.ok, true);
  // y is not ready because x is incomplete
  assert.equal(isReady(cdb, y.id), false);
  cdb.close();
});

test('addDependency: a reverse edge would be a cycle, so reject it', () => {
  const cdb = freshDb();
  const x = createTask(cdb, { repo: 'app', title: 'x' });
  const y = createTask(cdb, { repo: 'app', title: 'y' });
  assert.equal(addDependency(cdb, x.id, y.id).ok, true); // x→y
  const r = addDependency(cdb, y.id, x.id); // y→x is a cycle
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === 'cycle');
  cdb.close();
});

test('addDependency: self-dependency and a non-existent task are rejected', () => {
  const cdb = freshDb();
  const x = createTask(cdb, { repo: 'app', title: 'x' });
  const self = addDependency(cdb, x.id, x.id);
  assert.ok(!self.ok && self.reason === 'self');
  const missing = addDependency(cdb, x.id, 'NOPE');
  assert.ok(!missing.ok && missing.reason === 'not_found');
  cdb.close();
});

test('listTasks: can be filtered by status/assignee/ticket_id/repo', () => {
  const cdb = freshDb();
  const a = createTask(cdb, { repo: 'app', title: 'a' });
  createTask(cdb, { repo: 'app', title: 'b' });
  createTask(cdb, { repo: 'lib', title: 'c' });
  claimTask(cdb, a.id, 'agent-A', 0); // a is in_progress / assignee=A

  assert.equal(listTasks(cdb, { status: 'open' }).length, 2);
  assert.equal(listTasks(cdb, { status: 'in_progress' }).length, 1);
  assert.equal(listTasks(cdb, { assignee: 'agent-A' }).length, 1);
  assert.equal(listTasks(cdb, { repo: 'lib' }).length, 1);
  assert.equal(listTasks(cdb, { repo: 'app', status: 'open' }).length, 1);
  assert.equal(listTasks(cdb).length, 3); // no filter returns everything
  cdb.close();
});

test('listTasks(ticket_id): can narrow to under a parent ticket', () => {
  const cdb = freshDb();
  // create a real ticket and link it (ticket_id is an FK to tickets(id))
  const ticket = openTicket(cdb, { title: 'parent' });
  const t1 = createTask(cdb, { repo: 'app', title: 'child1' });
  createTask(cdb, { repo: 'app', title: 'orphan' });
  linkTaskToTicket(cdb, t1.id, ticket.id);

  const underTicket = listTasks(cdb, { ticketId: ticket.id });
  assert.equal(underTicket.length, 1);
  assert.equal(underTicket[0]?.title, 'child1');
  cdb.close();
});

test('listTasks(ready_only): excludes tasks that have an incomplete blocker', () => {
  const cdb = freshDb();
  const blocker = createTask(cdb, { repo: 'app', title: 'blocker' });
  const dependent = createTask(cdb, {
    repo: 'app',
    title: 'dependent',
    dependsOn: [blocker.id],
  }) as typeof blocker;
  const free = createTask(cdb, { repo: 'app', title: 'free' }); // no dependency

  // ready_only: blocker is incomplete so dependent is excluded; blocker and free are ready
  const ready = listTasks(cdb, { readyOnly: true });
  const readyIds = ready.map((t) => t.id).sort();
  assert.deepEqual(readyIds, [blocker.id, free.id].sort(), 'dependent does not appear while the blocker is incomplete');

  // making the blocker done makes dependent ready too
  cdb.db.prepare(`UPDATE tasks SET status='done' WHERE id=?`).run(blocker.id);
  const ready2 = listTasks(cdb, { readyOnly: true });
  assert.ok(ready2.some((t) => t.id === dependent.id), 'dependent becomes ready once the blocker is done');
  cdb.close();
});

test('releaseTask(abandoned): outcome=abandoned becomes the abandoned state and does not appear in open', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);

  const r = releaseTask(cdb, t.id, 'agent-A', 'abandoned');
  assert.equal(r.ok, true);
  assert.equal(getTask(cdb.db, t.id)?.status, 'abandoned');
  assert.equal(getTask(cdb.db, t.id)?.assignee, null);
  // appears in neither the open list nor the ready list
  assert.equal(listTasks(cdb, { status: 'open' }).length, 0);
  assert.equal(listTasks(cdb, { status: 'abandoned' }).length, 1);
  cdb.close();
});

test('releaseTask(default): omitting outcome returns it to open as before', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  assert.equal(releaseTask(cdb, t.id, 'agent-A').ok, true);
  assert.equal(getTask(cdb.db, t.id)?.status, 'open');
  cdb.close();
});

// ──────────────────────────────────────────────────────────────────────────
// blocked state (an interruption waiting for a human decision) — indefinite retention + orphan visualization
// ──────────────────────────────────────────────────────────────────────────

test('blockTask makes in_progress→blocked and preserves assignee/heartbeat_at ((b) claim preservation)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  const before = getTask(cdb.db, t.id)!;
  assert.equal(before.status, 'in_progress');
  assert.ok(before.heartbeat_at && before.heartbeat_at > 0);

  const r = blockTask(cdb, t.id, 'agent-A');
  assert.equal(r.ok, true);
  const after = getTask(cdb.db, t.id)!;
  assert.equal(after.status, 'blocked');
  // unlike release_task/complete_task, assignee and heartbeat_at are preserved
  assert.equal(after.assignee, 'agent-A');
  assert.equal(after.heartbeat_at, before.heartbeat_at);
  assert.equal(after.version, before.version + 1);
  cdb.close();
});

test('blockTask does not transition on an assignee mismatch / non-in_progress (CAS)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  // not possible while still open
  assert.equal(blockTask(cdb, t.id, 'agent-A').ok, false);
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  // a different agent cannot
  assert.equal(blockTask(cdb, t.id, 'agent-B').ok, false);
  assert.equal(getTask(cdb.db, t.id)?.status, 'in_progress');
  // the holder can
  assert.equal(blockTask(cdb, t.id, 'agent-A').ok, true);
  cdb.close();
});

test('blocked is out of scope for the lease sweep = indefinite retention (does not return to open even with lapsed heartbeat)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  assert.ok(blockTask(cdb, t.id, 'agent-A').ok);

  // treat the worker process as dead and the heartbeat fully lapsed, and even sweeping at a future time
  // far beyond the lease (15 min) keeps blocked.
  const farFuture = unixNow() + TASK_LEASE_SEC * 100;
  sweepExpired(cdb, farFuture);
  const after = getTask(cdb.db, t.id)!;
  assert.equal(after.status, 'blocked', 'blocked is not reclaimed by sweep');
  assert.equal(after.assignee, 'agent-A', 'the claim is preserved too');
  cdb.close();
});

test('in_progress returns to open on sweep as before (contrast with blocked / regression prevention)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  const farFuture = unixNow() + TASK_LEASE_SEC * 100;
  sweepExpired(cdb, farFuture);
  assert.equal(getTask(cdb.db, t.id)?.status, 'open');
  assert.equal(getTask(cdb.db, t.id)?.assignee, null);
  cdb.close();
});

test('resumeTask returns blocked→in_progress for the same agent and revives the heartbeat', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  assert.ok(blockTask(cdb, t.id, 'agent-A').ok);

  const r = resumeTask(cdb, t.id, 'agent-A');
  assert.equal(r.ok, true);
  const after = getTask(cdb.db, t.id)!;
  assert.equal(after.status, 'in_progress');
  assert.equal(after.assignee, 'agent-A');
  assert.ok(after.heartbeat_at && after.heartbeat_at > 0);

  // after resuming it goes back under sweep monitoring as a normal in_progress
  const farFuture = unixNow() + TASK_LEASE_SEC * 100;
  sweepExpired(cdb, farFuture);
  assert.equal(getTask(cdb.db, t.id)?.status, 'open');
  cdb.close();
});

test('resumeTask cannot resume for a different agent / non-blocked (CAS. a different worker goes via handoff)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  assert.ok(blockTask(cdb, t.id, 'agent-A').ok);
  // a different agent cannot resume (switching workers is only via a human-explicit handoff)
  assert.equal(resumeTask(cdb, t.id, 'agent-B').ok, false);
  assert.equal(getTask(cdb.db, t.id)?.status, 'blocked');
  // the holder can
  assert.equal(resumeTask(cdb, t.id, 'agent-A').ok, true);
  // trying to resume an in_progress is a no-op (ok:false)
  assert.equal(resumeTask(cdb, t.id, 'agent-A').ok, false);
  cdb.close();
});

test('listBlockedTasks returns only blocked, in updated_at ascending (longest-neglected first)', () => {
  const cdb = freshDb();
  const a = createTask(cdb, { repo: 'app', title: 'a' });
  const b = createTask(cdb, { repo: 'app', title: 'b' });
  const c = createTask(cdb, { repo: 'other', title: 'c' });
  for (const t of [a, b, c]) assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  // block a first (older), then block c a bit later (newer)
  assert.ok(blockTask(cdb, a.id, 'agent-A').ok);
  assert.ok(blockTask(cdb, c.id, 'agent-A').ok);
  // b stays in_progress → does not appear in the list
  const rows = listBlockedTasks(cdb);
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(a.id));
  assert.ok(ids.includes(c.id));
  assert.ok(!ids.includes(b.id), 'in_progress does not appear in the blocked list');
  // repo filter
  assert.deepEqual(
    listBlockedTasks(cdb, { repo: 'other' }).map((r) => r.id),
    [c.id],
  );
  cdb.close();
});

test('list_tasks(status:blocked) orders by priority rather than neglect length, and can filter by assignee / ticket_id / ready_only', () => {
  const cdb = freshDb();
  const ticket = openTicket(cdb, { title: 'T' });
  const low = createTask(cdb, { repo: 'app', title: 'low', priority: 0, ticketId: ticket.id });
  const high = createTask(cdb, { repo: 'app', title: 'high', priority: 10 });
  const other = createTask(cdb, { repo: 'app', title: 'other', priority: 5 });
  assert.ok(claimTask(cdb, low.id, 'agent-A', 0).ok);
  assert.ok(claimTask(cdb, high.id, 'agent-A', 0).ok);
  assert.ok(claimTask(cdb, other.id, 'agent-B', 0).ok);
  for (const t of [low, high, other]) assert.ok(blockTask(cdb, t.id, t === other ? 'agent-B' : 'agent-A').ok);
  // make low the oldest blocked (it would come first by longest-neglected order)
  cdb.db.prepare('UPDATE tasks SET updated_at = updated_at - 100 WHERE id = ?').run(low.id);

  const ids = (args: Parameters<typeof listTasks>[1]) => listTasks(cdb, args).map((t) => t.id);
  assert.deepEqual(ids({ status: 'blocked' }), [high.id, other.id, low.id]);
  assert.deepEqual(
    listBlockedTasks(cdb).map((t) => t.id)[0],
    low.id,
    'listBlockedTasks on its own still defaults to longest-neglected first',
  );
  assert.deepEqual(ids({ status: 'blocked', assignee: 'agent-A' }), [high.id, low.id]);
  assert.deepEqual(ids({ status: 'blocked', ticketId: ticket.id }), [low.id]);

  // low has an incomplete dependency, so it drops out under ready_only
  const dep = createTask(cdb, { repo: 'app', title: 'dep' });
  assert.ok(addDependency(cdb, dep.id, low.id).ok);
  assert.deepEqual(ids({ status: 'blocked', readyOnly: true }), [high.id, other.id]);
  cdb.close();
});

test('listBlockedTasks attaches blocked_age_sec / agent_silent_sec / last_question (orphan visualization)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  // per the worker convention, leave a question first, then block
  postBoard(cdb, {
    agentId: 'agent-A',
    kind: 'question',
    toAgent: 'orchestrator',
    refTaskId: t.id,
    body: 'insufficient permission: need connection info for the production DB',
  });
  assert.ok(blockTask(cdb, t.id, 'agent-A').ok);
  heartbeat(cdb, 'agent-A'); // record last_seen

  const future = unixNow() + 3600; // observe 1 hour later
  const rows = listBlockedTasks(cdb, { now: future });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  // blocked_age_sec is now - updated_at ≒ 3600
  assert.ok(row.blocked_age_sec >= 3600 && row.blocked_age_sec < 3700);
  // agent_silent_sec is now - last_seen ≒ 3600 (the owner's silence)
  assert.ok(row.agent_silent_sec != null && row.agent_silent_sec >= 3600);
  // the reason it got stuck (the latest question) is retrievable
  assert.equal(row.last_question, 'insufficient permission: need connection info for the production DB');
  cdb.close();
});

test('listBlockedTasks: if the assignee has no last_seen, agent_silent_sec is null', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  // claim involves heartbeat (agents upsert), so to make a situation with no agents row, do not go to
  // in_progress directly; go through CAS and then delete the agents row.
  assert.ok(claimTask(cdb, t.id, 'agent-ghost', 0).ok);
  assert.ok(blockTask(cdb, t.id, 'agent-ghost').ok);
  cdb.db.prepare(`DELETE FROM agents WHERE agent_id = ?`).run('agent-ghost');
  const rows = listBlockedTasks(cdb);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.agent_silent_sec, null);
  assert.equal(rows[0]!.last_question, null); // null if no question was posted
  cdb.close();
});

// ──────────────────────────────────────────────────────────────────────────
// handoff_task — handing a blocked task to a different worker (bulk handoff per worktree, D-3)
// ──────────────────────────────────────────────────────────────────────────

/**
 * A helper that prepares the accompanying state of a handoff (worktree_assignments / claims / dirty_sets)
 * without git. assignWorktree creates a real git worktree, so here INSERT DB rows directly to reproduce
 * "agent-A holds the worktree/claim/dirty for a task while it is blocked".
 */
function seedBlockedWithState(
  cdb: ReturnType<typeof freshDb>,
  agent: string,
  repo = 'app',
): { taskId: string; worktreePath: string } {
  const t = createTask(cdb, { repo, title: 'cross-cut work' });
  assert.ok(claimTask(cdb, t.id, agent, 0).ok);
  const now = unixNow();
  const wtPath = `/wt/${repo}-${agent}`;
  cdb.db
    .prepare(
      `INSERT INTO worktree_assignments
         (id, agent_id, worktree_path, branch, task_id, status, created_at, released_at, host_id, origin)
       VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, 'test-host', 'local')`,
    )
    .run(`wt-${agent}`, agent, wtPath, `lockage/${agent}/x`, t.id, now);
  cdb.db
    .prepare(
      `INSERT INTO claims
         (id, holder, globs, task_id, lease_ttl_sec, heartbeat_at, expires_at, created_at, host_id, origin)
       VALUES (?, ?, json(?), ?, 28800, ?, ?, ?, 'test-host', 'local')`,
    )
    .run(`cl-${agent}`, agent, JSON.stringify(['src/**']), t.id, now, now + 28800, now);
  cdb.db
    .prepare(
      `INSERT INTO dirty_sets
         (id, agent_id, worktree_path, files, updated_at, host_id, origin)
       VALUES (?, ?, ?, json(?), ?, 'test-host', 'local')`,
    )
    .run(`ds-${agent}`, agent, wtPath, JSON.stringify(['src/a.ts']), now);
  assert.ok(blockTask(cdb, t.id, agent).ok);
  return { taskId: t.id, worktreePath: wtPath };
}

test('handoffTask hands over a blocked task\'s task/worktree/claim/dirty from A→B in bulk', () => {
  const cdb = freshDb();
  const { taskId, worktreePath } = seedBlockedWithState(cdb, 'agent-A');

  const r = handoffTask(cdb, { taskId, fromAgent: 'agent-A', toAgent: 'agent-B' });
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assert.deepEqual(r.moved, { worktrees: 1, claims: 1, dirty_sets: 1 });
  assert.deepEqual(r.worktrees, [worktreePath]);

  // 1) task: blocked(A) → in_progress(B), heartbeat revived
  const t = getTask(cdb.db, taskId)!;
  assert.equal(t.status, 'in_progress');
  assert.equal(t.assignee, 'agent-B');
  assert.ok(t.heartbeat_at && t.heartbeat_at > 0);

  // 2) the worktree's owner is now B (path/branch unchanged)
  const wt = cdb.db
    .prepare(`SELECT agent_id, worktree_path FROM worktree_assignments WHERE task_id = ? AND status='active'`)
    .get(taskId) as { agent_id: string; worktree_path: string };
  assert.equal(wt.agent_id, 'agent-B');
  assert.equal(wt.worktree_path, worktreePath);

  // 3) the claim's holder is now B
  const cl = cdb.db
    .prepare(`SELECT holder FROM claims WHERE task_id = ? AND released_at IS NULL`)
    .get(taskId) as { holder: string };
  assert.equal(cl.holder, 'agent-B');

  // 4) the dirty_set's agent_id is now B
  const ds = cdb.db
    .prepare(`SELECT agent_id FROM dirty_sets WHERE worktree_path = ?`)
    .get(worktreePath) as { agent_id: string };
  assert.equal(ds.agent_id, 'agent-B');

  // after resuming it is under sweep monitoring as a normal in_progress (B's lapsed heartbeat returns it to open)
  sweepExpired(cdb, unixNow() + TASK_LEASE_SEC * 100);
  assert.equal(getTask(cdb.db, taskId)?.status, 'open');
  cdb.close();
});

test('handoffTask cannot forcibly hand over an in_progress (blocked only / CAS)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  // try handoff while in_progress without blocking
  const r = handoffTask(cdb, { taskId: t.id, fromAgent: 'agent-A', toAgent: 'agent-B' });
  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  assert.equal(r.reason, 'conflict');
  assert.equal(r.current?.assignee, 'agent-A');
  assert.equal(r.current?.status, 'in_progress');
  // nothing moved
  assert.equal(getTask(cdb.db, t.id)?.assignee, 'agent-A');
  cdb.close();
});

test('handoffTask prevents a double handoff (the second time is a from mismatch, conflict, moves nothing)', () => {
  const cdb = freshDb();
  const { taskId } = seedBlockedWithState(cdb, 'agent-A');
  // first time: A→B succeeds
  assert.ok(handoffTask(cdb, { taskId, fromAgent: 'agent-A', toAgent: 'agent-B' }).ok);
  // second time: trying to re-hand over with the same from=A fails because it is already assignee=B and in_progress
  const r2 = handoffTask(cdb, { taskId, fromAgent: 'agent-A', toAgent: 'agent-C' });
  assert.equal(r2.ok, false);
  assert.ok(!r2.ok);
  assert.equal(r2.reason, 'conflict');
  // the owner stays B (not stolen by C)
  assert.equal(getTask(cdb.db, taskId)?.assignee, 'agent-B');
  const cl = cdb.db
    .prepare(`SELECT holder FROM claims WHERE task_id = ? AND released_at IS NULL`)
    .get(taskId) as { holder: string };
  assert.equal(cl.holder, 'agent-B');
  cdb.close();
});

test('handoffTask: a non-existent task is not_found', () => {
  const cdb = freshDb();
  const r = handoffTask(cdb, { taskId: 'nope', fromAgent: 'agent-A', toAgent: 'agent-B' });
  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  assert.equal(r.reason, 'not_found');
  cdb.close();
});

test('handoffTask does not pull in from\'s other task\'s claim/worktree (task_id scope)', () => {
  const cdb = freshDb();
  const { taskId } = seedBlockedWithState(cdb, 'agent-A');
  // prepare a claim/worktree the same agent-A holds for a different task (this is not a handoff target)
  const other = createTask(cdb, { repo: 'app', title: 'other' });
  const now = unixNow();
  cdb.db
    .prepare(
      `INSERT INTO claims
         (id, holder, globs, task_id, lease_ttl_sec, heartbeat_at, expires_at, created_at, host_id, origin)
       VALUES ('cl-other', 'agent-A', json(?), ?, 28800, ?, ?, ?, 'test-host', 'local')`,
    )
    .run(JSON.stringify(['docs/**']), other.id, now, now + 28800, now);
  cdb.db
    .prepare(
      `INSERT INTO worktree_assignments
         (id, agent_id, worktree_path, branch, task_id, status, created_at, released_at, host_id, origin)
       VALUES ('wt-other', 'agent-A', '/wt/other-A', 'lockage/agent-A/other', ?, 'active', ?, NULL, 'test-host', 'local')`,
    )
    .run(other.id, now);

  const r = handoffTask(cdb, { taskId, fromAgent: 'agent-A', toAgent: 'agent-B' });
  assert.ok(r.ok);
  assert.deepEqual(r.moved, { worktrees: 1, claims: 1, dirty_sets: 1 });
  // the other task's claim/worktree stays agent-A (not pulled in)
  assert.equal(
    (cdb.db.prepare(`SELECT holder FROM claims WHERE id='cl-other'`).get() as { holder: string }).holder,
    'agent-A',
  );
  assert.equal(
    (cdb.db.prepare(`SELECT agent_id FROM worktree_assignments WHERE id='wt-other'`).get() as { agent_id: string })
      .agent_id,
    'agent-A',
  );
  cdb.close();
});

// ──────────────────────────────────────────────────────────────────────────
// regression prevention for review findings: heartbeat's touchAgent / dirty_sets debris cleanup
// ──────────────────────────────────────────────────────────────────────────

/** A small helper that reads agents.last_seen_at (null if none). */
function agentLastSeen(cdb: ReturnType<typeof freshDb>, agent: string): number | null {
  const row = cdb.db
    .prepare(`SELECT last_seen_at FROM agents WHERE agent_id = ?`)
    .get(agent) as { last_seen_at: number } | undefined;
  return row ? row.last_seen_at : null;
}

test('HIGH-1: a block_task-equivalent operation (touchAgent=false) does not rejuvenate agents.last_seen', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  // stamp the worker's own liveness once (= from here last_seen should be fixed at this point)
  heartbeat(cdb, 'agent-A');
  const seenAtBlock = agentLastSeen(cdb, 'agent-A');
  assert.ok(seenAtBlock != null);

  // advance time to simulate "an operation by someone other than the owner". With touchAgent=false last_seen does not move.
  const later = seenAtBlock! + 10_000;
  heartbeat(cdb, 'agent-A', { touchAgent: false });
  assert.equal(
    agentLastSeen(cdb, 'agent-A'),
    seenAtBlock,
    'touchAgent=false must not update agents.last_seen (prevents polluting the orphan decision)',
  );
  assert.ok(later > seenAtBlock!); // avoid an unused-warning for later (make the intent explicit)
  cdb.close();
});

test('HIGH-1: touchAgent=false does not extend the claims lease either (tied to the owner\'s liveness)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  const now = unixNow();
  cdb.db
    .prepare(
      `INSERT INTO claims
         (id, holder, globs, task_id, lease_ttl_sec, heartbeat_at, expires_at, created_at, host_id, origin)
       VALUES ('cl1', 'agent-A', json(?), ?, 28800, ?, ?, ?, 'test-host', 'local')`,
    )
    .run(JSON.stringify(['src/**']), t.id, now, now + 28800, now);
  const before = cdb.db
    .prepare(`SELECT expires_at FROM claims WHERE id='cl1'`)
    .get() as { expires_at: number };

  heartbeat(cdb, 'agent-A', { touchAgent: false });
  const after = cdb.db
    .prepare(`SELECT expires_at FROM claims WHERE id='cl1'`)
    .get() as { expires_at: number };
  assert.equal(after.expires_at, before.expires_at, 'touchAgent=false does not extend the lease');
  cdb.close();
});

test('touchAgent default (true) updates agents.last_seen and the claims lease as before (backward compatible)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);
  heartbeat(cdb, 'agent-A'); // default call
  assert.ok(agentLastSeen(cdb, 'agent-A') != null, 'by default last_seen is stamped');
  // the string third argument (backward compatible = { taskId }) also works as before
  heartbeat(cdb, 'agent-A', t.id);
  const hb = getTask(cdb.db, t.id)?.heartbeat_at;
  assert.ok(hb != null, 'a string taskId updates the task\'s heartbeat_at');
  cdb.close();
});

test('MEDIUM-2: even after a handoff, to_agent\'s last_seen stays un-started (an operation does not count as alive)', () => {
  const cdb = freshDb();
  const { taskId } = seedBlockedWithState(cdb, 'agent-A');
  // handoff-handler equivalent: heartbeat to_agent with touchAgent=false, then reassign
  heartbeat(cdb, 'agent-B', { touchAgent: false });
  const r = handoffTask(cdb, { taskId, fromAgent: 'agent-A', toAgent: 'agent-B' });
  assert.ok(r.ok);
  // to_agent (agent-B) has not yet started a worker process → last_seen stays absent
  assert.equal(
    agentLastSeen(cdb, 'agent-B'),
    null,
    'a handoff operation must not count to_agent as alive (it would delay orphan detection)',
  );
  cdb.close();
});

test('MEDIUM-3: even if to_agent has an old dirty_set for the same worktree, the handoff does not collide and overwrites in handover', () => {
  const cdb = freshDb();
  const { taskId, worktreePath } = seedBlockedWithState(cdb, 'agent-A');
  // §4.5 reconnect history: create a situation where B left a dirty_set for the same worktree_path in the past
  const now = unixNow();
  cdb.db
    .prepare(
      `INSERT INTO dirty_sets
         (id, agent_id, worktree_path, files, updated_at, host_id, origin)
       VALUES ('ds-B-stale', 'agent-B', ?, json(?), ?, 'test-host', 'local')`,
    )
    .run(worktreePath, JSON.stringify(['old/stale.ts']), now - 10_000);

  // without cleanup, the UPDATE would collide on the UNIQUE (agent-B, worktreePath) → used to rollback everything on an exception.
  const r = handoffTask(cdb, { taskId, fromAgent: 'agent-A', toAgent: 'agent-B' });
  assert.ok(r.ok, 'the handoff succeeds without throwing');
  assert.deepEqual(r.moved, { worktrees: 1, claims: 1, dirty_sets: 1 });

  // only one dirty_set row for the same worktree (B's debris is cleaned up and A's row moved to B)
  const rows = cdb.db
    .prepare(`SELECT agent_id, files FROM dirty_sets WHERE worktree_path = ?`)
    .all(worktreePath) as Array<{ agent_id: string; files: string }>;
  assert.equal(rows.length, 1, 'B\'s old dirty_set is cleaned up and not duplicated');
  assert.equal(rows[0]!.agent_id, 'agent-B');
  assert.match(rows[0]!.files, /src\/a\.ts/, 'the latest dirty_set A published remains (not the old stale)');
  cdb.close();
});

test('MEDIUM-3: the handoff does not delete to_agent\'s unrelated worktree dirty_set', () => {
  const cdb = freshDb();
  const { taskId } = seedBlockedWithState(cdb, 'agent-A');
  // a dirty_set B holds for a different worktree is not a handoff target → should be preserved
  const now = unixNow();
  cdb.db
    .prepare(
      `INSERT INTO dirty_sets
         (id, agent_id, worktree_path, files, updated_at, host_id, origin)
       VALUES ('ds-B-unrelated', 'agent-B', '/wt/unrelated-B', json(?), ?, 'test-host', 'local')`,
    )
    .run(JSON.stringify(['other/x.ts']), now);

  assert.ok(handoffTask(cdb, { taskId, fromAgent: 'agent-A', toAgent: 'agent-B' }).ok);
  const kept = cdb.db
    .prepare(`SELECT 1 FROM dirty_sets WHERE id = 'ds-B-unrelated'`)
    .get();
  assert.ok(kept, 'B\'s unrelated worktree dirty_set is preserved');
  cdb.close();
});

// ──────────────────────────────────────────────────────────────────────────
// 1A — automatic parent-ticket open→in_progress transition on claim (the new FEAT-002 behavior)
//   spec: once even one task under a ticket is claimed, make the parent ticket in_progress.
//   a one-way CAS that does not bump version (WHERE status='open'); if already in_progress/closed, do not touch.
//   does nothing for a task with null ticket_id. does not re-open automatically (2A).
// ──────────────────────────────────────────────────────────────────────────

test('claim: claiming a task with a ticket_id makes the parent ticket open→in_progress (version kept)', () => {
  const cdb = freshDb();
  // the parent ticket is just opened, so status=open, version=0.
  const ticket = openTicket(cdb, { title: 'parent' });
  assert.equal(getTicket(cdb, ticket.id)?.status, 'open');
  assert.equal(getTicket(cdb, ticket.id)?.version, 0);

  // create a task with a ticket_id and claim it.
  const t = createTask(cdb, { repo: 'app', title: 'child', ticketId: ticket.id });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok, 'the claim succeeds');

  // as a side effect of the claim the parent ticket flips to in_progress, with version still 0 (system op = version unchanged).
  const after = getTicket(cdb, ticket.id)!;
  assert.equal(after.status, 'in_progress', 'the claim makes the parent ticket in_progress');
  assert.equal(after.version, 0, 'the claim-linked status transition does not bump version (no interference with user edits)');
  cdb.close();
});

test('claim: for a task with null ticket_id nothing happens (no exception and the ticket table stays empty)', () => {
  const cdb = freshDb();
  // a minor task not linked to a ticket (ticket_id=null).
  const t = createTask(cdb, { repo: 'app', title: 'standalone' });
  assert.equal(getTask(cdb.db, t.id)?.ticket_id, null);

  // the claim succeeds without an exception and the ticket table stays 0 rows (no ticket transition target).
  const r = claimTask(cdb, t.id, 'agent-A', 0);
  assert.ok(r.ok, 'the claim succeeds even with ticket_id=null');
  assert.equal(listTickets(cdb).length, 0, 'not a single ticket is created / touched');
  cdb.close();
});

test('claim: if the parent ticket is already in_progress it is idempotent (status and version kept)', () => {
  const cdb = freshDb();
  const ticket = openTicket(cdb, { title: 'parent' });
  // flip to in_progress first via the user-edit path (update_ticket) (version→1).
  const u = updateTicket(cdb, { ticketId: ticket.id, expectedVersion: 0, status: 'in_progress' });
  assert.ok(u.ok);
  assert.equal(getTicket(cdb, ticket.id)?.status, 'in_progress');
  assert.equal(getTicket(cdb, ticket.id)?.version, 1);

  // claiming a task under it does not touch the ticket because it falls outside WHERE status='open'.
  const t = createTask(cdb, { repo: 'app', title: 'child', ticketId: ticket.id });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);

  const after = getTicket(cdb, ticket.id)!;
  assert.equal(after.status, 'in_progress', 'stays in_progress unchanged (idempotent)');
  assert.equal(after.version, 1, 'the claim does not bump version (stays at the 1 set by update_ticket)');
  cdb.close();
});

test('claim: if the parent ticket is closed, do not touch it (open→in_progress one-way only)', () => {
  const cdb = freshDb();
  const ticket = openTicket(cdb, { title: 'parent' });
  // flip to closed via the merge path (closeTicketOnMerge does not bump version).
  assert.deepEqual(closeTicketOnMerge(cdb, ticket.id), { ok: true, closed: true });
  const closed = getTicket(cdb, ticket.id)!;
  assert.equal(closed.status, 'closed');

  // claiming a task under a closed ticket keeps it closed because it falls outside WHERE status='open'.
  const t = createTask(cdb, { repo: 'app', title: 'child', ticketId: ticket.id });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);

  const after = getTicket(cdb, ticket.id)!;
  assert.equal(after.status, 'closed', 'closed does not return to in_progress on claim (one-way)');
  assert.equal(after.version, closed.version, 'stays closed with version also kept');
  cdb.close();
});

test('claim: claiming 2 tasks under the same ticket in sequence makes the parent in_progress exactly once and is a no-op thereafter (idempotent)', () => {
  const cdb = freshDb();
  const ticket = openTicket(cdb, { title: 'parent' });
  const t1 = createTask(cdb, { repo: 'app', title: 'child1', ticketId: ticket.id });
  const t2 = createTask(cdb, { repo: 'app', title: 'child2', ticketId: ticket.id });

  // the first claim does open→in_progress (version kept).
  assert.ok(claimTask(cdb, t1.id, 'agent-A', 0).ok);
  const afterFirst = getTicket(cdb, ticket.id)!;
  assert.equal(afterFirst.status, 'in_progress');
  assert.equal(afterFirst.version, 0);

  // the second claim is a no-op because it is already in_progress (neither status nor version changes).
  assert.ok(claimTask(cdb, t2.id, 'agent-B', 0).ok);
  const afterSecond = getTicket(cdb, ticket.id)!;
  assert.equal(afterSecond.status, 'in_progress', 'still in_progress after the second claim');
  assert.equal(afterSecond.version, afterFirst.version, 'the second claim does not bump version (idempotent)');
  cdb.close();
});

// ──────────────────────────────────────────────────────────────────────────
// Issue #51 — a piggyback heartbeat (no taskId) extends the lease of an owned in_progress task.
//   Verify that the heartbeat(cdb, agentId) that runs at the start of every tool call alone keeps the
//   task lease alive, and that the sweepExpired at the start of a different agent's call does not wrongly
//   return it to open. Time is simulated with the existing pattern (UPDATE heartbeat_at directly to the
//   past / sweepExpired(cdb, future now)).
// ──────────────────────────────────────────────────────────────────────────

test('Issue #51: a piggyback heartbeat with no taskId extends the lease of an owned in_progress task', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);

  // treat the heartbeat as lapsed right after claim, and tip it to a past just before the lease edge (= not yet a sweep target).
  // in this state, calling a heartbeat equivalent to a piggyback without taskId should rejuvenate the lease to now.
  const now = unixNow();
  cdb.db
    .prepare('UPDATE tasks SET heartbeat_at = ? WHERE id = ?')
    .run(now - TASK_LEASE_SEC + 60, t.id);

  // equivalent to the piggyback a publish_dirty etc. handler does: the default call without a taskId.
  heartbeat(cdb, 'agent-A');
  const hb = getTask(cdb.db, t.id)!.heartbeat_at!;
  assert.ok(hb >= now - 1, 'the piggyback rejuvenates heartbeat_at to around now');

  // immediately after, even running a sweep (assumed to run at the start of a different agent's tool call)
  // at a future less than the lease does not return it to open. Observe at 10 minutes, shorter than the lease (15 min).
  sweepExpired(cdb, now + TASK_LEASE_SEC - 300);
  const after = getTask(cdb.db, t.id)!;
  assert.equal(after.status, 'in_progress', 'with an interval less than the lease it does not return to open');
  assert.equal(after.assignee, 'agent-A', 'the assignee is preserved too');
  cdb.close();
});

test('Issue #51: as long as the piggyback repeats at an interval less than the lease, the task does not return to open (integration scenario)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);

  // reproduce the scenario of "never call the heartbeat tool (with taskId); keep it alive only with the
  // piggyback of publish_dirty etc." with direct heartbeat()+sweepExpired() calls. There is no need to
  // start the index.ts handlers; the equivalent is verifiable with the same function call the handler
  // makes (heartbeat without taskId).
  //
  // run a few cycles of "piggyback heartbeat → sweep" at an interval less than the lease (here 10 min).
  // time is faked by tipping heartbeat_at directly into the past.
  const step = TASK_LEASE_SEC - 300; // 10 min (< 15 min lease)
  for (let i = 1; i <= 3; i++) {
    // reproduce the elapsed time since the previous cycle: tip heartbeat_at into the past by step seconds.
    const hbRow = getTask(cdb.db, t.id)!.heartbeat_at!;
    cdb.db
      .prepare('UPDATE tasks SET heartbeat_at = ? WHERE id = ?')
      .run(hbRow - step, t.id);
    // extend the lease via the piggyback of publish_dirty etc. (no taskId).
    heartbeat(cdb, 'agent-A');
    // the sweep that runs at the start of a different agent's tool call. less than the lease, so should not be reclaimed.
    sweepExpired(cdb);
    assert.equal(
      getTask(cdb.db, t.id)!.status,
      'in_progress',
      `cycle ${i}: while kept alive by the piggyback, in_progress is maintained`,
    );
  }
  cdb.close();
});

test('Issue #51: a piggyback heartbeat does not extend others\' in_progress tasks or blocked tasks (regression prevention)', () => {
  const cdb = freshDb();
  // agent-A's in_progress task (the target to extend)
  const own = createTask(cdb, { repo: 'app', title: 'own' });
  assert.ok(claimTask(cdb, own.id, 'agent-A', 0).ok);
  // agent-B's in_progress task (a different agent = not a target)
  const other = createTask(cdb, { repo: 'app', title: 'other' });
  assert.ok(claimTask(cdb, other.id, 'agent-B', 0).ok);
  // agent-A's blocked task (indefinite retention = not a target)
  const blocked = createTask(cdb, { repo: 'app', title: 'blocked' });
  assert.ok(claimTask(cdb, blocked.id, 'agent-A', 0).ok);
  assert.ok(blockTask(cdb, blocked.id, 'agent-A').ok);

  // line up heartbeat_at of all 3 to a known past value (so we can compare whether it extended).
  const past = unixNow() - 10_000;
  for (const id of [own.id, other.id, blocked.id]) {
    cdb.db.prepare('UPDATE tasks SET heartbeat_at = ? WHERE id = ?').run(past, id);
  }

  // agent-A's piggyback heartbeat with no taskId.
  const before = unixNow();
  heartbeat(cdb, 'agent-A');

  // only own (agent-A's in_progress) rejuvenates to around now.
  assert.ok(getTask(cdb.db, own.id)!.heartbeat_at! >= before - 1, 'own is extended');
  // a different agent's in_progress is kept.
  assert.equal(getTask(cdb.db, other.id)!.heartbeat_at, past, 'a different agent\'s in_progress is not extended');
  // blocked is kept (out of sweep scope, so not touched).
  assert.equal(getTask(cdb.db, blocked.id)!.heartbeat_at, past, 'blocked is not extended');
  cdb.close();
});

test('Issue #51: touchAgent=false (an operation by someone other than the owner) does not extend an owned in_progress task\'s lease (regression prevention)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'app', title: 'x' });
  assert.ok(claimTask(cdb, t.id, 'agent-A', 0).ok);

  // tip heartbeat_at to a known past value.
  const past = unixNow() - 10_000;
  cdb.db.prepare('UPDATE tasks SET heartbeat_at = ? WHERE id = ?').run(past, t.id);

  // block_task/resume_task/handoff_task equivalent: touchAgent=false. touchOwnedTasks' default is tied to
  // touchAgent, so the task lease is not rejuvenated (to avoid polluting the orphan decision of blocked tasks).
  heartbeat(cdb, 'agent-A', { touchAgent: false });
  assert.equal(
    getTask(cdb.db, t.id)!.heartbeat_at,
    past,
    'with touchAgent=false the owned task\'s heartbeat_at is not extended',
  );
  cdb.close();
});
