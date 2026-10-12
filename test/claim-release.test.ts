import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, unixNow, type CoordDb } from '../src/db/index.ts';
import {
  claimFiles,
  listClaims,
  releaseClaimsForTask,
  releaseClaimsForFinishedTicketTasks,
} from '../src/lockage/files.ts';
import {
  createTask,
  claimTask,
  completeTask,
  releaseTask,
  heartbeat,
} from '../src/lockage/claim.ts';
import { openTicket } from '../src/lockage/tickets.ts';

/**
 * Issue #45: unit tests for the series of fixes that release claims declared with claim_files at "the end
 * of a task". Using an in-memory DB (openDb({path:':memory:'})), hit the pure functions of claim.ts /
 * files.ts directly to verify the four acceptance conditions. Each test fails if the corresponding
 * production fix is reverted.
 */

function freshDb(): CoordDb {
  return openDb({ path: ':memory:', hostId: 'test-host' });
}

/** Place one claim and return the claim_id (with a task_id link). */
function claimForTask(cdb: CoordDb, agent: string, globs: string[], taskId: string): string {
  return claimFiles(cdb, { agentId: agent, globs, taskId }).claim_id;
}

/** Read the current expires_at of the given claim (regardless of active/released). */
function expiresAt(cdb: CoordDb, claimId: string): number {
  const row = cdb.db
    .prepare(`SELECT expires_at FROM claims WHERE id = ?`)
    .get(claimId) as { expires_at: number } | undefined;
  assert.ok(row, `claim ${claimId} exists`);
  return row!.expires_at;
}

// ── acceptance condition 1: task_done (completion) makes that task's claim disappear from list_claims ──

test('releaseClaimsForTask: a completed task\'s claim is released and does not appear in list_claims', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'repo', title: 'T' });
  claimTask(cdb, t.id, 'A', t.version);
  claimForTask(cdb, 'A', ['src/**'], t.id);
  assert.equal(listClaims(cdb, 'A').length, 1, 'before completion the claim is active');

  // task_done equivalent (same as what finalizeMergedTask calls after completeTask succeeds).
  const done = completeTask(cdb, t.id, 'A');
  assert.equal(done.ok, true);
  const rel = releaseClaimsForTask(cdb, t.id);

  assert.equal(rel.released_count, 1, 'released 1 claim of that task');
  assert.equal(listClaims(cdb, 'A').length, 0, 'after release it does not appear in list_claims');
});

// ── acceptance condition 2: a claim of a different task by the same agent is not released ──

test('releaseClaimsForTask: does not release a claim of a different task held by the same agent', () => {
  const cdb = freshDb();
  const t1 = createTask(cdb, { repo: 'repo', title: 'T1' });
  const t2 = createTask(cdb, { repo: 'repo', title: 'T2' });
  claimTask(cdb, t1.id, 'A', t1.version);
  claimTask(cdb, t2.id, 'A', t2.version);
  claimForTask(cdb, 'A', ['src/t1/**'], t1.id);
  claimForTask(cdb, 'A', ['src/t2/**'], t2.id);

  // complete and release only t1.
  releaseClaimsForTask(cdb, t1.id);

  const remaining = listClaims(cdb, 'A');
  assert.equal(remaining.length, 1, 'the claim of the other task (t2) remains');
  assert.equal(remaining[0].task_id, t2.id, 'what remained is t2\'s claim');
});

test('releaseClaimsForTask: releases by task_id match regardless of holder (not missed even after a handoff)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'repo', title: 'T' });
  // reproduce a claim whose holder became a different agent via handoff (only task_id matches).
  claimForTask(cdb, 'B', ['src/**'], t.id);
  assert.equal(listClaims(cdb, 'B').length, 1);

  const rel = releaseClaimsForTask(cdb, t.id);
  assert.equal(rel.released_count, 1, 'releases by task_id match even if the holder is B');
  assert.equal(listClaims(cdb, 'B').length, 0);
});

// ── acceptance condition (additional): release_task releases that claim (both open / abandoned) ──

test('release_task(open return): letting go of the task also releases its claim', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'repo', title: 'T' });
  claimTask(cdb, t.id, 'A', t.version);
  claimForTask(cdb, 'A', ['src/**'], t.id);

  const r = releaseTask(cdb, t.id, 'A', 'open');
  assert.equal(r.ok, true);
  assert.equal(listClaims(cdb, 'A').length, 0, 'an open return also releases the claim');
});

test('release_task(abandoned): the claim is released on abort too', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'repo', title: 'T' });
  claimTask(cdb, t.id, 'A', t.version);
  claimForTask(cdb, 'A', ['src/**'], t.id);

  const r = releaseTask(cdb, t.id, 'A', 'abandoned');
  assert.equal(r.ok, true);
  assert.equal(listClaims(cdb, 'A').length, 0, 'the claim is released on abandoned too');
});

test('release_task: on a CAS mismatch (different agent) the claim is not released', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'repo', title: 'T' });
  claimTask(cdb, t.id, 'A', t.version);
  claimForTask(cdb, 'A', ['src/**'], t.id);

  // if non-holder B calls release_task, the task UPDATE is changes==0 → does not touch the claim either.
  const r = releaseTask(cdb, t.id, 'B', 'open');
  assert.equal(r.ok, false);
  assert.equal(listClaims(cdb, 'A').length, 1, 'does not release the claim on a CAS mismatch');
});

// ── acceptance condition 3: reconcile releases leftovers tied to done tasks ──

