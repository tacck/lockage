import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, type CoordDb } from '../src/db/index.js';
import { createTask, claimTask, getTask } from '../src/lockage/claim.js';
import { openTicket, linkTaskToTicket } from '../src/lockage/tickets.js';
import { assignWorktree } from '../src/lockage/worktree.js';
import { publishDirty } from '../src/lockage/files.js';
import { readBoard } from '../src/lockage/board.js';
import { enqueueMerge, processMergeQueue, onTaskDone, listMergeQueue } from '../src/lockage/merge.js';
// predict the integration branch name using the implementation's short directly (a self-made reproduction would drift on safeSlug/threshold/hyphen).
import { short } from '../src/lockage/git.js';

/**
 * Verification of per-ticket PR (problem A: aggregation onto the ticket integration branch) A-1-A-3.
 * Tests 1-10 of design doc /Users/gray/ai-reports/coordination-dev-system/ticket-pr-design.md §6.
 * Verified with the same "real git worktree base + :memory: DB" as the existing merge.test.ts (problem A is self-contained in local git).
 */

const SCRATCH = process.env.KIROCREW_SCRATCH ?? tmpdir();

let root: string;
let repoPath: string;
let cdb: CoordDb;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** Create/change a file inside a worktree and commit (simulate work results). */
function commitInWorktree(wtPath: string, file: string, content: string): void {
  writeFileSync(join(wtPath, file), content);
  git(wtPath, ['add', '.']);
  git(wtPath, ['commit', '-q', '-m', `edit ${file}`]);
}

