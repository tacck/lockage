import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.ts';
import { computePublisherStatus, readBoard } from '../src/lockage/board.ts';
import { createTask, getTask, claimTask } from '../src/lockage/claim.ts';
import {
  openTicket,
  updateTicket,
  listTickets,
  linkTaskToTicket,
  getTicket,
  ticketRepos,
  clearIntegrationBranch,
  closeTicketOnMerge,
  markTicketInProgressOnClaim,
} from '../src/lockage/tickets.ts';

function freshDb() {
  return openDb({ path: ':memory:', hostId: 'test-host' });
}

test('open_ticket: omitting repos is cross-cutting (no ticket_repos rows)', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: 'overall policy' });
  assert.equal(i.status, 'open');
  assert.equal(i.version, 0);
  assert.deepEqual(ticketRepos(cdb, i.id), [], 'cross-cutting has no repo rows');
  cdb.close();
});

test('open_ticket: specifying repos inserts join rows (duplicates ignored)', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: 'cross', repos: ['app', 'lib', 'app'] });
  assert.deepEqual(ticketRepos(cdb, i.id), ['app', 'lib']);
  cdb.close();
});

test('list_tickets(repo): returns both tickets that have that repo and cross-cutting ones (D-1 query convention)', () => {
  const cdb = freshDb();
  const crossCutting = openTicket(cdb, { title: 'cross-cutting' }); // no repo rows
  const appTicket = openTicket(cdb, { title: 'app-only', repos: ['app'] });
  openTicket(cdb, { title: 'lib-only', repos: ['lib'] }); // should not appear for app

  const forApp = listTickets(cdb, { repo: 'app' });
  const ids = forApp.map((i) => i.id).sort();
  assert.deepEqual(
    ids,
    [crossCutting.id, appTicket.id].sort(),
    'app shows app-only + cross-cutting (lib-only does not appear)',
  );
  cdb.close();
});

test('list_tickets(query): can full-text search the body via FTS5', () => {
  const cdb = freshDb();
  openTicket(cdb, { title: 'login rework', body: 'fix the OAuth token refresh' });
  openTicket(cdb, { title: 'UI tweak', body: 'change the button color' });

  const hits = listTickets(cdb, { query: 'OAuth' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.title, 'login rework');
  cdb.close();
});

test('list_tickets(status): can filter by status', () => {
  const cdb = freshDb();
  const a = openTicket(cdb, { title: 'a' });
  openTicket(cdb, { title: 'b' });
  updateTicket(cdb, { ticketId: a.id, expectedVersion: 0, status: 'closed' });

  const open = listTickets(cdb, { status: 'open' });
  assert.equal(open.length, 1);
  assert.equal(open[0]?.title, 'b');
  cdb.close();
});

test('update_ticket: partial update with version-CAS, version+1', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: 'x', body: 'old' });
  const r = updateTicket(cdb, {
    ticketId: i.id,
    expectedVersion: 0,
    status: 'in_progress',
    body: 'new',
  });
  assert.ok(r.ok);
  assert.equal(r.ok && r.ticket.status, 'in_progress');
  assert.equal(r.ok && r.ticket.body, 'new');
  assert.equal(r.ok && r.ticket.version, 1);
  cdb.close();
});

test('update_ticket: a version mismatch is conflict (returns the current value)', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: 'x' });
  updateTicket(cdb, { ticketId: i.id, expectedVersion: 0, status: 'in_progress' }); // version→1
  const stale = updateTicket(cdb, { ticketId: i.id, expectedVersion: 0, status: 'closed' });
  assert.ok(!stale.ok && stale.reason === 'conflict');
  assert.equal(stale.ok === false && stale.current?.version, 1);
  // the conflicting side's change did not go in
  assert.equal(getTicket(cdb, i.id)?.status, 'in_progress');
  cdb.close();
});

test('update_ticket: a non-existent ticket is not_found', () => {
  const cdb = freshDb();
  const r = updateTicket(cdb, { ticketId: 'NOPE', expectedVersion: 0, status: 'closed' });
  assert.ok(!r.ok && r.reason === 'not_found');
  cdb.close();
});

test('update_ticket: the FTS5 index follows a body update', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: 't', body: 'alpha' });
  assert.equal(listTickets(cdb, { query: 'alpha' }).length, 1);
  updateTicket(cdb, { ticketId: i.id, expectedVersion: 0, body: 'beta' });
  // the old term does not hit, the new term hits (trigger sync)
  assert.equal(listTickets(cdb, { query: 'alpha' }).length, 0);
  assert.equal(listTickets(cdb, { query: 'beta' }).length, 1);
  cdb.close();
});