test('releaseClaimsForFinishedTicketTasks: releases leftover claims of done tasks', () => {
  const cdb = freshDb();
  const ticket = openTicket(cdb, { title: 'ticket', body: null });
  const t = createTask(cdb, { repo: 'repo', title: 'T', ticketId: ticket.id });
  claimTask(cdb, t.id, 'A', t.version);
  claimForTask(cdb, 'A', ['src/**'], t.id);
  // reproduce a situation where it became done without going through task_done (a leftover).
  completeTask(cdb, t.id, 'A');
  assert.equal(listClaims(cdb).length, 1, 'even when done, the claim remains if not via task_done');

  const rel = releaseClaimsForFinishedTicketTasks(cdb, { ticketId: ticket.id });
  assert.equal(rel.released_count, 1, 'reclaimed 1 leftover via the reconcile path');
  assert.equal(listClaims(cdb).length, 0, 'after reclaim there is no active claim');
});

test('releaseClaimsForFinishedTicketTasks: preserves claims of not-done (in_progress) tasks', () => {
  const cdb = freshDb();
  const ticket = openTicket(cdb, { title: 'ticket', body: null });
  const done = createTask(cdb, { repo: 'repo', title: 'done', ticketId: ticket.id });
  const live = createTask(cdb, { repo: 'repo', title: 'live', ticketId: ticket.id });
  claimTask(cdb, done.id, 'A', done.version);
  claimTask(cdb, live.id, 'A', live.version);
  claimForTask(cdb, 'A', ['src/done/**'], done.id);
  claimForTask(cdb, 'A', ['src/live/**'], live.id);
  completeTask(cdb, done.id, 'A'); // complete only done, live stays in_progress

  const rel = releaseClaimsForFinishedTicketTasks(cdb, { ticketId: ticket.id });
  assert.equal(rel.released_count, 1, 'releases only the done task\'s claim');
  const remaining = listClaims(cdb);
  assert.equal(remaining.length, 1, 'the in_progress task\'s claim remains');
  assert.equal(remaining[0].task_id, live.id);
});

test('releaseClaimsForFinishedTicketTasks: reclaims an abandoned task\'s claim too', () => {
  const cdb = freshDb();
  const ticket = openTicket(cdb, { title: 'ticket', body: null });
  const t = createTask(cdb, { repo: 'repo', title: 'T', ticketId: ticket.id });
  // build directly a situation where it is abandoned but a claim remains (releaseTask also clears the
  // claim, so here set the task to abandoned first and then place a task_id-linked claim).
  cdb.db
    .prepare(`UPDATE tasks SET status = 'abandoned' WHERE id = ?`)
    .run(t.id);
  claimForTask(cdb, 'A', ['src/**'], t.id);

  const rel = releaseClaimsForFinishedTicketTasks(cdb, { ticketId: ticket.id });
  assert.equal(rel.released_count, 1, 'an abandoned task\'s claim is also a target');
  assert.equal(listClaims(cdb).length, 0);
});

// ── acceptance condition 4: heartbeat does not extend expires_at of a done task's claim ──

test('heartbeat: does not extend expires_at of a done task\'s claim (Issue #45 item 4)', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'repo', title: 'T' });
  claimTask(cdb, t.id, 'A', t.version);
  const claimId = claimForTask(cdb, 'A', ['src/**'], t.id);

  // set the task done (production goes via task_done, but here reproduce only the state).
  completeTask(cdb, t.id, 'A');

  // rewind to a past time so the "no extension" of expires_at is observable. Without rewinding, heartbeat
  // recomputes expires_at at the same now seconds and the value does not change even in the old impl, so
  // no difference shows.
  const past = unixNow() - 1000;
  cdb.db
    .prepare(`UPDATE claims SET heartbeat_at = ?, expires_at = ? WHERE id = ?`)
    .run(past, past, claimId);
  const before = expiresAt(cdb, claimId);

  // even if the same agent keeps doing other work and keeps sending heartbeats, a done task's claim is not extended.
  heartbeat(cdb, 'A');
  heartbeat(cdb, 'A');
  const after = expiresAt(cdb, claimId);
  assert.equal(after, before, 'a done task\'s claim expires_at is not extended');
});

test('heartbeat: an in_progress task\'s claim is extended as before', () => {
  const cdb = freshDb();
  const t = createTask(cdb, { repo: 'repo', title: 'T' });
  claimTask(cdb, t.id, 'A', t.version);
  const claimId = claimForTask(cdb, 'A', ['src/**'], t.id);

  // rewind to a past time so the change in expires_at is observable.
  const past = unixNow() - 1000;
  cdb.db
    .prepare(`UPDATE claims SET heartbeat_at = ?, expires_at = ? WHERE id = ?`)
    .run(past, past, claimId);
  const before = expiresAt(cdb, claimId);

  heartbeat(cdb, 'A');
  const after = expiresAt(cdb, claimId);
  assert.ok(after > before, 'an in_progress task\'s claim has its lease extended');
});

test('heartbeat: a claim with NULL task_id is extended as before', () => {
  const cdb = freshDb();
  // a claim with no task_id (a declaration not tied to a task).
  const claimId = claimFiles(cdb, { agentId: 'A', globs: ['docs/**'] }).claim_id;

  const past = unixNow() - 1000;
  cdb.db
    .prepare(`UPDATE claims SET heartbeat_at = ?, expires_at = ? WHERE id = ?`)
    .run(past, past, claimId);
  const before = expiresAt(cdb, claimId);

  heartbeat(cdb, 'A');
  const after = expiresAt(cdb, claimId);
  assert.ok(after > before, 'a claim with NULL task_id is extended as before');
});
