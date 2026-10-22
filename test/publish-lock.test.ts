import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, type CoordDb } from '../src/db/index.ts';
import { createTask, claimTask } from '../src/lockage/claim.ts';
import { openTicket } from '../src/lockage/tickets.ts';
import { assignWorktree } from '../src/lockage/worktree.ts';
import { onTaskDone } from '../src/lockage/merge.ts';
import { short } from '../src/lockage/git.ts';
import { LockageClient } from '../src/launcher/client.ts';
import { publishReadyTickets } from '../src/launcher/publish.ts';
import { type PublishAdapter, type PrRef } from '../src/launcher/publish-adapter.ts';
import {
  acquirePublishLock,
  releasePublishLock,
  PUBLISH_LOCK_TTL_SEC,
} from '../src/lockage/publish-lock.ts';

/**
 * Area 1: verification of the per-ticket advisory lock (publish_locks).
 *
 * The first half is the helpers alone (in-memory DB, now-injection to deterministically reproduce TTL
 * expiry). The second half starts a real Lockage server + a real file DB with 2 connections and verifies
 * that when the same ticket is published concurrently, openPr is called exactly once (no duplicate PR)
 * and the board records exactly one pr_opened. The losing side converges to either 'locked' (its
 * acquire overlapped the winner's lock window) or 'already_opened' (it acquired after the winner's
 * release and the lock-held pr_opened re-read observed the committed pr_opened — because C refreshes
 * both openedTicketIds and latestOpenedSeq, reEmitted is false and the loser skips cleanly without a
 * spurious follow-up push). Which one occurs varies with timing; both keep openPr at exactly one call
 * — the duplicate-PR invariant that C guarantees.
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = join(PROJECT_ROOT, 'dist', 'index.js');
const SCRATCH = process.env.KIROCREW_SCRATCH ?? tmpdir();

// ── helpers alone (acquire/release CAS behavior) ──────────────────────────

/** The current row count of publish_locks (used to check the DELETE row count on release). */
function lockRowCount(cdb: CoordDb, ticketId: string): number {
  const row = cdb.db
    .prepare(`SELECT COUNT(*) AS n FROM publish_locks WHERE ticket_id = ?`)
    .get(ticketId) as { n: number };
  return row.n;
}

test('acquirePublishLock: a double acquire makes the second ok:false (a live lock exists)', () => {
  const cdb = openDb({ path: ':memory:', hostId: 'host-test' });
  try {
    const a = acquirePublishLock(cdb, 'I1');
    assert.equal(a.ok, true);
    const b = acquirePublishLock(cdb, 'I1');
    assert.equal(b.ok, false);
  } finally {
    cdb.close();
  }
});

test('releasePublishLock → re-acquire possible (can be re-taken after release)', () => {
  const cdb = openDb({ path: ':memory:', hostId: 'host-test' });
  try {
    const a = acquirePublishLock(cdb, 'I1');
    assert.equal(a.ok, true);
    assert.ok(a.ok && a.holder);
    releasePublishLock(cdb, 'I1', (a as { ok: true; holder: string }).holder);
    assert.equal(lockRowCount(cdb, 'I1'), 0, 'the row disappears on release');
    const b = acquirePublishLock(cdb, 'I1');
    assert.equal(b.ok, true, 'can re-acquire after release');
  } finally {
    cdb.close();
  }
});

test('acquirePublishLock: after TTL expiry another holder can steal it (ok:true)', () => {
  const cdb = openDb({ path: ':memory:', hostId: 'host-test' });
  try {
    const base = 1_000_000;
    const a = acquirePublishLock(cdb, 'I1', { ttlSec: 10, now: base });
    assert.equal(a.ok, true);
    const firstHolder = (a as { ok: true; holder: string }).holder;

    // within the TTL it still cannot be taken.
    const mid = acquirePublishLock(cdb, 'I1', { now: base + 5 });
    assert.equal(mid.ok, false, 'cannot steal within the TTL');

    // after TTL expiry, DELETE the stale row and another holder can take it.
    const b = acquirePublishLock(cdb, 'I1', { now: base + 20 });
    assert.equal(b.ok, true, 'can steal after TTL expiry');
    const secondHolder = (b as { ok: true; holder: string }).holder;
    assert.notEqual(secondHolder, firstHolder, 'the holder switches');
  } finally {
    cdb.close();
  }
});