test('link_task_to_ticket: link and unlink', () => {
  const cdb = freshDb();
  const ticket = openTicket(cdb, { title: 'parent' });
  const task = createTask(cdb, { repo: 'app', title: 'child' });
  assert.equal(getTask(cdb.db, task.id)?.ticket_id, null);

  const linked = linkTaskToTicket(cdb, task.id, ticket.id);
  assert.equal(linked.ok, true);
  assert.equal(getTask(cdb.db, task.id)?.ticket_id, ticket.id);

  const unlinked = linkTaskToTicket(cdb, task.id, null);
  assert.equal(unlinked.ok, true);
  assert.equal(getTask(cdb.db, task.id)?.ticket_id, null);
  cdb.close();
});

test('link_task_to_ticket: a non-existent task/ticket is rejected', () => {
  const cdb = freshDb();
  const task = createTask(cdb, { repo: 'app', title: 't' });
  const r1 = linkTaskToTicket(cdb, 'NOPE', null);
  assert.ok(!r1.ok && r1.reason === 'task_not_found');
  const r2 = linkTaskToTicket(cdb, task.id, 'NOPE');
  assert.ok(!r2.ok && r2.reason === 'ticket_not_found');
  cdb.close();
});

// ── automatic transition on a late link in link_task_to_ticket (1A / symmetric with claimTask) ──────────────

test('link_task_to_ticket: late-linking an in_progress task to an open ticket does open→in_progress (version unchanged)', () => {
  const cdb = freshDb();
  const ticket = openTicket(cdb, { title: 'late-link target' });
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.version, 0);
  // create a task not linked to a ticket and claim it (= in_progress).
  const task = createTask(cdb, { repo: 'app', title: 'claimed first' });
  const claimed = claimTask(cdb, task.id, 'agent-1', task.version);
  assert.equal(claimed.ok, true);
  assert.equal(getTask(cdb.db, task.id)?.status, 'in_progress');
  // the ticket is still open (not transitioned because it was unlinked at claim time).
  assert.equal(getTicket(cdb, ticket.id)?.status, 'open');

  const linked = linkTaskToTicket(cdb, task.id, ticket.id);
  assert.equal(linked.ok, true);
  const after = getTicket(cdb, ticket.id)!;
  assert.equal(after.status, 'in_progress', 'a late link transitions the parent ticket to in_progress');
  assert.equal(after.version, 0, 'the automatic transition does not bump version (system op / D-B1)');
  cdb.close();
});

test('link_task_to_ticket: late-linking an open (unclaimed) task keeps the ticket open', () => {
  const cdb = freshDb();
  const ticket = openTicket(cdb, { title: 'stays open' });
  const task = createTask(cdb, { repo: 'app', title: 'unclaimed' });
  assert.equal(getTask(cdb.db, task.id)?.status, 'open');

  const linked = linkTaskToTicket(cdb, task.id, ticket.id);
  assert.equal(linked.ok, true);
  const after = getTicket(cdb, ticket.id)!;
  assert.equal(after.status, 'open', 'does not transition for a non-in_progress task (symmetric with claimTask)');
  assert.equal(after.version, 0, 'version is kept too');
  cdb.close();
});

test('link_task_to_ticket: late-linking an in_progress task to a closed ticket keeps it closed (one-way)', () => {
  const cdb = freshDb();
  const ticket = openTicket(cdb, { title: 'already closed' });
  assert.deepEqual(closeTicketOnMerge(cdb, ticket.id), { ok: true, closed: true });
  const closed = getTicket(cdb, ticket.id)!;
  assert.equal(closed.status, 'closed');

  const task = createTask(cdb, { repo: 'app', title: 'claimed' });
  const claimed = claimTask(cdb, task.id, 'agent-1', task.version);
  assert.equal(claimed.ok, true);

  const linked = linkTaskToTicket(cdb, task.id, ticket.id);
  assert.equal(linked.ok, true);
  const after = getTicket(cdb, ticket.id)!;
  assert.equal(after.status, 'closed', 'closed does not return to in_progress (open→in_progress one-way)');
  assert.equal(after.version, closed.version, 'version is kept too');
  cdb.close();
});