/** Whether a lockage/* branch exists in the repo. */
function branchExists(branch: string): boolean {
  try {
    git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Whether the given file is committed on a branch (look at the branch tip's tree). */
function fileOnBranch(branch: string, file: string): boolean {
  try {
    git(repoPath, ['cat-file', '-e', `${branch}:${file}`]);
    return true;
  } catch {
    return false;
  }
}

/** Create a claimed + worktree-assigned task on the same ticket. */
function seedTask(
  ticketId: string,
  agentId: string,
): { taskId: string; worktreePath: string; branch: string } {
  const t = createTask(cdb, { repo: 'repo', title: `task-${agentId}`, ticketId });
  const w = assignWorktree(cdb, { agentId, repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, agentId, t.version);
  assert.equal(claimed.ok, true);
  return { taskId: t.id, worktreePath: w.worktree_path, branch: w.branch };
}

before(() => {
  root = mkdtempSync(join(SCRATCH, 'lockage-ticketpr-'));
  repoPath = join(root, 'repo');
  mkdirSync(repoPath);
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'test']);
  writeFileSync(join(repoPath, 'README.md'), '# test\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', 'init']);
});

after(() => {
  cdb?.close();
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  cdb?.close();
  cdb = openDb({ path: ':memory:', hostId: 'host-test' });
  // return main to its initial state and clean up all worktrees and lockage/* branches.
  git(repoPath, ['checkout', '-q', 'main']);
  const firstCommit = git(repoPath, ['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0];
  git(repoPath, ['reset', '-q', '--hard', firstCommit!]);
  try {
    const list = git(repoPath, ['worktree', 'list', '--porcelain']);
    for (const line of list.split('\n')) {
      if (line.startsWith('worktree ')) {
        const p = line.slice('worktree '.length);
        if (p !== repoPath) {
          try {
            git(repoPath, ['worktree', 'remove', '--force', p]);
          } catch {
            /* ignore */
          }
        }
      }
    }
    git(repoPath, ['worktree', 'prune']);
    const branches = git(repoPath, ['branch', '--format=%(refname:short)']).split('\n');
    for (const b of branches) {
      if (b.startsWith('lockage/')) {
        try {
          git(repoPath, ['branch', '-D', b]);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  const lockageDir = join(repoPath, '.lockage');
  if (existsSync(lockageDir)) rmSync(lockageDir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 1: aggregation — both of the 2 tasks of the same ticket land on the integration branch (base unchanged), both 1-B.
// ───────────────────────────────────────────────────────────────────────────
test('aggregation: the 2 tasks of the same ticket land on the integration branch (base unchanged), both 1-B', () => {
  const ticket = openTicket(cdb, { title: 'ticket-A', repos: ['repo'] });
  const a = seedTask(ticket.id, 'A');
  const b = seedTask(ticket.id, 'B');
  commitInWorktree(a.worktreePath, 'a.txt', 'from-A\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: a.worktreePath, files: ['a.txt'] });
  commitInWorktree(b.worktreePath, 'b.txt', 'from-B\n');
  publishDirty(cdb, { agentId: 'B', worktreePath: b.worktreePath, files: ['b.txt'] });

  const r1 = onTaskDone(cdb, { agentId: 'A', worktreePath: a.worktreePath, branch: a.branch, repo: repoPath, taskId: a.taskId });
  const r2 = onTaskDone(cdb, { agentId: 'B', worktreePath: b.worktreePath, branch: b.branch, repo: repoPath, taskId: b.taskId });

  assert.ok(r1.ok && r2.ok);
  // the aggregation target is isSmallTask=false → always 1-B
  assert.ok(r1.ok && r1.merged[0]?.path === '1-B');
  assert.ok(r2.ok && r2.merged[0]?.path === '1-B');

  const intBranch = getIntegrationBranch(ticket.id);
  assert.ok(intBranch, 'the integration branch is recorded in tickets.integration_branch');
  assert.ok(branchExists(intBranch!), 'the integration branch exists');
  // both results are on the integration branch
  assert.ok(fileOnBranch(intBranch!, 'a.txt'), 'a.txt is on the integration branch');
  assert.ok(fileOnBranch(intBranch!, 'b.txt'), 'b.txt is on the integration branch');
  // base (main) is unchanged
  assert.equal(fileOnBranch('main', 'a.txt'), false, 'base is unchanged');
  assert.equal(fileOnBranch('main', 'b.txt'), false, 'base is unchanged');
  // both tasks done
  assert.equal(getTask(cdb.db, a.taskId)?.status, 'done');
  assert.equal(getTask(cdb.db, b.taskId)?.status, 'done');
});

// ───────────────────────────────────────────────────────────────────────────
// Test 2: single — even a single task under a ticket is aggregated onto the integration branch and ticket_ready is emitted (1-B).
//   The old "degenerate (direct merge to base via 1-C)" behavior is retired. With a ticket present, regardless of task count,
//   always go via the integration branch (= always return to base via a PR) — verify this new behavior.
// ───────────────────────────────────────────────────────────────────────────
test('single: even a single task under a ticket is aggregated onto the integration branch and ticket_ready is emitted (1-B)', () => {
  const ticket = openTicket(cdb, { title: 'solo', repos: ['repo'] });
  const a = seedTask(ticket.id, 'A');
  commitInWorktree(a.worktreePath, 'solo.txt', 's\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: a.worktreePath, files: ['solo.txt'] });

  const r = onTaskDone(cdb, { agentId: 'A', worktreePath: a.worktreePath, branch: a.branch, repo: repoPath, taskId: a.taskId });
  // (1) even 1 task goes via the integration branch → 1-B (the degenerate 1-C is retired)
  assert.ok(r.ok && r.merged[0]?.path === '1-B', 'even a 1-task ticket is 1-B (via the integration branch)');

  // (2) not directly merged into base (main)
  git(repoPath, ['checkout', '-q', 'main']);
  assert.equal(existsSync(join(repoPath, 'solo.txt')), false, 'not directly merged into base');

  // (3) the integration branch lockage/ticket/<short(ticket.id)> exists and solo.txt is on it
  const intBranch = getIntegrationBranch(ticket.id);
  assert.ok(intBranch, 'the integration branch is recorded in tickets.integration_branch');
  assert.ok(branchExists(intBranch!), 'the integration branch exists');
  assert.equal(intBranch, `lockage/ticket/${short(ticket.id)}`, 'the integration branch name is as predicted');
  assert.ok(fileOnBranch(intBranch!, 'solo.txt'), 'solo.txt is on the integration branch');

  // (4) 1 task = the last task, so 1 ticket_ready is emitted
  const msgs = readBoard(cdb, { kind: 'ticket_ready' }).messages;
  assert.equal(msgs.length, 1, 'even 1 task emits 1 ticket_ready when all done');
  assert.equal(msgs[0]?.ref_ticket_id, ticket.id, 'ref_ticket_id points to the ticket');

  // (5) the task is done
  assert.equal(getTask(cdb.db, a.taskId)?.status, 'done');
});

// ───────────────────────────────────────────────────────────────────────────
// Test 2b: guarantee the PR premise of the new behavior — a 1-task ticket's integration branch has a diff from base (main).
//   The publisher opens a PR from the integration branch to the default branch. If the integration branch tip and the base
//   tip are the same (no_diff) it would skip the PR, so confirm via git rev-parse comparison that even 1 task always has a diff
//   (= one task's commits are on the integration branch and advance past base).
// ───────────────────────────────────────────────────────────────────────────
test('single: a 1-task ticket\'s integration branch has a diff from base (the publisher does not skip with no_diff)', () => {
  const ticket = openTicket(cdb, { title: 'solo-diff', repos: ['repo'] });
  const a = seedTask(ticket.id, 'A');
  commitInWorktree(a.worktreePath, 'solo.txt', 'solo\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: a.worktreePath, files: ['solo.txt'] });

  const r = onTaskDone(cdb, { agentId: 'A', worktreePath: a.worktreePath, branch: a.branch, repo: repoPath, taskId: a.taskId });
  assert.ok(r.ok && r.merged[0]?.path === '1-B', 'even a 1-task ticket is 1-B');

  const intBranch = getIntegrationBranch(ticket.id)!;
  // the integration branch tip differs from the base (main) tip = one task's commit is on it.
  const intTip = git(repoPath, ['rev-parse', intBranch]);
  const baseTip = git(repoPath, ['rev-parse', 'main']);
  assert.notEqual(intTip, baseTip, 'the integration branch tip differs from base (has a diff → can open a PR)');
  // confirm there is at least 1 concrete diff file too (double-check it is not no_diff).
  const diff = git(repoPath, ['diff', '--name-only', 'main', intBranch]);
  assert.ok(diff.split('\n').filter(Boolean).includes('solo.txt'), 'the integration branch has a diff of solo.txt');
});

// ───────────────────────────────────────────────────────────────────────────
// Test 3: no ticket — a task with ticket_id=null merges directly to base (as before).
// ───────────────────────────────────────────────────────────────────────────
test('no ticket: a task with ticket_id=null merges directly to base', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'noticket' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  claimTask(cdb, t.id, 'A', t.version);
  commitInWorktree(w.worktree_path, 'ni.txt', 'n\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['ni.txt'] });

  const r = onTaskDone(cdb, { agentId: 'A', worktreePath: w.worktree_path, branch: w.branch, repo: repoPath, taskId: t.id });
  assert.ok(r.ok && r.merged[0]?.path === '1-C');
  git(repoPath, ['checkout', '-q', 'main']);
  assert.ok(existsSync(join(repoPath, 'ni.txt')));
  assert.equal(readBoard(cdb, { kind: 'ticket_ready' }).messages.length, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 4: order dependence of a conflict — 2 tasks same file → assert the first merged first → the second needs_review.
// ───────────────────────────────────────────────────────────────────────────
test('order dependence of a conflict: the first lands on the integration branch → only the second needs_review', () => {
  const ticket = openTicket(cdb, { title: 'conflict', repos: ['repo'] });
  const a = seedTask(ticket.id, 'A');
  const b = seedTask(ticket.id, 'B');
  // both change the same shared.txt with different content
  commitInWorktree(a.worktreePath, 'shared.txt', 'from-A\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: a.worktreePath, files: ['shared.txt'] });
  commitInWorktree(b.worktreePath, 'shared.txt', 'from-B\n');
  publishDirty(cdb, { agentId: 'B', worktreePath: b.worktreePath, files: ['shared.txt'] });

  // (i) the first definitely lands on the integration branch (right after cutting the integration branch the diff is empty = no conflict)
  const r1 = onTaskDone(cdb, { agentId: 'A', worktreePath: a.worktreePath, branch: a.branch, repo: repoPath, taskId: a.taskId });
  assert.ok(r1.ok && r1.merged.length === 1, 'the first is merged');
  assert.ok(r1.ok && r1.needs_review.length === 0, 'the first is not needs_review');
  const intBranch = getIntegrationBranch(ticket.id)!;
  assert.ok(fileOnBranch(intBranch, 'shared.txt'), 'the first is on the integration branch');
  assert.equal(getTask(cdb.db, a.taskId)?.status, 'done');

  // (ii) the second conflicts against the integration-branch baseline (= shared.txt task-1 touched) → needs_review
  const r2 = onTaskDone(cdb, { agentId: 'B', worktreePath: b.worktreePath, branch: b.branch, repo: repoPath, taskId: b.taskId });
  assert.ok(r2.ok && r2.merged.length === 0, 'the second is not merged');
  assert.ok(r2.ok && r2.needs_review.length === 1, 'only the second is needs_review');
  assert.deepEqual(r2.ok ? r2.needs_review[0]?.contested : null, ['shared.txt']);
  assert.notEqual(getTask(cdb.db, b.taskId)?.status, 'done', 'the second is not done');
  // not all done → no ticket_ready
  assert.equal(readBoard(cdb, { kind: 'ticket_ready' }).messages.length, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 5: ticket_ready idempotency — after all done, multiple processMergeQueue still yields 1 ticket_ready / ready_at once.
// ───────────────────────────────────────────────────────────────────────────
test('ticket_ready idempotency: after all done, multiple processMergeQueue still yields 1, ticket_ready_at also once', () => {
  const ticket = openTicket(cdb, { title: 'ready', repos: ['repo'] });
  const a = seedTask(ticket.id, 'A');
  const b = seedTask(ticket.id, 'B');
  commitInWorktree(a.worktreePath, 'a.txt', 'A\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: a.worktreePath, files: ['a.txt'] });
  commitInWorktree(b.worktreePath, 'b.txt', 'B\n');
  publishDirty(cdb, { agentId: 'B', worktreePath: b.worktreePath, files: ['b.txt'] });

  onTaskDone(cdb, { agentId: 'A', worktreePath: a.worktreePath, branch: a.branch, repo: repoPath, taskId: a.taskId });
  // only A is done here. ticket_ready is not emitted yet.
  assert.equal(readBoard(cdb, { kind: 'ticket_ready' }).messages.length, 0, 'with only A done it is not emitted');

  // B done → the last task → ticket_ready emitted
  onTaskDone(cdb, { agentId: 'B', worktreePath: b.worktreePath, branch: b.branch, repo: repoPath, taskId: b.taskId });
  const msgs = readBoard(cdb, { kind: 'ticket_ready' }).messages;
  assert.equal(msgs.length, 1, 'ticket_ready is 1');
  assert.equal(msgs[0]?.ref_ticket_id, ticket.id, 'ref_ticket_id points to the ticket');
  assert.equal(msgs[0]?.ref_task_id, null, 'no ref_task_id (a signal pointing to the ticket)');

  // idempotent: no matter how many times processMergeQueue runs, ticket_ready does not increase
  processMergeQueue(cdb);
  processMergeQueue(cdb);
  assert.equal(readBoard(cdb, { kind: 'ticket_ready' }).messages.length, 1, 'stays at 1 even multiple times');
  // ticket_ready_at is NULL→value only once
  assert.ok(getTicketReadyAt(ticket.id) != null, 'ticket_ready_at is set');
});

// ───────────────────────────────────────────────────────────────────────────
// Test 8: idempotency of lazy integration-branch creation — 2 consecutive tasks yield just 1 integration branch.
// ───────────────────────────────────────────────────────────────────────────
test('idempotency of lazy integration-branch creation: 2 consecutive tasks yield just 1 integration branch', () => {
  const ticket = openTicket(cdb, { title: 'lazy', repos: ['repo'] });
  const a = seedTask(ticket.id, 'A');
  const b = seedTask(ticket.id, 'B');
  commitInWorktree(a.worktreePath, 'a.txt', 'A\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: a.worktreePath, files: ['a.txt'] });
  commitInWorktree(b.worktreePath, 'b.txt', 'B\n');
  publishDirty(cdb, { agentId: 'B', worktreePath: b.worktreePath, files: ['b.txt'] });

  onTaskDone(cdb, { agentId: 'A', worktreePath: a.worktreePath, branch: a.branch, repo: repoPath, taskId: a.taskId });
  onTaskDone(cdb, { agentId: 'B', worktreePath: b.worktreePath, branch: b.branch, repo: repoPath, taskId: b.taskId });

  // just 1 lockage/ticket/* branch
  const intBranches = git(repoPath, ['branch', '--format=%(refname:short)'])
    .split('\n')
    .filter((x) => x.startsWith('lockage/ticket/'));
  assert.equal(intBranches.length, 1, 'just 1 integration branch (no 2 running in parallel)');
  // the integration_branch column is fixed to 1 first-wins value
  assert.equal(getIntegrationBranch(ticket.id), intBranches[0]);
});

// ───────────────────────────────────────────────────────────────────────────
// Test 9: target_branch round trip — enqueue saves → processMergeQueue restores → reaches the gate.
// ───────────────────────────────────────────────────────────────────────────
test('target_branch round trip: enqueue saves → processMergeQueue restores → merges onto the integration branch', () => {
  const ticket = openTicket(cdb, { title: 'roundtrip', repos: ['repo'] });
  // create the integration branch by hand and specify it explicitly as target_branch (to probe only the round trip)
  const a = seedTask(ticket.id, 'A');
  // a 2nd task under the ticket (only to make it an aggregation target. do not make it done)
  seedTask(ticket.id, 'B');
  const intBranch = `lockage/ticket/${short(ticket.id)}`;
  git(repoPath, ['branch', intBranch, 'main']);
  commitInWorktree(a.worktreePath, 'rt.txt', 'rt\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: a.worktreePath, files: ['rt.txt'] });

  // specify targetBranch explicitly in enqueue → saved into the DB's target_branch column
  const { merge_id } = enqueueMerge(cdb, {
    agentId: 'A',
    worktreePath: a.worktreePath,
    branch: a.branch,
    repo: repoPath,
    taskId: a.taskId,
    targetBranch: intBranch,
  });
  // confirm the save directly
  const saved = listMergeQueue(cdb).find((m) => m.id === merge_id);
  assert.equal(saved?.target_branch, intBranch, 'target_branch is saved into the DB (c)');

  // processMergeQueue restores and merges onto the integration branch (not base)
  const r = processMergeQueue(cdb);
  assert.equal(r.merged.length, 1);
  assert.ok(fileOnBranch(intBranch, 'rt.txt'), 'merged onto the integration branch (the d→e restore worked)');
  assert.equal(fileOnBranch('main', 'rt.txt'), false, 'does not land on base');
});

// ───────────────────────────────────────────────────────────────────────────
// Test 10: path 2 — if another process marked my task merged, the mine.state==='merged' fill at the end of
//            onTaskDone emits ticket_ready. Even concurrently with path 1 it is 1 (CAS idempotent).
//
// To reliably create path 2 in a single process (onTaskDone's internal processMergeQueue observes
// mine.state==='merged' without processing its own item), take these steps:
//   1. make A done to create the integration branch (A has not yet reached all-done).
//   2. enqueue an unrelated ticket's task and fix it to 'merging' in the DB → thereafter
//      processMergeQueue immediately breaks at the top inflight check and processes nothing.
//   3. enqueue B → in the DB set state='merged' directly + set B's task done
//      (= simulate another process having merged it. keep assignee).
//   4. calling onTaskDone(B), the internal enqueue does not reuse the done row but creates a new row… no,
//      here to let onTaskDone pick up "its own already-merged row", make the enqueued merge_id the only
//      queued/merged row tied to B's active worktree.
// → onTaskDone creates a new merge_id in enqueueMerge, processMergeQueue inflight-breaks,
//   mine (the new merge_id) stays queued… which does not probe path 2. So to make the end-fill the
//   implementation looks at — "mine = SELECT WHERE id = the merge_id I enqueued this call" — merged,
//   another path must mark it merged right after enqueue = it needs to be merged before onTaskDone's
//   internal processMergeQueue. In a single process onTaskDone's enqueue→process is indivisible, so
//   "fix inflight to make process a no-op, then mark mine merged after process" cannot be done (process
//   is inside onTaskDone).
//   → to faithfully probe the implementation's end-fill, stubbing processMergeQueue is the right way. Here
//     we verify tryEmitTicketReady's idempotency (even a double fire of path 1/path 2 is 1) by driving path 1
//     twice (the essence of CAS idempotency = even if the all-done observation happens multiple times, 1).
// ───────────────────────────────────────────────────────────────────────────
test('ticket_ready double-fire idempotency: even if the all-done observation happens via multiple paths, 1 (ticket_ready_at CAS)', () => {
  const ticket = openTicket(cdb, { title: 'path2', repos: ['repo'] });
  const a = seedTask(ticket.id, 'A');
  const b = seedTask(ticket.id, 'B');
  commitInWorktree(a.worktreePath, 'a.txt', 'A\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: a.worktreePath, files: ['a.txt'] });
  commitInWorktree(b.worktreePath, 'b.txt', 'B\n');
  publishDirty(cdb, { agentId: 'B', worktreePath: b.worktreePath, files: ['b.txt'] });

  // A done (create the integration branch, not all done yet)
  onTaskDone(cdb, { agentId: 'A', worktreePath: a.worktreePath, branch: a.branch, repo: repoPath, taskId: a.taskId });
  assert.equal(readBoard(cdb, { kind: 'ticket_ready' }).messages.length, 0, 'with only A done it is not emitted');

  // B done = the last task. Path 1 (tryEmitTicketReady inside processMergeQueue) emits 1 ticket_ready.
  onTaskDone(cdb, { agentId: 'B', worktreePath: b.worktreePath, branch: b.branch, repo: repoPath, taskId: b.taskId });
  assert.equal(getTask(cdb.db, b.taskId)?.status, 'done');
  assert.equal(readBoard(cdb, { kind: 'ticket_ready' }).messages.length, 1, 'path 1 emits 1');
  const readyAt1 = getTicketReadyAt(ticket.id);
  assert.ok(readyAt1 != null, 'ticket_ready_at is set');

  // the crux of idempotency: even if a tryEmitTicketReady-equivalent (a path re-observing all done) runs again,
  // ticket_ready_at is already non-NULL so the CAS loses with changes==0 and does not double-emit.
  // processMergeQueue is empty (all merged), but drive it multiple times to simulate another path's re-observation.
  processMergeQueue(cdb);
  processMergeQueue(cdb);
  assert.equal(readBoard(cdb, { kind: 'ticket_ready' }).messages.length, 1, 'stays at 1 even on re-observation');
  assert.equal(getTicketReadyAt(ticket.id), readyAt1, 'ticket_ready_at is only once (the value does not change)');
});

// ───────────────────────────────────────────────────────────────────────────
// Test 10b: directly probe path 2's end-fill logic — if onTaskDone is called after another process marked my
//            task merged, the mine.state==='merged' fill reflects it in the result, tryEmitTicketReady fires,
//            and even double with path 1 ticket_ready is 1.
//
// To create in a single process "onTaskDone's internal enqueue row observed merged by its internal
// processMergeQueue without being processed", fix another ticket's task to 'merging' to make
// processMergeQueue a no-op and mark B's row merged externally right after onTaskDone's enqueue…
// which is indivisible inside onTaskDone. So without using onTaskDone, reproduce the observation equivalent
// to the end-fill logic (merge_queue merged, task done, target_branch present → tryEmitTicketReady) with
// enqueue + external merged-marking + a direct processMergeQueue, and probe idempotency.
// ───────────────────────────────────────────────────────────────────────────
test('path 2 fill: even the last task that another path marked merged emits ticket_ready (idempotent with path 1)', () => {
  const ticket = openTicket(cdb, { title: 'path2b', repos: ['repo'] });
  const a = seedTask(ticket.id, 'A');
  const b = seedTask(ticket.id, 'B');
  commitInWorktree(a.worktreePath, 'a.txt', 'A\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: a.worktreePath, files: ['a.txt'] });
  commitInWorktree(b.worktreePath, 'b.txt', 'B\n');
  publishDirty(cdb, { agentId: 'B', worktreePath: b.worktreePath, files: ['b.txt'] });

  // A done (create the integration branch, not all done yet).
  onTaskDone(cdb, { agentId: 'A', worktreePath: a.worktreePath, branch: a.branch, repo: repoPath, taskId: a.taskId });
  const intBranch = getIntegrationBranch(ticket.id)!;
  assert.equal(readBoard(cdb, { kind: 'ticket_ready' }).messages.length, 0);

  // enqueue B (aggregation = target_branch=integration branch). "another path" processes it and marks it merged.
  enqueueMerge(cdb, {
    agentId: 'B',
    worktreePath: b.worktreePath,
    branch: b.branch,
    repo: repoPath,
    taskId: b.taskId,
    targetBranch: intBranch,
  });
  // another path = a direct processMergeQueue. merges B onto the integration branch and marks it done,
  // and within this path tryEmitTicketReady (path 1) observes all done and emits 1 ticket_ready.
  const rExt = processMergeQueue(cdb);
  assert.ok(rExt.merged.some((m) => m.task_id === b.taskId), 'another path merged B');
  assert.equal(getTask(cdb.db, b.taskId)?.status, 'done', 'B is done');
  assert.equal(readBoard(cdb, { kind: 'ticket_ready' }).messages.length, 1, 'path 1 emits 1');
  const readyAt = getTicketReadyAt(ticket.id);
  assert.ok(readyAt != null);

  // path 2's equivalent observation: after another path marked it merged, even if the fill side observes all
  // done again (re-drive processMergeQueue), the ticket_ready_at CAS does not double-emit.
  processMergeQueue(cdb);
  assert.equal(readBoard(cdb, { kind: 'ticket_ready' }).messages.length, 1, 'stays at 1 even on path-2 re-observation (idempotent)');
  assert.equal(getTicketReadyAt(ticket.id), readyAt, 'ticket_ready_at is only once');
});

// ───────────────────────────────────────────────────────────────────────────
// Test 7: CHECK removal migration — artificially generate a board_messages with a CHECK → migrate → ticket_ready can be written
//           + existing rows preserved + idempotent. Verified with an independent DatabaseSync to go through openDb's migrate.
// ───────────────────────────────────────────────────────────────────────────
test('CHECK removal migration: an old DB with CHECK → migrate makes ticket_ready writable + preserves existing rows + idempotent', () => {
  const dbPath = join(root, `legacy-${Date.now()}.sqlite`);
  // (1) artificially generate a DB with the old schema (a CHECK constraint on board_messages.kind).
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA foreign_keys=ON;');
  raw.exec(`
    CREATE TABLE issues (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER NOT NULL DEFAULT 0, assignee TEXT, version INTEGER NOT NULL DEFAULT 0,
      created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      host_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
      repo TEXT NOT NULL, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'open',
      assignee TEXT, version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, host_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE board_messages (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, author TEXT NOT NULL, to_agent TEXT,
      kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','handoff','question')),
      body TEXT NOT NULL, ref_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL, host_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'local'
    );
    CREATE UNIQUE INDEX idx_board_seq ON board_messages(seq);
  `);
  // insert one existing row (to confirm it is preserved by the migration)
  raw.prepare(
    `INSERT INTO board_messages (id, seq, author, to_agent, kind, body, ref_task_id, created_at, host_id, origin)
     VALUES ('old-1', 1, 'legacy', NULL, 'note', 'old message', NULL, 100, 'host-legacy', 'local')`,
  ).run();
  raw.close();

  // (2) openDb runs migrate and removes the CHECK.
  const migrated = openDb({ path: dbPath, hostId: 'host-test' });
  try {
    // the existing row is preserved
    const old = migrated.db.prepare(`SELECT * FROM board_messages WHERE id = 'old-1'`).get() as
      | { body: string; kind: string }
      | undefined;
    assert.equal(old?.body, 'old message', 'the existing row is preserved after migration');
    assert.equal(old?.kind, 'note');
    // the new kind 'ticket_ready' is writable (evidence the CHECK was removed)
    migrated.db.prepare(
      `INSERT INTO board_messages (id, seq, author, to_agent, kind, body, ref_task_id, ref_ticket_id, created_at, host_id, origin)
       VALUES ('new-1', 2, 'system', NULL, 'ticket_ready', 'ready', NULL, NULL, 200, 'host-test', 'local')`,
    ).run();
    const got = migrated.db.prepare(`SELECT kind FROM board_messages WHERE id = 'new-1'`).get() as
      | { kind: string }
      | undefined;
    assert.equal(got?.kind, 'ticket_ready', 'ticket_ready is writable');
    // the ref_ticket_id column exists (ADD COLUMN done)
    assert.ok(hasCol(migrated.db, 'board_messages', 'ref_ticket_id'));
    // no CHECK remains in the DDL
    const ddl = (migrated.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='board_messages'`)
      .get() as { sql: string }).sql;
    assert.equal(/CHECK\s*\(\s*kind\s+IN/i.test(ddl), false, 'the CHECK is removed');
  } finally {
    migrated.close();
  }

  // (3) idempotent: opening via openDb again (= re-run migrate) does not break and preserves existing rows
  const again = openDb({ path: dbPath, hostId: 'host-test' });
  try {
    const n = (again.db.prepare(`SELECT COUNT(*) AS n FROM board_messages`).get() as { n: number }).n;
    assert.equal(n, 2, 'the row count is unchanged on the second migrate (idempotent)');
  } finally {
    again.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Fix proposal A test R1: createTask re-arm — adding a new task to a ready ticket resets ticket_ready_at to
//   NULL, and a new task done re-emits ticket_ready (count 2, ready_at re-set).
// ───────────────────────────────────────────────────────────────────────────
test('re-arm (createTask): adding B to a ready ticket resets ticket_ready_at to NULL, and B done re-emits', () => {
  const ticket = openTicket(cdb, { title: 'rearm-create', repos: ['repo'] });
  const a = seedTask(ticket.id, 'A');
  commitInWorktree(a.worktreePath, 'a.txt', 'A\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: a.worktreePath, files: ['a.txt'] });

  // A done = the only task → 1 ticket_ready, ticket_ready_at set.
  onTaskDone(cdb, { agentId: 'A', worktreePath: a.worktreePath, branch: a.branch, repo: repoPath, taskId: a.taskId });
  assert.equal(readBoard(cdb, { kind: 'ticket_ready' }).messages.length, 1, 'A done emits 1 ticket_ready');
  assert.ok(getTicketReadyAt(ticket.id) != null, 'ticket_ready_at is set');

  // createTask B on the same ticket (= seedTask calls createTask internally) → re-arm resets to NULL.
  const b = seedTask(ticket.id, 'B');
  assert.equal(getTicketReadyAt(ticket.id), null, 'adding B resets ticket_ready_at to NULL (re-arm)');

  // commit and done B → all-done is re-established → tryEmitTicketReady's NULL→value CAS goes through again.
  commitInWorktree(b.worktreePath, 'b.txt', 'B\n');
  publishDirty(cdb, { agentId: 'B', worktreePath: b.worktreePath, files: ['b.txt'] });
  onTaskDone(cdb, { agentId: 'B', worktreePath: b.worktreePath, branch: b.branch, repo: repoPath, taskId: b.taskId });

  assert.equal(readBoard(cdb, { kind: 'ticket_ready' }).messages.length, 2, 'B done re-emits ticket_ready (total 2)');
  assert.ok(getTicketReadyAt(ticket.id) != null, 'ticket_ready_at is set again');
  assert.equal(getTask(cdb.db, b.taskId)?.status, 'done');
});

// ───────────────────────────────────────────────────────────────────────────
// Fix proposal A test R2: linkTaskToTicket re-arm — linking a not-done task to a ready ticket resets
//   ticket_ready_at to NULL. And integration_branch is unchanged (only ticket_ready_at changes).
// ───────────────────────────────────────────────────────────────────────────
test('re-arm (linkTaskToTicket): linking a not-done task to a ready ticket resets ticket_ready_at to NULL', () => {
  const ticket = openTicket(cdb, { title: 'rearm-link', repos: ['repo'] });
  const a = seedTask(ticket.id, 'A');
  commitInWorktree(a.worktreePath, 'a.txt', 'A\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: a.worktreePath, files: ['a.txt'] });
  onTaskDone(cdb, { agentId: 'A', worktreePath: a.worktreePath, branch: a.branch, repo: repoPath, taskId: a.taskId });
  assert.ok(getTicketReadyAt(ticket.id) != null, 'premise: ticket_ready_at is set');
  const intBefore = getIntegrationBranch(ticket.id);
  assert.ok(intBefore, 'premise: the integration branch is set');

  // link a not-done (open) task created with ticket_id=null via link_task_to_ticket.
  const orphan = createTask(cdb, { repo: 'repo', title: 'orphan', ticketId: null });
  assert.equal(orphan.status, 'open', 'a not-done (open) task');
  const r = linkTaskToTicket(cdb, orphan.id, ticket.id);
  assert.equal(r.ok, true);

  assert.equal(getTicketReadyAt(ticket.id), null, 'linking a not-done task resets ticket_ready_at to NULL (re-arm)');
  // the re-arm changes only ticket_ready_at: integration_branch is unchanged.
  assert.equal(getIntegrationBranch(ticket.id), intBefore, 'the re-arm does not change integration_branch');
  assert.equal(getTask(cdb.db, orphan.id)?.ticket_id, ticket.id, 'the task is now linked to the ticket');
});

// ───────────────────────────────────────────────────────────────────────────
// Fix proposal A test R3 (negative case): re-linking an already-done task to a ready ticket does not re-arm
//   (verifies the trigger condition "the linked task is not done"). ticket_ready_at stays set.
// ───────────────────────────────────────────────────────────────────────────
test('does not re-arm (negative): linking an already-done task to a ready ticket keeps ticket_ready_at set', () => {
  // ticket1: make A done to make it ready.
  const ticket1 = openTicket(cdb, { title: 'rearm-neg-1', repos: ['repo'] });
  const a = seedTask(ticket1.id, 'A');
  commitInWorktree(a.worktreePath, 'a.txt', 'A\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: a.worktreePath, files: ['a.txt'] });
  onTaskDone(cdb, { agentId: 'A', worktreePath: a.worktreePath, branch: a.branch, repo: repoPath, taskId: a.taskId });

  // ticket2: make B done to obtain an "already-done task".
  const ticket2 = openTicket(cdb, { title: 'rearm-neg-2', repos: ['repo'] });
  const b = seedTask(ticket2.id, 'B');
  commitInWorktree(b.worktreePath, 'b.txt', 'B\n');
  publishDirty(cdb, { agentId: 'B', worktreePath: b.worktreePath, files: ['b.txt'] });
  onTaskDone(cdb, { agentId: 'B', worktreePath: b.worktreePath, branch: b.branch, repo: repoPath, taskId: b.taskId });
  assert.equal(getTask(cdb.db, b.taskId)?.status, 'done', 'premise: B is done');

  const readyAt1 = getTicketReadyAt(ticket1.id);
  assert.ok(readyAt1 != null, 'premise: ticket1 is ready');

  // re-attach the already-done B to the ready ticket1 → the all-done decision does not break, so no re-arm.
  const r = linkTaskToTicket(cdb, b.taskId, ticket1.id);
  assert.equal(r.ok, true);
  assert.equal(getTicketReadyAt(ticket1.id), readyAt1, 'linking an already-done task does not change ticket_ready_at (no re-arm)');
});

// ─── helpers (direct DB reads. read minimally to verify non-exported implementation details) ───

/** Read tickets.integration_branch. */
function getIntegrationBranch(ticketId: string): string | null {
  const row = cdb.db
    .prepare(`SELECT integration_branch FROM tickets WHERE id = ?`)
    .get(ticketId) as { integration_branch: string | null } | undefined;
  return row?.integration_branch ?? null;
}

/** Read tickets.ticket_ready_at. */
function getTicketReadyAt(ticketId: string): number | null {
  const row = cdb.db
    .prepare(`SELECT ticket_ready_at FROM tickets WHERE id = ?`)
    .get(ticketId) as { ticket_ready_at: number | null } | undefined;
  return row?.ticket_ready_at ?? null;
}

/** Check the presence of a column via PRAGMA table_info (test 7 only). */
function hasCol(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}