test('releasePublishLock: a different holder cannot delete it (DELETE 0 rows)', () => {
  const cdb = openDb({ path: ':memory:', hostId: 'host-test' });
  try {
    const a = acquirePublishLock(cdb, 'I1');
    assert.equal(a.ok, true);
    assert.equal(lockRowCount(cdb, 'I1'), 1);

    // a different holder (a lock not the stolen self) cannot delete it.
    releasePublishLock(cdb, 'I1', 'other-holder');
    assert.equal(lockRowCount(cdb, 'I1'), 1, 'a different holder\'s release does not delete the row');

    // the owner can delete it.
    releasePublishLock(cdb, 'I1', (a as { ok: true; holder: string }).holder);
    assert.equal(lockRowCount(cdb, 'I1'), 0);
  } finally {
    cdb.close();
  }
});

// ── serialization of concurrent publish (real Lockage server + real file DB, 2 connections) ────────

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function initRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@test.local']);
  git(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'README.md'), '# test\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

function commitInWorktree(wtPath: string, file: string, content: string): void {
  writeFileSync(join(wtPath, file), content);
  git(wtPath, ['add', '.']);
  git(wtPath, ['commit', '-q', '-m', `edit ${file}`]);
}

/** Aggregate 2 tasks of the same ticket → all done creates ticket_ready + integration_branch. */
function seedReadyTicket(cdb: CoordDb, repoPath: string, tag = 'x'): { ticketId: string; branch: string } {
  const ticket = openTicket(cdb, { title: 'aggregation ticket', body: 'ticket body' });
  const mk = (agent: string, file: string) => {
    const t = createTask(cdb, { repo: 'repo', title: `task-${agent}`, ticketId: ticket.id });
    const w = assignWorktree(cdb, { agentId: agent, repoPath, taskId: t.id });
    const c = claimTask(cdb, t.id, agent, t.version);
    assert.equal(c.ok, true);
    commitInWorktree(w.worktree_path, file, `// ${agent}\n`);
    const r = onTaskDone(cdb, {
      agentId: agent,
      worktreePath: w.worktree_path,
      branch: w.branch,
      repo: repoPath,
      taskId: t.id,
    });
    assert.equal(r.ok, true, `onTaskDone ${agent}: ${JSON.stringify(r)}`);
  };
  mk(`${tag}-claude-01`, `${tag}-a.js`);
  mk(`${tag}-claude-02`, `${tag}-b.js`);
  return { ticketId: ticket.id, branch: `lockage/ticket/${short(ticket.id)}` };
}

/** A fake adapter that records openPr/push and releases the barrier the moment it is called to prompt the peer's execution. */
function makeSlowAdapter(onOpen: () => void): PublishAdapter & { openedHeads: string[]; pushed: string[] } {
  const openedHeads: string[] = [];
  const pushed: string[] = [];
  let n = 100;
  return {
    id: 'github',
    openedHeads,
    pushed,
    async pushBranch(_repo, branch) {
      pushed.push(branch);
    },
    async openPr(a) {
      openedHeads.push(a.head);
      onOpen();
      // wait a little so the peer tries acquire during this time (let it observe the lock being held).
      await new Promise((r) => setTimeout(r, 50));
      const num = n++;
      return { number: num, state: 'OPEN', url: `https://github.com/acme/repo/pull/${num}` };
    },
    async findPrByHead(): Promise<PrRef | null> {
      return null;
    },
    async prState() {
      return 'OPEN';
    },
    // Issue #31: インタフェース拡張に追従（publish 側テストでは reconcile 専用メソッドは呼ばれない）。
    async prView() {
      return { state: 'OPEN' as const, headRefName: null };
    },
    async deleteRemoteBranch() { },
    async repoIdentity() {
      return 'acme/repo';
    },
  };
}