test('link_task_to_ticket: unlinking with ticket_id=null does not interfere with the ticket', () => {
  const cdb = freshDb();
  const ticket = openTicket(cdb, { title: 'parent to unlink' });
  // link an in_progress task once (the ticket becomes in_progress here).
  const task = createTask(cdb, { repo: 'app', title: 'claimed' });
  assert.equal(claimTask(cdb, task.id, 'agent-1', task.version).ok, true);
  assert.equal(linkTaskToTicket(cdb, task.id, ticket.id).ok, true);
  const linked = getTicket(cdb, ticket.id)!;
  assert.equal(linked.status, 'in_progress');

  // prepare another open ticket and confirm its state does not change on the unlink operation.
  const other = openTicket(cdb, { title: 'unrelated open' });

  // unlink with ticket_id=null. does not interfere with the parent ticket (in_progress) nor the other ticket (open).
  const unlinked = linkTaskToTicket(cdb, task.id, null);
  assert.equal(unlinked.ok, true);
  assert.equal(getTask(cdb.db, task.id)?.ticket_id, null, 'the task is unlinked');
  const afterParent = getTicket(cdb, ticket.id)!;
  assert.equal(afterParent.status, 'in_progress', 'unlinking does not revert the parent ticket\'s status');
  assert.equal(afterParent.version, linked.version, 'the parent ticket\'s version is kept too');
  assert.equal(getTicket(cdb, other.id)?.status, 'open', 'does not interfere with the unrelated ticket');
  cdb.close();
});

// ── clear_integration_branch (problem B B-3 / D-B1) ──────────────────────────

/** Set integration_branch directly (normally a system column the merge path sets. a direct write for tests). */
function setIntegrationBranch(cdb: ReturnType<typeof freshDb>, ticketId: string, branch: string): void {
  cdb.db.prepare('UPDATE tickets SET integration_branch = ? WHERE id = ?').run(branch, ticketId);
}

test('clear_integration_branch: if a value is set, reset to NULL and cleared:true, without bumping version', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: 'B-3' });
  setIntegrationBranch(cdb, i.id, 'lockage/ticket/ib');
  const before = getTicket(cdb, i.id)!;
  assert.equal(before.integration_branch, 'lockage/ticket/ib');

  const r = clearIntegrationBranch(cdb, i.id);
  assert.deepEqual(r, { ok: true, cleared: true });
  const after = getTicket(cdb, i.id)!;
  assert.equal(after.integration_branch, null);
  assert.equal(after.version, before.version, 'clearing a system column does not bump version (separate from update_ticket)');
  cdb.close();
});

test('clear_integration_branch: if already NULL, cleared:false (idempotent)', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: 'B-3' });
  const r = clearIntegrationBranch(cdb, i.id);
  assert.deepEqual(r, { ok: true, cleared: false });
  cdb.close();
});

test('clear_integration_branch: a missing ticket is not_found', () => {
  const cdb = freshDb();
  const r = clearIntegrationBranch(cdb, 'NOPE');
  assert.deepEqual(r, { ok: false, reason: 'not_found' });
  cdb.close();
});

test('clear_integration_branch: the expected_branch guard only clears on a name match (does not wrongly erase a re-aggregation new branch)', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: 'B-3' });
  setIntegrationBranch(cdb, i.id, 'lockage/ticket/NEW');

  // guarding with the old branch name does not match and does not clear
  const r1 = clearIntegrationBranch(cdb, i.id, 'lockage/ticket/OLD');
  assert.deepEqual(r1, { ok: true, cleared: false });
  assert.equal(getTicket(cdb, i.id)!.integration_branch, 'lockage/ticket/NEW', 'the new branch is protected');

  // with the correct name it clears
  const r2 = clearIntegrationBranch(cdb, i.id, 'lockage/ticket/NEW');
  assert.deepEqual(r2, { ok: true, cleared: true });
  assert.equal(getTicket(cdb, i.id)!.integration_branch, null);
  cdb.close();
});

test('close_ticket_on_merge: flips open to closed and closed:true, without bumping version', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: 'B-3 close' });
  const before = getTicket(cdb, i.id)!;
  assert.equal(before.status, 'open');

  const r = closeTicketOnMerge(cdb, i.id);
  assert.deepEqual(r, { ok: true, closed: true });
  const after = getTicket(cdb, i.id)!;
  assert.equal(after.status, 'closed');
  assert.equal(
    after.version,
    before.version,
    'close-after-merge does not bump version (system op. separate from update_ticket / D-B1)',
  );
  cdb.close();
});

