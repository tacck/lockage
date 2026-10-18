import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type CoordDb } from '../src/db/index.js';
import { createTask, claimTask, getTask, releaseTask } from '../src/lockage/claim.js';
import { assignWorktree } from '../src/lockage/worktree.js';
import { publishDirty, claimFiles, listClaims } from '../src/lockage/files.js';
import { openTicket } from '../src/lockage/tickets.js';
import {
  enqueueMerge,
  processMergeQueue,
  onTaskDone,
  isSmallTask,
  tryImmediateMerge,
  listMergeQueue,
} from '../src/lockage/merge.js';
import { postBoard, readBoard, listUnread, takePendingWakes } from '../src/lockage/board.js';

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

/** Change a file directly on the main branch and commit (mainline advances = create divergence). */
function commitOnMain(file: string, content: string): void {
  git(repoPath, ['checkout', '-q', 'main']);
  writeFileSync(join(repoPath, file), content);
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', `main edits ${file}`]);
}

before(() => {
  root = mkdtempSync(join(SCRATCH, 'lockage-merge-'));
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
  // return to the initial state with only README.md (clean with reset)
  const firstCommit = git(repoPath, ['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0];
  git(repoPath, ['reset', '-q', '--hard', firstCommit]);
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
    // delete lockage/* branches
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
  // clean up any leftover .lockage
  const lockageDir = join(repoPath, '.lockage');
  if (existsSync(lockageDir)) rmSync(lockageDir, { recursive: true, force: true });
});

test('enqueue_merge: seq is MAX+1, monotonically increasing, returns position', () => {
  const t1 = createTask(cdb, { repo: 'repo', title: 't1' });
  const t2 = createTask(cdb, { repo: 'repo', title: 't2' });
  const a = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t1.id });
  const b = assignWorktree(cdb, { agentId: 'B', repoPath, taskId: t2.id });

  const r1 = enqueueMerge(cdb, {
    agentId: 'A',
    worktreePath: a.worktree_path,
    branch: a.branch,
    repo: repoPath,
    taskId: t1.id,
  });
  const r2 = enqueueMerge(cdb, {
    agentId: 'B',
    worktreePath: b.worktree_path,
    branch: b.branch,
    repo: repoPath,
    taskId: t2.id,
  });
  assert.equal(r1.position, 1);
  assert.equal(r2.position, 2);
  assert.equal(listMergeQueue(cdb, 'queued').length, 2);
});

test('process_merge_queue: no conflict means auto-merge (1-B) and reflected onto main', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'feat' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  commitInWorktree(w.worktree_path, 'feature.txt', 'hello\n');
  // publish the dirty set (used by the merge gate's 3-way precheck)
  publishDirty(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    files: ['feature.txt'],
  });

  enqueueMerge(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  const r = processMergeQueue(cdb);

  assert.equal(r.merged.length, 1);
  assert.equal(r.merged[0]?.path, '1-B');
  assert.equal(r.needs_review.length, 0);
  // feature.txt is reflected onto main
  git(repoPath, ['checkout', '-q', 'main']);
  assert.ok(existsSync(join(repoPath, 'feature.txt')));
  // merged state, dirty cleared
  assert.equal(listMergeQueue(cdb, 'merged').length, 1);
  assert.equal(listMergeQueue(cdb, 'queued').length, 0);
});

test('3-way precheck: if files touched by mainline intersect the dirty set, send back as needs_review', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'feat' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  // edit shared.txt in the worktree
  commitInWorktree(w.worktree_path, 'shared.txt', 'from-A\n');
  publishDirty(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    files: ['shared.txt'],
  });
  // after branching, also edit the same shared.txt on main (create divergence)
  commitOnMain('shared.txt', 'from-main\n');

  enqueueMerge(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  const r = processMergeQueue(cdb);

  assert.equal(r.merged.length, 0);
  assert.equal(r.needs_review.length, 1);
  assert.deepEqual(r.needs_review[0]?.contested, ['shared.txt']);
  assert.deepEqual(r.wake_targets, ['A']); // enumerate the send-back peer as a wake target
  const nr = listMergeQueue(cdb, 'needs_review');
  assert.equal(nr.length, 1);
  assert.ok(nr[0]?.precheck?.includes('shared.txt'));
  // A is notified by the unread handoff post alone; no board wake on top (it made A wake twice).
  assert.deepEqual(
    listUnread(cdb, 'A').map((m) => [m.kind, m.ref_task_id]),
    [['handoff', t.id]],
  );
  assert.deepEqual(takePendingWakes(cdb, 'A', 'board'), []);
});

test('process_merge_queue: serial processing in seq ascending (mixed: 1 auto-merge + 1 send-back)', () => {
  // A is a non-conflicting file, B is a file that conflicts with main
  const tA = createTask(cdb, { repo: 'repo', title: 'A' });
  const tB = createTask(cdb, { repo: 'repo', title: 'B' });
  const wA = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: tA.id });
  const wB = assignWorktree(cdb, { agentId: 'B', repoPath, taskId: tB.id });
  commitInWorktree(wA.worktree_path, 'a.txt', 'A\n');
  commitInWorktree(wB.worktree_path, 'conflict.txt', 'B\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: wA.worktree_path, files: ['a.txt'] });
  publishDirty(cdb, { agentId: 'B', worktreePath: wB.worktree_path, files: ['conflict.txt'] });
  // main touches conflict.txt → only B is a conflict candidate
  commitOnMain('conflict.txt', 'main\n');

  enqueueMerge(cdb, { agentId: 'A', worktreePath: wA.worktree_path, branch: wA.branch, repo: repoPath, taskId: tA.id });
  enqueueMerge(cdb, { agentId: 'B', worktreePath: wB.worktree_path, branch: wB.branch, repo: repoPath, taskId: tB.id });
  const r = processMergeQueue(cdb);

  assert.equal(r.merged.length, 1);
  assert.equal(r.merged[0]?.task_id, tA.id);
  assert.equal(r.needs_review.length, 1);
  assert.equal(r.needs_review[0]?.task_id, tB.id);
});

test('is_small_task: no parent ticket and mainline not advanced means a small task (1-C target)', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  commitInWorktree(w.worktree_path, 'x.txt', 'x\n');
  const small = isSmallTask(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(small, true);
});

test('is_small_task: if the mainline advanced after branching it is not a small task (to 1-B)', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  commitInWorktree(w.worktree_path, 'x.txt', 'x\n');
  commitOnMain('other.txt', 'moved\n'); // mainline advances
  const small = isSmallTask(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(small, false);
});