test('publishReadyTickets: concurrent publish of the same ticket from 2 connections opens exactly one PR (no duplicate); the loser ends up locked or already_opened', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-publock-concurrent-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  // 2 independent MCP connections (= equivalent to 2 processes of the publisher).
  const clientA = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  const clientB = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await clientA.connect();
  await clientB.connect();
  t.after(() => clientA.close());
  t.after(() => clientB.close());

  const args = { repoPath, base: 'main', agentId: 'publisher', localBranchExists: () => true };

  // Deterministic sync point instead of a load-dependent Promise.all race: start A first, and the
  // moment A's openPr fires — A holds the per-ticket lock and has not yet posted pr_opened — start
  // B. A's openPr sleeps 50ms, so B's acquire_publish_lock reaches the lock while A still holds it
  // and B is pushed into the contention window. Under the 50ms barrier B usually lands on 'locked'
  // (its acquire overlapped A's window), but under heavier load B may acquire only after A's release
  // and land on 'already_opened' (the lock-held re-read sees A's committed pr_opened; see the
  // loser-filter comment below). Both keep openPr at one call and pr_opened at one row; the
  // assertions below check that invariant rather than a single outcome.
  let bPublish: Promise<Awaited<ReturnType<typeof publishReadyTickets>>> | null = null;
  const adapterB = makeSlowAdapter(() => { });
  const adapterA = makeSlowAdapter(() => {
    // Fire B exactly when A is inside its openPr (lock held, pr_opened not yet posted).
    if (!bPublish) bPublish = publishReadyTickets(clientB, adapterB, args);
  });

  const outA = await publishReadyTickets(clientA, adapterA, args);
  // bPublish is set synchronously inside A's openPr; A publishes this single ready ticket.
  assert.ok(bPublish, 'B was started from A\'s openPr sync point');
  const outB = await bPublish;

  const all = [...outA, ...outB].filter((o) => o.ticketId === ticketId);
  const published = all.filter((o) => o.result === 'published');
  // The loser is whichever side did not create the PR. With C refreshing the opened-seq under the
  // lock (not just openedTicketIds), the loser converges cleanly to one of two non-duplicate
  // outcomes, which one depending on timing:
  //   - 'locked': B's acquire_publish_lock overlapped A's lock window and was rejected.
  //   - 'already_opened': B acquired after A's release; the lock-held pr_opened re-read observed A's
  //     committed pr_opened and refreshed both openedTicketIds and latestOpenedSeq, so reEmitted is
  //     false and B skips as already_opened WITHOUT a spurious follow-up push / pr_updated.
  // 'updated' is NOT reachable here: that path would require a stale opened-seq, which C now
  // refreshes. Either way openPr is called exactly once (invariant 2) and the board holds a single
  // pr_opened (invariant 3). The test accepts either to stay robust to timing.
  const loser = all.filter(
    (o) =>
      o.result === 'already_opened' ||
      (o.result === 'skipped' && (o as { reason: string }).reason === 'locked'),
  );

  // Invariant 1: exactly one side actually created the PR.
  assert.equal(published.length, 1, 'exactly one side published');
  // The other side did not create a duplicate: it is locked or already_opened.
  assert.equal(loser.length, 1, 'the loser converges to locked or already_opened');

  // Invariant 2: openPr is called exactly once in total (no double PR).
  assert.equal(adapterA.openedHeads.length + adapterB.openedHeads.length, 1, 'openPr is called exactly once in total');

  // Invariant 3: the board records exactly one pr_opened for this ticket.
  const opened = await clientA.callTool('read_board', { kind: 'pr_opened' });
  assert.equal(
    opened.messages.filter((m: { ref_ticket_id: string | null }) => m.ref_ticket_id === ticketId).length,
    1,
    'pr_opened is exactly 1',
  );
});

// a light regression that the default TTL is a sensible positive number of seconds (prevents an unintended 0/negative value for the constant).
test('PUBLISH_LOCK_TTL_SEC is a positive number of seconds', () => {
  assert.ok(PUBLISH_LOCK_TTL_SEC > 0);
});