test('close_ticket_on_merge: in_progress can also be flipped to closed (one-way)', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: 'B-3 inprog' });
  // to in_progress (via the user-edit path update_ticket. version bumps).
  const u = updateTicket(cdb, { ticketId: i.id, expectedVersion: i.version, status: 'in_progress' });
  assert.equal(u.ok, true);
  const mid = getTicket(cdb, i.id)!;
  assert.equal(mid.status, 'in_progress');

  const r = closeTicketOnMerge(cdb, i.id);
  assert.deepEqual(r, { ok: true, closed: true });
  const after = getTicket(cdb, i.id)!;
  assert.equal(after.status, 'closed');
  assert.equal(after.version, mid.version, 'close does not bump version (kept even for in_progress→closed)');
  cdb.close();
});

test('close_ticket_on_merge: if already closed, closed:false (idempotent, version kept)', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: 'B-3 idem' });
  const first = closeTicketOnMerge(cdb, i.id);
  assert.deepEqual(first, { ok: true, closed: true });
  const afterFirst = getTicket(cdb, i.id)!;

  const second = closeTicketOnMerge(cdb, i.id);
  assert.deepEqual(second, { ok: true, closed: false }, 'the second time does nothing');
  const afterSecond = getTicket(cdb, i.id)!;
  assert.equal(afterSecond.version, afterFirst.version, 'a re-call does not bump version');
  cdb.close();
});

test('close_ticket_on_merge: a missing ticket is not_found', () => {
  const cdb = freshDb();
  const r = closeTicketOnMerge(cdb, 'NOPE');
  assert.deepEqual(r, { ok: false, reason: 'not_found' });
  cdb.close();
});

// ── mark_ticket_in_progress_on_claim (1A / claim-linked status transition. symmetric with closeTicketOnMerge) ──

test('mark_ticket_in_progress_on_claim: flips open to in_progress and changed:true, without bumping version', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: '1A open' });
  const before = getTicket(cdb, i.id)!;
  assert.equal(before.status, 'open');
  assert.equal(before.version, 0);

  const r = markTicketInProgressOnClaim(cdb, i.id);
  assert.deepEqual(r, { ok: true, changed: true });
  const after = getTicket(cdb, i.id)!;
  assert.equal(after.status, 'in_progress');
  assert.equal(
    after.version,
    before.version,
    'a claim-linked status transition does not bump version (system op. separate from update_ticket / D-B1)',
  );
  cdb.close();
});

test('mark_ticket_in_progress_on_claim: if already in_progress, changed:false (idempotent, version kept)', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: '1A inprog' });
  // set to in_progress via the user-edit path (version→1).
  const u = updateTicket(cdb, { ticketId: i.id, expectedVersion: 0, status: 'in_progress' });
  assert.equal(u.ok, true);
  const mid = getTicket(cdb, i.id)!;
  assert.equal(mid.status, 'in_progress');

  const r = markTicketInProgressOnClaim(cdb, i.id);
  assert.deepEqual(r, { ok: true, changed: false }, 'the second time does nothing (falls outside WHERE status=open)');
  const after = getTicket(cdb, i.id)!;
  assert.equal(after.status, 'in_progress');
  assert.equal(after.version, mid.version, 'a re-call does not bump version');
  cdb.close();
});

test('mark_ticket_in_progress_on_claim: does not touch closed, changed:false (open→in_progress one-way)', () => {
  const cdb = freshDb();
  const i = openTicket(cdb, { title: '1A closed' });
  assert.deepEqual(closeTicketOnMerge(cdb, i.id), { ok: true, closed: true });
  const closed = getTicket(cdb, i.id)!;
  assert.equal(closed.status, 'closed');

  const r = markTicketInProgressOnClaim(cdb, i.id);
  assert.deepEqual(r, { ok: true, changed: false }, 'closed does not return to in_progress (one-way)');
  const after = getTicket(cdb, i.id)!;
  assert.equal(after.status, 'closed', 'stays closed');
  assert.equal(after.version, closed.version, 'version is kept too');
  cdb.close();
});

test('mark_ticket_in_progress_on_claim: a missing ticket is not_found', () => {
  const cdb = freshDb();
  const r = markTicketInProgressOnClaim(cdb, 'NOPE');
  assert.deepEqual(r, { ok: false, reason: 'not_found' });
  cdb.close();
});