test('try_immediate_merge: zero conflict candidates means merge-and-discard immediately (1-C), the worktree disappears', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  // to be set done via 1-C it must be in_progress (claimed)
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'quick.txt', 'q\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['quick.txt'] });

  const res = tryImmediateMerge(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(res.ok, true);
  // reflected onto main and the worktree is discarded
  git(repoPath, ['checkout', '-q', 'main']);
  assert.ok(existsSync(join(repoPath, 'quick.txt')));
  assert.equal(existsSync(w.worktree_path), false);
  // the task is done
  assert.equal(getTask(cdb.db, t.id)?.status, 'done');
});

test('on_task_done: a small task is merged immediately via 1-C', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'done.txt', 'd\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['done.txt'] });

  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.merged.length === 1);
  assert.ok(r.ok && r.merged[0]?.path === '1-C');
  // not enqueued (the immediate-merge path)
  assert.equal(listMergeQueue(cdb).length, 0);
  // the task is done (this is the point of this bug fix)
  assert.equal(getTask(cdb.db, t.id)?.status, 'done');
});

test('Issue #49 auto-resolution (done path): when task_done makes it done, the linked unresolved question is auto-resolved', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  // leave one question linked to this task (the reason it got stuck, on the board).
  const q = postBoard(cdb, { agentId: 'A', body: 'waiting on a design decision', kind: 'question', refTaskId: t.id });
  // a separate question without ref_task_id is not a target of auto-resolution (for manual resolution = resolve_question).
  const other = postBoard(cdb, { agentId: 'A', body: 'unrelated', kind: 'question' });

  commitInWorktree(w.worktree_path, 'done.txt', 'd\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['done.txt'] });
  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, true);
  assert.equal(getTask(cdb.db, t.id)?.status, 'done');

  // the linked question is auto-resolved at the done-confirmation point and disappears from unresolved_only.
  const resolved = cdb.db
    .prepare('SELECT resolved_at, resolved_by FROM board_messages WHERE id = ?')
    .get(q.message_id) as { resolved_at: number | null; resolved_by: string | null };
  assert.notEqual(resolved.resolved_at, null);
  assert.equal(resolved.resolved_by, 'A'); // the assignee who confirmed done
  // a question without ref_task_id stays unresolved.
  const unresolved = readBoard(cdb, { kind: 'question', unresolvedOnly: true });
  const ids = unresolved.messages.map((m) => m.id);
  assert.ok(ids.includes(other.message_id));
  assert.ok(!ids.includes(q.message_id));
});

test('on_task_done: mainline advancing drops the small-task decision and it merges via 1-B', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'feat' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'feat.txt', 'f\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['feat.txt'] });
  commitOnMain('unrelated.txt', 'moved\n'); // mainline advances → is_small_task=false. but no conflict

  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.merged.length === 1);
  assert.ok(r.ok && r.merged[0]?.path === '1-B'); // via the serial gate
  assert.equal(listMergeQueue(cdb, 'merged').length, 1);
  // the task is done even via 1-B
  assert.equal(getTask(cdb.db, t.id)?.status, 'done');
});

test('1-C: even passing the worktree path as repo, it merges on the main repo and the worktree is released (#33/#69)', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'wt.txt', 'w\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['wt.txt'] });

  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: w.worktree_path, // ← the value a working agent naturally tends to pass
    taskId: t.id,
  });

  assert.equal(r.ok, true);
  assert.ok(r.ok && r.merged[0]?.path === '1-C');
  // since we no longer write events.jsonl, there is no side effect of an untracked file written directly
  // under the worktree causing git worktree remove to refuse. the worktree is reliably released.
  assert.equal(existsSync(w.worktree_path), false, 'the worktree is released');
});

test('process_merge_queue: an empty queue is a no-op', () => {
  const r = processMergeQueue(cdb);
  assert.deepEqual(r, { merged: [], needs_review: [], wake_targets: [] });
});

test('done transition: a task sent back to needs_review does not become done (stays in_progress)', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'feat' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'shared.txt', 'from-A\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['shared.txt'] });
  commitOnMain('shared.txt', 'from-main\n'); // create a conflict candidate

  enqueueMerge(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  const r = processMergeQueue(cdb);
  assert.equal(r.needs_review.length, 1);
  // a send-back, so not done; stays in_progress (the assignee resolves and re-runs task_done)
  assert.equal(getTask(cdb.db, t.id)?.status, 'in_progress');
});

test('on_task_done validation: if there is no active worktree assignment, no_active_worktree', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'x' });
  claimTask(cdb, t.id, 'A', t.version);
  // misuse of passing the main repo path as worktree_path without assigning a worktree
  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: repoPath,
    branch: 'feature',
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === 'no_active_worktree');
  // the task stays in_progress (misuse does not set it done)
  assert.equal(getTask(cdb.db, t.id)?.status, 'in_progress');
});

test('on_task_done validation: if branch equals base, branch_is_base', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'x' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  claimTask(cdb, t.id, 'A', t.version);
  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: 'main', // same as base (prevents accidental merge into the main tree)
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === 'branch_is_base');
});

test('on_task_done validation: if I have my own worktree assignment but the task assignee is someone else, not_assignee', () => {
  // A claims the task. B has their own worktree but tries to task_done A's task_id.
  const t = createTask(cdb, { repo: 'repo', title: 'shared-task' });
  claimTask(cdb, t.id, 'A', t.version); // assignee = A
  const wB = assignWorktree(cdb, { agentId: 'B', repoPath }); // B's worktree (no task link)
  commitInWorktree(wB.worktree_path, 'b.txt', 'b\n');
  const r = onTaskDone(cdb, {
    agentId: 'B',
    worktreePath: wB.worktree_path,
    branch: wB.branch,
    repo: repoPath,
    taskId: t.id, // A's task
  });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === 'not_assignee');
  // A's task does not become done
  assert.equal(getTask(cdb.db, t.id)?.status, 'in_progress');
});

test('high-2/high-1: even if dirty is unpublished, detect a real git conflict and terminalize to needs_review (queue does not halt)', () => {
  // do not call publish_dirty → the advisory dirty set is empty. previously contested was empty and it
  // proceeded to auto-merge, the git merge threw on a real conflict → the row stayed merging and the queue
  // halted (high-1/high-2).
  const t = createTask(cdb, { repo: 'repo', title: 'feat' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  claimTask(cdb, t.id, 'A', t.version);
  commitInWorktree(w.worktree_path, 'shared.txt', 'from-A\n');
  // do not publish dirty (this is the crux)
  commitOnMain('shared.txt', 'from-main\n'); // a real conflict with the mainline

  enqueueMerge(cdb, { agentId: 'A', worktreePath: w.worktree_path, branch: w.branch, repo: repoPath, taskId: t.id });
  const r = processMergeQueue(cdb);

  // git-real detection sends it back to needs_review and no merging row remains in the queue
  assert.equal(r.merged.length, 0);
  assert.equal(r.needs_review.length, 1);
  assert.equal(listMergeQueue(cdb, 'merging').length, 0, 'no merging remains (the queue does not halt)');
  assert.equal(listMergeQueue(cdb, 'needs_review').length, 1);
  // the task does not become done; stays in_progress
  assert.equal(getTask(cdb.db, t.id)?.status, 'in_progress');
  // confirm processing proceeds even with a subsequent queued (the queue is alive).
  // use a different agent B (same A could collide on the deterministic branch name lockage/A/<slug>).
  const t2 = createTask(cdb, { repo: 'repo', title: 'next' });
  const w2 = assignWorktree(cdb, { agentId: 'B', repoPath, taskId: t2.id });
  claimTask(cdb, t2.id, 'B', t2.version);
  commitInWorktree(w2.worktree_path, 'other.txt', 'x\n');
  publishDirty(cdb, { agentId: 'B', worktreePath: w2.worktree_path, files: ['other.txt'] });
  enqueueMerge(cdb, { agentId: 'B', worktreePath: w2.worktree_path, branch: w2.branch, repo: repoPath, taskId: t2.id });
  const r2 = processMergeQueue(cdb);
  assert.equal(r2.merged.length, 1, 'the next item can merge after a needs_review');
});

test('high-1: on a merge failure the working tree is restored to its original state (merge --abort + base restore)', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'feat' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  claimTask(cdb, t.id, 'A', t.version);
  commitInWorktree(w.worktree_path, 'shared.txt', 'from-A\n');
  commitOnMain('shared.txt', 'from-main\n');

  enqueueMerge(cdb, { agentId: 'A', worktreePath: w.worktree_path, branch: w.branch, repo: repoPath, taskId: t.id });
  processMergeQueue(cdb);

  // the main repository's working tree is clean (no mid-merge conflict markers remain)
  const status = git(repoPath, ['status', '--porcelain']);
  assert.equal(status, '', 'the working tree is restored clean after a merge failure');
  // main's shared.txt stays the mainline content (not broken)
  git(repoPath, ['checkout', '-q', 'main']);
  const content = readFileSync(join(repoPath, 'shared.txt'), 'utf8');
  assert.ok(content.includes('from-main'), 'main\'s content is preserved');
});

test('high-1 (the key one): even if threeWayPrecheck throws (nonexistent branch), terminalize to needs_review and the queue proceeds', () => {
  // enqueueMerge only creates the merge_queue row and does not touch git. At processing time
  // `git merge-base base <branch>` inside threeWayPrecheck exits non-zero on an unknown branch → throws.
  // Previously it stayed merging and the queue permanently halted; the key fix terminalizes to
  // needs_review in catch and continues the loop.
  const t = createTask(cdb, { repo: 'repo', title: 'ghost' });
  enqueueMerge(cdb, {
    agentId: 'A',
    worktreePath: join(root, 'nonexistent-wt'),
    branch: 'lockage/does-not-exist', // a branch not present in the repo → merge-base throws
    repo: repoPath,
    taskId: t.id,
  });
  // also enqueue a subsequent normal item (to verify the queue is alive).
  const t2 = createTask(cdb, { repo: 'repo', title: 'next' });
  const w2 = assignWorktree(cdb, { agentId: 'B', repoPath, taskId: t2.id });
  claimTask(cdb, t2.id, 'B', t2.version);
  commitInWorktree(w2.worktree_path, 'ok.txt', 'ok\n');
  publishDirty(cdb, { agentId: 'B', worktreePath: w2.worktree_path, files: ['ok.txt'] });
  enqueueMerge(cdb, {
    agentId: 'B',
    worktreePath: w2.worktree_path,
    branch: w2.branch,
    repo: repoPath,
    taskId: t2.id,
  });

  // runs to completion without letting the throw escape (if an exception flies here the test fails).
  const r = processMergeQueue(cdb);

  // no merging remains (the queue does not permanently halt).
  assert.equal(listMergeQueue(cdb, 'merging').length, 0, 'no merging remains (the queue does not halt)');
  // the ghost row is terminalized to needs_review (with error).
  const nr = listMergeQueue(cdb, 'needs_review');
  assert.equal(nr.length, 1, 'the ghost row is terminalized to needs_review');
  assert.ok(nr[0]?.precheck?.includes('error'), 'error is recorded in precheck');
  assert.equal(r.needs_review.length, 1);
  assert.ok(r.needs_review[0]?.error, 'the needs_review entry has an error summary');
  assert.ok(r.wake_targets.includes('A'), 'the terminalized peer is enumerated as a wake target');
  // the subsequent item merges normally, showing the queue proceeded.
  assert.equal(r.merged.length, 1, 'the next one can merge after a threeWayPrecheck throw');
  assert.equal(r.merged[0]?.task_id, t2.id);
  assert.equal(listMergeQueue(cdb, 'merged').length, 1);
});

test('mid-C (1-C divergence): if completeTask\'s CAS fails, do not discard the worktree; keep it', () => {
  // during a 1-C immediate merge, create a situation where the mainline merge succeeds but completeTask
  // mismatches on CAS. After claiming (in_progress), return it to open as if by a lease sweep = assignee/
  // status is broken. Then finalizeMergedTask's completeTask is changes==0. Previously it discarded the
  // worktree; after the fix keepBranch keeps it to leave "merged into mainline, not done, worktree remains"
  // as a clue for manual recovery.
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'quick.txt', 'q\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['quick.txt'] });

  // lease-sweep equivalent: return in_progress to open and clear assignee (make completeTask's CAS fail).
  cdb.db
    .prepare(
      `UPDATE tasks SET status = 'open', assignee = NULL, heartbeat_at = NULL WHERE id = ?`,
    )
    .run(t.id);

  const res = tryImmediateMerge(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  // the merge itself succeeds (ok=true).
  assert.equal(res.ok, true);
  // it is reflected onto main (merged into the mainline).
  git(repoPath, ['checkout', '-q', 'main']);
  assert.ok(existsSync(join(repoPath, 'quick.txt')), 'merged into the mainline');
  // but the worktree is kept, not discarded (a clue for manual recovery).
  assert.equal(existsSync(w.worktree_path), true, 'keep the worktree when CAS fails');
  // the task does not become done and the worktree is kept (= a merged_not_completed-like state).
  assert.notEqual(getTask(cdb.db, t.id)?.status, 'done');
});

test('mid (2-process miss): on_task_done fills the final state of its own merge_id into the result (no duplicate in the normal path)', () => {
  // the normal path where mainline advancing enters the 1-B path and processing marks its own item merged.
  // confirm the filling logic does not create a duplicate with r.merged and there is exactly 1.
  const t = createTask(cdb, { repo: 'repo', title: 'feat' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  claimTask(cdb, t.id, 'A', t.version);
  commitInWorktree(w.worktree_path, 'feat.txt', 'f\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['feat.txt'] });
  commitOnMain('unrelated.txt', 'moved\n'); // mainline advances → 1-B path. no conflict.

  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, true);
  // filling does not create a duplicate; merged is exactly 1.
  assert.ok(r.ok && r.merged.length === 1, 'no duplicate from filling (1 item)');
  assert.ok(r.ok && r.merged[0]?.task_id === t.id);
  assert.equal(listMergeQueue(cdb, 'merged').length, 1);
});

// ── bug 2 (found during the smoke test): a repo identifier is misused as an FS path ──────────────
// In a real claude smoke, a worker passed create_task's repo identifier ("smoke-repo") directly to
// task_done's repo arg, and `git -C smoke-repo` failed with "cannot change to 'smoke-repo'". The worktree
// is created with the correct FS root, yet onTaskDone passed the caller's repo to git -C without validating
// or self-healing it. It should resolve the correct FS root from the worktree row.

test('bug 2: even passing a repo identifier (not an FS path) to onTaskDone, it merges on the worktree\'s real repo', () => {
  // the repo identifier is an arbitrary string that is not a directory name (equivalent to the smoke's "smoke-repo").
  // the worktree is created with the correct repoPath, but the worker passes the identifier as the repo arg.
  const repoId = 'proj-alpha'; // an identifier that is not an FS path
  const t = createTask(cdb, { repo: repoId, title: 'leaf' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id }); // worktree is the correct FS root
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'alpha.txt', 'a\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['alpha.txt'] });

  // the worker passes the "identifier" as the repo arg (the smoke's real behavior).
  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoId, // ← an identifier, not an FS path. previously git -C proj-alpha fails
    taskId: t.id,
  });

  // expected: re-resolve the correct FS root from the worktree row, the merge succeeds, the task becomes done.
  assert.equal(r.ok, true, 'even with a repo identifier the merge succeeds (the worktree\'s real repo is the source of truth)');
  assert.ok(r.ok && r.merged.length === 1, '1 merge');
  // it is actually reflected onto main (evidence git -C ran with the correct FS root).
  git(repoPath, ['checkout', '-q', 'main']);
  assert.ok(existsSync(join(repoPath, 'alpha.txt')), 'merged into the mainline');
  // the task is done (the worker becomes done without self-recovery).
  assert.equal(getTask(cdb.db, t.id)?.status, 'done');
});

test('bug 2: even on the 1-B serial gate it merges correctly with a repo identifier', () => {
  // even in the case where mainline advancing enters the 1-B path, enqueue→process merges on the worktree's real repo.
  const repoId = 'proj-beta';
  const t = createTask(cdb, { repo: repoId, title: 'feat' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  claimTask(cdb, t.id, 'A', t.version);
  commitInWorktree(w.worktree_path, 'beta.txt', 'b\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['beta.txt'] });
  commitOnMain('unrelated.txt', 'moved\n'); // mainline advances → 1-B path (no conflict)

  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoId, // identifier
    taskId: t.id,
  });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.merged.length === 1, '1 merge');
  assert.ok(r.ok && r.merged[0]?.path === '1-B', 'via the serial gate');
  git(repoPath, ['checkout', '-q', 'main']);
  assert.ok(existsSync(join(repoPath, 'beta.txt')), 'merged into the mainline');
  assert.equal(getTask(cdb.db, t.id)?.status, 'done');
});

test('mid (2-process miss): if another path is merging, my item stays queued and is not filled (making the limit explicit)', () => {
  // as a stand-in for another process, place one merging row first. processMergeQueue inside onTaskDone
  // breaks at the top inflight check, so my item stays queued. queued is "not yet processed" so it is not a
  // fill target (not set to merged/needs_review) = no false report.
  const blocker = createTask(cdb, { repo: 'repo', title: 'blocker' });
  const wb = assignWorktree(cdb, { agentId: 'Z', repoPath, taskId: blocker.id });
  const rb = enqueueMerge(cdb, {
    agentId: 'Z',
    worktreePath: wb.worktree_path,
    branch: wb.branch,
    repo: repoPath,
    taskId: blocker.id,
  });
  // fix it to merging as if another path is processing (equivalent to COMMIT-ted).
  cdb.db.prepare(`UPDATE merge_queue SET state = 'merging' WHERE id = ?`).run(rb.merge_id);

  const t = createTask(cdb, { repo: 'repo', title: 'feat' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  claimTask(cdb, t.id, 'A', t.version);
  commitInWorktree(w.worktree_path, 'feat.txt', 'f\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['feat.txt'] });
  commitOnMain('unrelated.txt', 'moved\n'); // to the 1-B path

  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, true);
  // my item stays queued (waiting for the other path's processing). does not wrongly go into merged/needs_review.
  assert.ok(r.ok && r.merged.length === 0, 'while queued, no false report into merged');
  assert.ok(r.ok && r.needs_review.length === 0, 'while queued, no false report into needs_review');
  assert.equal(listMergeQueue(cdb, 'queued').length, 1, 'my item stays queued');
});

// ── Issue #25 (option 1: temporary-worktree approach): do not touch the main repository's working tree ──────────
// safeMerge performs the merge on a temporary worktree, so after a successful 1-B/1-C merge the main
// working tree's current branch, checkout state, and uncommitted changes do not change at all. Also the
// temporary worktree is cleaned up on both success and failure, leaving no debris.

/** Return the list of all worktree paths registered in the repo (main, assigned, temporary). */
function listWorktrees(): string[] {
  const list = git(repoPath, ['worktree', 'list', '--porcelain']);
  const paths: string[] = [];
  for (const line of list.split('\n')) {
    if (line.startsWith('worktree ')) {
      paths.push(line.slice('worktree '.length));
    }
  }
  return paths;
}

test('Issue #25 (1-B): the main repository\'s current branch does not change even after a successful merge', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'feat' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  claimTask(cdb, t.id, 'A', t.version);
  commitInWorktree(w.worktree_path, 'feat.txt', 'f\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['feat.txt'] });
  commitOnMain('unrelated.txt', 'moved\n'); // mainline advances → 1-B path (no conflict)

  // put the main repo on a branch other than main (a state different from the merge target baseBranch=main).
  git(repoPath, ['checkout', '-q', '-b', 'work-local-1b']);
  const headBefore = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // to confirm no temporary merge worktree remains, record the set of worktrees before processing.
  // 1-B keeps the assigned worktree with keepBranch=true, so it is enough that no worktree is added after
  // processing (= safeMerge's temporary worktree was cleaned up).
  const worktreesBefore = new Set(listWorktrees());
  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.merged[0]?.path === '1-B', 'via the serial gate');

  // the main repo's current branch is unchanged from before the merge (not switched to the integration target main = the point of this bug fix).
  const headAfter = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.equal(headAfter, headBefore, 'the main repo\'s current branch did not change');
  assert.equal(headAfter, 'work-local-1b', 'the main repo stays on its original branch (work-local-1b)');
  // no temporary merge worktree remains (the worktree set did not grow before/after processing).
  const addedAfter = listWorktrees().filter((p) => !worktreesBefore.has(p));
  assert.deepEqual(addedAfter, [], 'no temporary worktree remains');
  // the mainline (main) reflects the merge result.
  assert.equal(git(repoPath, ['ls-tree', '--name-only', 'main', 'feat.txt']), 'feat.txt');
});

test('Issue #25 (1-B): even with uncommitted changes in the main repo the merge succeeds and those changes are preserved', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'feat' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  claimTask(cdb, t.id, 'A', t.version);
  commitInWorktree(w.worktree_path, 'feat.txt', 'f\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['feat.txt'] });
  commitOnMain('unrelated.txt', 'moved\n'); // mainline advances → 1-B path

  // review note (significance): if the main repo is on baseBranch (main), the old impl (checkout main +
  // merge on the main repo) is also "already on main so checkout is harmless", and this test would pass on
  // a revert, missing the regression. So verify with the main repo on a branch other than baseBranch. The
  // old impl runs `checkout main` on the main repo (= the current branch switches from work-local-1b-dirty
  // to main), while the new impl (temporary-worktree approach) leaves the main branch unchanged. This
  // directly tests the fix.
  git(repoPath, ['checkout', '-q', '-b', 'work-local-1b-dirty']);
  // create an uncommitted change (a new, untracked file) on this non-base branch.
  writeFileSync(join(repoPath, 'uncommitted.txt'), 'wip\n');
  const headBefore = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.equal(headBefore, 'work-local-1b-dirty');

  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.merged[0]?.path === '1-B', 'via the serial gate');

  // the main repo's current branch did not change (the old impl would switch via checkout main = the point of this bug fix).
  assert.equal(
    git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    headBefore,
    'the main repo\'s current branch did not change (stays on the non-base branch)',
  );
  assert.equal(git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'work-local-1b-dirty');
  // the main repo's uncommitted change is preserved (proof the main tree was not touched).
  assert.ok(existsSync(join(repoPath, 'uncommitted.txt')), 'the uncommitted file is preserved');
  assert.equal(readFileSync(join(repoPath, 'uncommitted.txt'), 'utf8'), 'wip\n');
  // the mainline (main) reflects the merge result.
  assert.equal(git(repoPath, ['ls-tree', '--name-only', 'main', 'feat.txt']), 'feat.txt');
});

test('Issue #25 (1-C): even merging immediately while the main repo is on a non-baseBranch, the main branch is unchanged', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'quick.txt', 'q\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['quick.txt'] });

  // put the main repo on something other than baseBranch (main) → safeMerge uses the temporary-worktree approach.
  git(repoPath, ['checkout', '-q', '-b', 'work-local-1c']);
  const headBefore = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // record the worktree set before processing. on a 1-C success the assigned worktree itself is discarded
  // (keepBranch=false), so worktrees only decrease, never increase. confirm no temporary merge worktree is added.
  const worktreesBefore = new Set(listWorktrees());
  const res = tryImmediateMerge(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(res.ok, true);

  // the main repo's current branch did not change (even 1-C does not touch the main tree).
  assert.equal(git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']), headBefore);
  assert.equal(git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'work-local-1c');
  // no temporary merge worktree remains (the worktree set did not grow before/after processing).
  const addedAfter = listWorktrees().filter((p) => !worktreesBefore.has(p));
  assert.deepEqual(addedAfter, [], 'no temporary worktree remains');
  // the mainline (main) reflects the merge result and the task is done.
  assert.equal(git(repoPath, ['ls-tree', '--name-only', 'main', 'quick.txt']), 'quick.txt');
  assert.equal(getTask(cdb.db, t.id)?.status, 'done');
});

test('Issue #25 (1-C edge case): even while the main repo is on baseBranch the immediate merge succeeds and is reflected onto main', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'edge.txt', 'e\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['edge.txt'] });

  // put the main repo on baseBranch (=main, resolveBaseBranch=main for a minor task with no ticket).
  // in this state worktree add fails on a double checkout, so the main-repo merge path is used.
  git(repoPath, ['checkout', '-q', 'main']);
  const headBefore = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.equal(headBefore, 'main');
  // record the worktree set before processing (the main-repo merge path does not create a temporary worktree).
  const worktreesBefore = new Set(listWorktrees());

  const res = tryImmediateMerge(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(res.ok, true, 'the immediate merge succeeds even while the main repo is on baseBranch (the main-repo merge path)');

  // the main repo stays on main (already on baseBranch so no switch happens).
  assert.equal(git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  // the main-repo merge path does not create a temporary worktree (the worktree set did not grow before/after processing).
  const addedAfter = listWorktrees().filter((p) => !worktreesBefore.has(p));
  assert.deepEqual(addedAfter, [], 'no temporary worktree remains');
  // reflected onto main and the task is done.
  assert.ok(existsSync(join(repoPath, 'edge.txt')), 'edge.txt is reflected onto the main repo\'s main');
  assert.equal(getTask(cdb.db, t.id)?.status, 'done');
});

test('Issue #25 (1-C edge case): even with an unrelated uncommitted change while on baseBranch it is preserved', () => {
  // fix the behavior for review Issue #2: even if a merge runs on the main-repo merge path (main repo on
  // baseBranch=main), unrelated uncommitted changes in the main repo are not pulled in and are preserved.
  // this is a regression test that the main repo's uncommitted work is protected even in "main dirty + edge case".
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'edge2.txt', 'e2\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['edge2.txt'] });

  // put the main repo on baseBranch (main) and create an uncommitted change unrelated to the merge (an untracked file).
  git(repoPath, ['checkout', '-q', 'main']);
  writeFileSync(join(repoPath, 'local-wip.txt'), 'local\n');
  assert.equal(git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');

  const res = tryImmediateMerge(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(res.ok, true, 'the merge succeeds even on the main-repo merge path');

  // the main repo stays on main and the unrelated uncommitted change is preserved (not pulled in).
  assert.equal(git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.ok(existsSync(join(repoPath, 'local-wip.txt')), 'the unrelated uncommitted change is preserved');
  assert.equal(readFileSync(join(repoPath, 'local-wip.txt'), 'utf8'), 'local\n');
  // the merge result is reflected and the task is done.
  assert.ok(existsSync(join(repoPath, 'edge2.txt')), 'edge2.txt is reflected onto the main repo\'s main');
  assert.equal(getTask(cdb.db, t.id)?.status, 'done');
});

// ── Issue #45 (review item 4: direct coverage of the 1-B path): task_done →(merge queue)→ ──────────
// run the whole flow processMergeQueue → finalizeMergedTask → claim release through a real repository.
// Issue #45's main field case is "a done task under a ticket" (= 1-B), and the pure-function unit
// (test/claim-release.test.ts) only looks at releaseClaimsForTask alone. Here actually process the merge
// queue and confirm end-to-end that, as a side effect, the claim is released (= finalizeMergedTask's
// releaseClaimsForTask call works). This test is designed to fail if the releaseClaimsForTask call is
// removed from finalizeMergedTask.

test('Issue #45 (1-B): the merge confirmation from enqueue→processMergeQueue releases the claim', () => {
  // a task under a ticket (the main 1-B case). link the claim declared with claim_files to task_id.
  const ticket = openTicket(cdb, { title: '45-ticket', body: null });
  const t = createTask(cdb, { repo: 'repo', title: 'feat', ticketId: ticket.id });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  // declare a task_id-linked claim (in the field it is placed by claim_files).
  const cr = claimFiles(cdb, { agentId: 'A', globs: ['feature.txt'], taskId: t.id });
  assert.equal(listClaims(cdb, 'A').length, 1, 'before the merge the claim is active');

  commitInWorktree(w.worktree_path, 'feature.txt', 'hello\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['feature.txt'] });

  // explicitly drive the 1-B queue path (the same enqueue→process task_done does internally).
  enqueueMerge(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  const r = processMergeQueue(cdb);

  // the merge is established and the task becomes done (evidence finalizeMergedTask ran).
  assert.equal(r.merged.length, 1);
  assert.equal(r.merged[0]?.path, '1-B');
  assert.equal(getTask(cdb.db, t.id)?.status, 'done');
  // the key: as a side effect of the merge confirmation, the claim is released and does not appear in list_claims.
  assert.equal(listClaims(cdb, 'A').length, 0, 'the merge confirmation releases the task_id-linked claim');
  // the release is logical (sets released_at); the physical row remains for provenance tracking.
  const row = cdb.db
    .prepare(`SELECT released_at FROM claims WHERE id = ?`)
    .get(cr.claim_id) as { released_at: number | null } | undefined;
  assert.ok(row && row.released_at != null, 'the claim has released_at set and is logically released');
});

test('Issue #45 (1-B): via on_task_done (a task under a ticket) the claim is also released', () => {
  // run the field entry point task_done directly. a task under a ticket is isSmallTask=false so it does not
  // take 1-C; the enqueue→processMergeQueue (1-B) inside onTaskDone confirms the merge.
  const ticket = openTicket(cdb, { title: '45-ticket-done', body: null });
  const t = createTask(cdb, { repo: 'repo', title: 'feat', ticketId: ticket.id });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  claimFiles(cdb, { agentId: 'A', globs: ['done-feature.txt'], taskId: t.id });
  assert.equal(listClaims(cdb, 'A').length, 1, 'before task_done the claim is active');

  commitInWorktree(w.worktree_path, 'done-feature.txt', 'd\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['done-feature.txt'] });

  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.merged.length === 1 && r.merged[0]?.path === '1-B', 'merge via the 1-B path');
  assert.equal(getTask(cdb.db, t.id)?.status, 'done');
  // the 1-B merge confirmation (finalizeMergedTask) releases the claim.
  assert.equal(listClaims(cdb, 'A').length, 0, 'after task_done (after queue processing) the claim is released');
});

test('Issue #45 (1-B): if the merge is sent back to needs_review, the claim is not released', () => {
  // if the merge is not established (does not become done), finalizeMergedTask does not run so the claim remains.
  // fix the flip side of the "release only at the done-confirmation point" design (do not release too early).
  const ticket = openTicket(cdb, { title: '45-ticket-nr', body: null });
  const t = createTask(cdb, { repo: 'repo', title: 'feat', ticketId: ticket.id });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  claimTask(cdb, t.id, 'A', t.version);
  claimFiles(cdb, { agentId: 'A', globs: ['shared.txt'], taskId: t.id });

  commitInWorktree(w.worktree_path, 'shared.txt', 'from-A\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['shared.txt'] });
  commitOnMain('shared.txt', 'from-main\n'); // create a conflict candidate with the mainline → needs_review

  enqueueMerge(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  const r = processMergeQueue(cdb);
  assert.equal(r.needs_review.length, 1, 'sent back on a conflict candidate');
  assert.equal(getTask(cdb.db, t.id)?.status, 'in_progress', 'does not become done');
  // done not confirmed so the claim is kept (reconcile/TTL takes care of it later).
  assert.equal(listClaims(cdb, 'A').length, 1, 'a merge that does not become done does not release the claim');
});

// ── Issue #51 (proposal 3: task_done rescue for the lease-expired owner) ──────────────────────────────
// FEAT-002's piggyback extension removed the main cause, but if the owner called no lockage tool for a long
// time the sweep can still return it to open. When that owner (= still holding the active worktree
// assignment tied to that task) calls task_done, if no one re-claimed it, the owner re-claims it and
// continues. If another agent already claimed it, return not_assignee as before and do not steal.

test('Issue #51 (proposal 3): after lease expiry returns it to open, if no one re-claimed it the owner\'s task_done is rescued and becomes done', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  // owner A claims → worktree assignment (task_id linked) → work commit.
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'rescue.txt', 'r\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['rescue.txt'] });

  // lease-sweep equivalent: return in_progress to open and clear assignee (reproduce directly via UPDATE
  // the same final state sweepExpired at a future now does). keep the worktree assignment active and task_id linked.
  cdb.db
    .prepare(
      `UPDATE tasks SET status = 'open', assignee = NULL, heartbeat_at = NULL WHERE id = ?`,
    )
    .run(t.id);
  assert.equal(getTask(cdb.db, t.id)?.status, 'open');
  assert.equal(getTask(cdb.db, t.id)?.assignee, null);

  // with no one having re-claimed it, owner A calls task_done → it is rescued (re-claims itself) and becomes done.
  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, true, 'the lease-expired owner\'s task_done is rescued');
  assert.ok(r.ok && r.merged.length === 1, '1 merge');
  // reflected onto the mainline and the task is done. done is confirmed after the rescue restores assignee to A.
  git(repoPath, ['checkout', '-q', 'main']);
  assert.ok(existsSync(join(repoPath, 'rescue.txt')), 'merged into the mainline');
  assert.equal(getTask(cdb.db, t.id)?.status, 'done');
});

test('Issue #51 (proposal 3): if another agent claimed it first after lease expiry, the owner\'s task_done returns not_assignee and does not steal', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  // owner A claims → worktree assignment → work commit.
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'steal.txt', 's\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['steal.txt'] });

  // return to open / assignee NULL via a lease-sweep equivalent.
  cdb.db
    .prepare(
      `UPDATE tasks SET status = 'open', assignee = NULL, heartbeat_at = NULL WHERE id = ?`,
    )
    .run(t.id);

  // another agent B re-claims first (in_progress, assignee=B).
  const after = getTask(cdb.db, t.id)!;
  const bClaim = claimTask(cdb, t.id, 'B', after.version);
  assert.equal(bClaim.ok, true, 'B can re-claim first');
  assert.equal(getTask(cdb.db, t.id)?.assignee, 'B');

  // even if owner A calls task_done, it is not rescued and returns not_assignee (no stealing = prevent double work).
  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === 'not_assignee', 'not_assignee while another agent holds it');
  // assignee stays B unchanged and the task does not become done (no stealing).
  assert.equal(getTask(cdb.db, t.id)?.assignee, 'B', 'assignee stays the other agent');
  assert.equal(getTask(cdb.db, t.id)?.status, 'in_progress', 'stays in_progress held by B');
});

// ── Issue #55 (problem 2: the reason when the rescue re-claim loses the CAS) ──────────────────
// onTaskDone reads the task row then calls claimTask(expected_version). The race where another update cuts
// in between is not reproducible in a normal test order. So create a cdb that runs an interference exactly
// once right after onTaskDone reads the task row, to reproduce the CAS race.

/**
 * Return a cdb that runs interfere exactly once right after onTaskDone reads the task row (before claimTask).
 * Distinguish the target SQL by the same string as the read in onTaskDone's rescue decision (claimTask's
 * internal re-read is the same string too, so only the first time is interfered). fired() returns whether
 * the interference ran.
 */
function cdbInterferingAfterTaskRead(
  base: CoordDb,
  interfere: () => void,
): { cdb: CoordDb; fired: () => boolean } {
  const TASK_READ = 'SELECT assignee, status, version FROM tasks WHERE id = ?';
  let fired = false;
  const db = new Proxy(base.db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (fired || sql !== TASK_READ) return stmt;
          return new Proxy(stmt, {
            get(s, p) {
              if (p === 'get') {
                return (...args: Parameters<typeof s.get>) => {
                  const row = s.get(...args);
                  if (!fired) {
                    fired = true;
                    interfere();
                  }
                  return row;
                };
              }
              const v = Reflect.get(s, p, s);
              return typeof v === 'function' ? v.bind(s) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { cdb: { db, hostId: base.hostId, close: () => base.close() }, fired: () => fired };
}

/** owner A claims → work commit in a task_id-linked worktree → return to open / unassigned via a lease-sweep equivalent. */
function setupLeaseExpiredTask(file: string): {
  taskId: string;
  w: { worktree_path: string; branch: string };
} {
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  assert.equal(claimTask(cdb, t.id, 'A', t.version).ok, true);
  commitInWorktree(w.worktree_path, file, 'x\n');
  cdb.db
    .prepare(
      `UPDATE tasks SET status = 'open', assignee = NULL, heartbeat_at = NULL WHERE id = ?`,
    )
    .run(t.id);
  return { taskId: t.id, w };
}

test('Issue #55: even if the rescue re-claim loses the CAS, if the task is still open and unassigned it returns lease_expired', () => {
  const { taskId, w } = setupLeaseExpiredTask('race-open.txt');
  // only version advances between the read and the claim (another agent claimed and let go, etc.). stays unassigned.
  const racing = cdbInterferingAfterTaskRead(cdb, () => {
    cdb.db.prepare(`UPDATE tasks SET version = version + 1 WHERE id = ?`).run(taskId);
  });

  const r = onTaskDone(racing.cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId,
  });
  assert.ok(racing.fired(), 'interfered with the task-row read (onTaskDone\'s SQL matches TASK_READ)');
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === 'lease_expired', 'a retryable race is lease_expired');
  assert.equal(getTask(cdb.db, taskId)?.status, 'open', 'the task stays open');
  assert.equal(getTask(cdb.db, taskId)?.assignee, null, 'stays unassigned');

  // retrying (without interference) rescues it and it becomes done.
  const again = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId,
  });
  assert.equal(again.ok, true, 'the retry is rescued');
  assert.equal(getTask(cdb.db, taskId)?.status, 'done');
});

test('Issue #55: if the rescue re-claim loses the CAS and another agent claimed it in the meantime, it returns not_assignee and does not steal', () => {
  const { taskId, w } = setupLeaseExpiredTask('race-taken.txt');
  // another agent B claims between the read and the claim.
  const racing = cdbInterferingAfterTaskRead(cdb, () => {
    const cur = getTask(cdb.db, taskId)!;
    assert.equal(claimTask(cdb, taskId, 'B', cur.version).ok, true);
  });

  const r = onTaskDone(racing.cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId,
  });
  assert.ok(racing.fired(), 'interfered with the task-row read (onTaskDone\'s SQL matches TASK_READ)');
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === 'not_assignee', 'held by another agent is not_assignee');
  assert.equal(getTask(cdb.db, taskId)?.assignee, 'B', 'assignee stays the other agent');
  assert.equal(getTask(cdb.db, taskId)?.status, 'in_progress', 'stays in_progress held by B');
});

// ── Issue #55 (problem 1: an assignment with NULL task_id is not rescued) ───────────────────────────────
// When the lease expires the assignee is cleared, so the only remaining evidence of ownership is the
// assignment's task_id link. An assignment made with assign_worktree without passing task_id has no such
// evidence, so it is out of scope for the lease-expiry rescue.

test('Issue #55 (problem 1): with a NULL task_id worktree assignment, even if the owner calls task_done after lease expiry it is not rescued and returns not_assignee', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'leaf' });
  // assign without passing task_id (the old path). the task is claimed by owner A.
  const w = assignWorktree(cdb, { agentId: 'A', repoPath });
  assert.equal(claimTask(cdb, t.id, 'A', t.version).ok, true);
  commitInWorktree(w.worktree_path, 'null-task.txt', 'n\n');

  // return to open / unassigned via a lease-sweep equivalent.
  cdb.db
    .prepare(
      `UPDATE tasks SET status = 'open', assignee = NULL, heartbeat_at = NULL WHERE id = ?`,
    )
    .run(t.id);

  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === 'not_assignee', 'a NULL task_id assignment is not rescued');
  // did not re-claim (stays open / unassigned). not merged either.
  assert.equal(getTask(cdb.db, t.id)?.status, 'open');
  assert.equal(getTask(cdb.db, t.id)?.assignee, null);
  git(repoPath, ['checkout', '-q', 'main']);
  assert.equal(existsSync(join(repoPath, 'null-task.txt')), false, 'not merged into the mainline');

  // if the owner re-claims with the version from list_tasks, task_done goes through.
  const cur = getTask(cdb.db, t.id)!;
  assert.equal(claimTask(cdb, t.id, 'A', cur.version).ok, true);
  const again = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(again.ok, true, 'task_done after re-claiming goes through');
  assert.equal(getTask(cdb.db, t.id)?.status, 'done');
});

// ── regression test for events.jsonl removal (phase 5) ───────────────────────────────────
// since appendEvent was retired, no matter which merge path is taken, <repo>/.lockage/events.jsonl is not
// generated. beforeEach cleans up the previous test's leftover .lockage, so asserting that events.jsonl
// "does not exist" after each merge verifies "this merge did not create it".

/** Assert that <repo>/.lockage/events.jsonl does not exist. */
function assertNoEventsFile(label: string): void {
  assert.equal(
    existsSync(join(repoPath, '.lockage', 'events.jsonl')),
    false,
    `${label}: events.jsonl is not generated`,
  );
}

test('events.jsonl not generated: a 1-C immediate merge does not create events.jsonl', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'leaf-1c' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'ev-1c.txt', 'c\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['ev-1c.txt'] });

  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.merged[0]?.path === '1-C', 'zero divergence so a 1-C immediate merge');
  assertNoEventsFile('1-C');
});

test('events.jsonl not generated: a 1-B serial gate does not create events.jsonl', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'feat-1b' });
  const w = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: t.id });
  const claimed = claimTask(cdb, t.id, 'A', t.version);
  assert.equal(claimed.ok, true);
  commitInWorktree(w.worktree_path, 'ev-1b.txt', 'b\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['ev-1b.txt'] });
  commitOnMain('unrelated.txt', 'moved\n'); // mainline advances → 1-B path (no conflict)

  const r = onTaskDone(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: t.id,
  });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.merged[0]?.path === '1-B', 'divergence present so a 1-B serial gate');
  assertNoEventsFile('1-B');
});

test('events.jsonl not generated: even a merge without a task_id does not create events.jsonl', () => {
  // a merge not tied to a task (enqueueMerge's taskId=null). previously this path wrote only a merge.merged
  // event. after appendEvent retirement it writes nothing.
  const w = assignWorktree(cdb, { agentId: 'A', repoPath });
  commitInWorktree(w.worktree_path, 'ev-null.txt', 'n\n');
  publishDirty(cdb, { agentId: 'A', worktreePath: w.worktree_path, files: ['ev-null.txt'] });

  enqueueMerge(cdb, {
    agentId: 'A',
    worktreePath: w.worktree_path,
    branch: w.branch,
    repo: repoPath,
    taskId: null,
  });
  const r = processMergeQueue(cdb);
  assert.equal(r.merged.length, 1, 'even without a task the merge succeeds');
  assert.equal(r.merged[0]?.task_id, null);
  git(repoPath, ['checkout', '-q', 'main']);
  assert.ok(existsSync(join(repoPath, 'ev-null.txt')), 'merged into the mainline');
  assertNoEventsFile('no task_id');
});

// ───────────────────────────────────────────────────────────────────────────
// Issue #7 回帰テスト: チケットに done と abandoned のタスクしか残っていない場合に ticket_ready が出ること。
//   abandoned は終端状態なので「未完了」に数えてはならない。従来は tryEmitTicketReady が
//   `status != 'done'` だけで判定していたため、abandoned のタスクがあると ticket_ready が出なかった。
// ───────────────────────────────────────────────────────────────────────────
test('ticket_ready: a ticket with only done+abandoned tasks still emits ticket_ready (Issue #7)', () => {
  const ticket = openTicket(cdb, { title: 'issue-7', repos: ['repo'] });

  // タスク A・B を同じチケットに作る
  const taskA = createTask(cdb, { repo: 'repo', title: 'task-A', ticketId: ticket.id });
  const taskB = createTask(cdb, { repo: 'repo', title: 'task-B', ticketId: ticket.id });

  // A を claim して、何もしないうちに abandoned で取り下げる（releaseTask は in_progress が前提）
  const wa = assignWorktree(cdb, { agentId: 'A', repoPath, taskId: taskA.id });
  const claimedA = claimTask(cdb, taskA.id, 'A', taskA.version);
  assert.equal(claimedA.ok, true);
  const released = releaseTask(cdb, taskA.id, 'A', 'abandoned');
  assert.equal(released.ok, true);
  assert.equal(getTask(cdb.db, taskA.id)?.status, 'abandoned');
  // A を abandoned にした時点では B がまだ未完了なので ticket_ready は出ていない
  assert.equal(
    readBoard(cdb, { kind: 'ticket_ready' }).messages.length,
    0,
    'abandoned のみでは ticket_ready は出ない',
  );
  // worktree を使わないので A の割り当ては破棄してよい（存在だけ確認）
  assert.ok(wa.worktree_path);

  // B を claim → 成果をコミット → task_done。残りが done+abandoned のみになり ticket_ready が出るはず
  const wb = assignWorktree(cdb, { agentId: 'B', repoPath, taskId: taskB.id });
  const claimedB = claimTask(cdb, taskB.id, 'B', taskB.version);
  assert.equal(claimedB.ok, true);
  commitInWorktree(wb.worktree_path, 'b.txt', 'from-B\n');
  publishDirty(cdb, { agentId: 'B', worktreePath: wb.worktree_path, files: ['b.txt'] });

  const rb = onTaskDone(cdb, {
    agentId: 'B',
    worktreePath: wb.worktree_path,
    branch: wb.branch,
    repo: repoPath,
    taskId: taskB.id,
  });
  assert.ok(rb.ok, 'B の task_done が成功する');
  assert.equal(getTask(cdb.db, taskB.id)?.status, 'done');

  // done + abandoned のみになったので ticket_ready が 1 件出る（Issue #7 の修正点）
  const msgs = readBoard(cdb, { kind: 'ticket_ready' }).messages;
  assert.equal(msgs.length, 1, 'done+abandoned のみで ticket_ready が 1 件出る');
  assert.equal(
    msgs[0]?.ref_ticket_id,
    ticket.id,
    'ticket_ready の ref_ticket_id が当該チケットである',
  );
});
