import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { openDb, unixNow, type CoordDb } from '../src/db/index.js';
import { createTask } from '../src/lockage/claim.js';
import { openTicket } from '../src/lockage/tickets.js';
import {
  assignWorktree,
  releaseWorktree,
  listWorktrees,
  reclaimOrphanWorktrees,
  listStaleWorktrees,
} from '../src/lockage/worktree.js';

// Fall back to tmpdir so it also works in environments without $KIROCREW_SCRATCH.
const SCRATCH = process.env.KIROCREW_SCRATCH ?? tmpdir();

let root: string;
let repoPath: string;
let cdb: CoordDb;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

before(() => {
  root = mkdtempSync(join(SCRATCH, 'lockage-wt-'));
  repoPath = join(root, 'repo');
  mkdirSync(repoPath);
  // prepare a real git repository (main branch + initial commit)
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
  // each test uses an independent in-memory DB (but worktrees share the repo, so clean up physical
  // worktrees between tests)
  cdb?.close();
  cdb = openDb({ path: ':memory:', hostId: 'host-test' });
  // reset physical worktrees
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
  } catch {
    /* ignore */
  }
});

test('assign: a new assignment physically creates the worktree and branch', () => {
  const r = assignWorktree(cdb, { agentId: 'kiro-1', repoPath });
  assert.equal(r.reused, false);
  assert.equal(r.branch, 'lockage/kiro-1/kiro-1');
  assert.ok(existsSync(r.worktree_path), 'the physical directory exists');
  // the worktree is registered on the git side too
  const wl = git(repoPath, ['worktree', 'list']);
  assert.ok(wl.includes(r.worktree_path));
  // there is an active row in the DB
  const rows = listWorktrees(cdb, 'kiro-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].branch, r.branch);
});

test('assign: a re-call for the same agent reuses the existing one (idempotent)', () => {
  const a = assignWorktree(cdb, { agentId: 'kiro-1', repoPath });
  const b = assignWorktree(cdb, { agentId: 'kiro-1', repoPath });
  assert.equal(b.reused, true);
  assert.equal(a.worktree_path, b.worktree_path);
  assert.equal(a.branch, b.branch);
  // not double-registered
  assert.equal(listWorktrees(cdb, 'kiro-1').length, 1);
});

test('assign: passing task_id is reflected in the branch slug', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'T' });
  const r = assignWorktree(cdb, {
    agentId: 'claude-a',
    repoPath,
    taskId: t.id,
  });
  // short(): a ULID (26 chars) is the first 8 + '-' + last 6 (dedup to avoid same-millisecond collisions)
  const expectedSlug = `${t.id.slice(0, 8)}-${t.id.slice(-6)}`;
  assert.equal(r.branch, `lockage/claude-a/${expectedSlug}`);
  assert.ok(existsSync(r.worktree_path));
});

test('assign: a different agent gets a different worktree (physical isolation)', () => {
  const a = assignWorktree(cdb, { agentId: 'kiro-1', repoPath });
  const b = assignWorktree(cdb, { agentId: 'kiro-2', repoPath });
  assert.notEqual(a.worktree_path, b.worktree_path);
  assert.notEqual(a.branch, b.branch);
  assert.equal(listWorktrees(cdb).length, 2);
});

test('assign: slashes etc. in agent_id are sanitized', () => {
  const r = assignWorktree(cdb, { agentId: 'ns/kiro 1', repoPath });
  assert.ok(!r.branch.includes(' '));
  assert.equal(r.branch, 'lockage/ns-kiro-1/ns-kiro-1');
  assert.ok(existsSync(r.worktree_path));
});

test('release: keep_branch default (true) detaches only the worktree and keeps the branch', () => {
  const r = assignWorktree(cdb, { agentId: 'kiro-1', repoPath });
  const res = releaseWorktree(cdb, {
    agentId: 'kiro-1',
    worktreePath: r.worktree_path,
    repoPath,
  });
  assert.equal(res.ok, true);
  assert.equal(res.removed, true);
  assert.ok(!existsSync(r.worktree_path), 'the physical worktree is gone');
  // the branch remains
  const branches = git(repoPath, ['branch', '--list', r.branch]);
  assert.ok(branches.includes(r.branch), 'the branch remains');
  // the DB is released
  assert.equal(listWorktrees(cdb, 'kiro-1').length, 0);
});

test('release: keep_branch=false also discards the branch (the removed=true success path)', () => {
  const r = assignWorktree(cdb, { agentId: 'kiro-1', repoPath });
  const res = releaseWorktree(cdb, {
    agentId: 'kiro-1',
    worktreePath: r.worktree_path,
    repoPath,
    keepBranch: false,
  });
  // make explicit this is the removed=true success path (branch deletion only when removed=true).
  assert.equal(res.removed, true);
  assert.equal(res.reason, undefined, 'no reason when removed=true');
  const branches = git(repoPath, ['branch', '--list', r.branch]);
  assert.equal(branches, '', 'the branch is gone too');
});

test('release: if remove is refused due to an untracked file, removed=false, reason=untracked and it stays active (#33)', () => {
  const r = assignWorktree(cdb, { agentId: 'kiro-1', repoPath });
  // create an untracked file inside the worktree by hand. `git worktree remove` (without --force) refuses when there are untracked files.
  writeFileSync(join(r.worktree_path, 'untracked.txt'), 'u\n');
  // also insert one dirty-set row and confirm it is not deleted when removed=false.
  cdb.db
    .prepare(
      `INSERT INTO dirty_sets (id, agent_id, worktree_path, files, updated_at, host_id, origin)
       VALUES (?, ?, ?, ?, ?, ?, 'local')`,
    )
    .run('d-untracked', 'kiro-1', r.worktree_path, '["src/a.ts"]', unixNow(), 'host-test');

  const res = releaseWorktree(cdb, {
    agentId: 'kiro-1',
    worktreePath: r.worktree_path,
    repoPath,
  });
  assert.equal(res.ok, true);
  assert.equal(res.removed, false, 'remove is refused due to the untracked file');
  assert.equal(res.reason, 'untracked');
  // the physical worktree remains. the ledger stays active. the dirty set remains too.
  assert.ok(existsSync(r.worktree_path), 'the physical worktree remains');
  assert.equal(listWorktrees(cdb, 'kiro-1').length, 1, 'the ledger stays active');
  assert.equal(
    (cdb.db.prepare('SELECT COUNT(*) c FROM dirty_sets').get() as { c: number }).c,
    1,
    'the dirty set remains when removed=false',
  );

  // cleanup (remove with --force since the untracked file remains).
  git(repoPath, ['worktree', 'remove', '--force', r.worktree_path]);
});

test('release: with a tracked uncommitted diff, removed=false, reason=dirty and it stays active (#33)', () => {
  const r = assignWorktree(cdb, { agentId: 'kiro-1', repoPath });
  // edit a tracked file without committing (an uncommitted diff). README.md is committed at init.
  writeFileSync(join(r.worktree_path, 'README.md'), '# changed in worktree\n');

  const res = releaseWorktree(cdb, {
    agentId: 'kiro-1',
    worktreePath: r.worktree_path,
    repoPath,
    keepBranch: false, // also confirm the branch is not deleted when removed=false
  });
  assert.equal(res.ok, true);
  assert.equal(res.removed, false, 'remove is refused due to the uncommitted diff');
  assert.equal(res.reason, 'dirty');
  assert.ok(existsSync(r.worktree_path), 'the physical worktree remains');
  assert.equal(listWorktrees(cdb, 'kiro-1').length, 1, 'the ledger stays active');
  // since removed=false the branch is not deleted (deleting it while the worktree remains would break it).
  const branches = git(repoPath, ['branch', '--list', r.branch]);
  assert.ok(branches.includes(r.branch), 'the branch is not deleted when removed=false');

  // cleanup.
  git(repoPath, ['worktree', 'remove', '--force', r.worktree_path]);
});

test('reclaim_orphan_worktrees: enumerates physical worktrees with no active ledger row as orphans and can reclaim them with dry_run=false (#33)', () => {
  // create an orphan: assign a worktree and then manually delete the active ledger row (= only the physical remains).
  const r = assignWorktree(cdb, { agentId: 'orphan-agent', repoPath });
  cdb.db.prepare('DELETE FROM worktree_assignments WHERE worktree_path = ?').run(r.worktree_path);
  assert.ok(existsSync(r.worktree_path), 'the physical worktree remains');

  // dry_run (default): enumeration only. detected as an orphan, ledger_status='none', no removed.
  const dry = reclaimOrphanWorktrees(cdb, { repoPath });
  const found = dry.orphans.find((o) => o.worktree_path === r.worktree_path);
  assert.ok(found, 'enumerated as an orphan');
  assert.equal(found!.ledger_status, 'none');
  assert.equal(found!.removed, undefined, 'dry_run does not attempt remove');
  assert.equal(dry.removed_count, 0);
  assert.ok(existsSync(r.worktree_path), 'with dry_run the physical remains');

  // dry_run=false: no untracked files either, so remove goes through and it is reclaimed.
  const live = reclaimOrphanWorktrees(cdb, { repoPath, dryRun: false });
  const removed = live.orphans.find((o) => o.worktree_path === r.worktree_path);
  assert.ok(removed, 'enumerated as an orphan');
  assert.equal(removed!.removed, true, 'remove goes through');
  assert.ok(live.removed_count >= 1);
  assert.ok(!existsSync(r.worktree_path), 'the physical worktree is reclaimed');
});

test('reclaim_orphan_worktrees: a normal worktree with an active ledger row is not included among orphans (#33)', () => {
  const r = assignWorktree(cdb, { agentId: 'normal-agent', repoPath });
  const res = reclaimOrphanWorktrees(cdb, { repoPath });
  assert.ok(
    !res.orphans.some((o) => o.worktree_path === r.worktree_path),
    'a worktree with an active row is not treated as an orphan',
  );
  // cleanup.
  git(repoPath, ['worktree', 'remove', '--force', r.worktree_path]);
});

test('release: on discard, the dirty-set row of that worktree is cleared', () => {
  const r = assignWorktree(cdb, { agentId: 'kiro-1', repoPath });
  // insert one dirty-set row by hand
  cdb.db
    .prepare(
      `INSERT INTO dirty_sets (id, agent_id, worktree_path, files, updated_at, host_id, origin)
       VALUES (?, ?, ?, ?, ?, ?, 'local')`,
    )
    .run('d1', 'kiro-1', r.worktree_path, '["src/a.ts"]', unixNow(), 'host-test');
  assert.equal(
    (cdb.db.prepare('SELECT COUNT(*) c FROM dirty_sets').get() as { c: number })
      .c,
    1,
  );
  releaseWorktree(cdb, {
    agentId: 'kiro-1',
    worktreePath: r.worktree_path,
    repoPath,
  });
  assert.equal(
    (cdb.db.prepare('SELECT COUNT(*) c FROM dirty_sets').get() as { c: number })
      .c,
    0,
    'the dirty set is cleared',
  );
});

test('release: a different agent cannot release the worktree', () => {
  const r = assignWorktree(cdb, { agentId: 'kiro-1', repoPath });
  const res = releaseWorktree(cdb, {
    agentId: 'kiro-2',
    worktreePath: r.worktree_path,
    repoPath,
  });
  assert.equal(res.ok, false);
  assert.ok(existsSync(r.worktree_path), 'the physical worktree remains since it is not the owner');
});

test('assign: a reassignment after release creates a new worktree', () => {
  const a = assignWorktree(cdb, { agentId: 'kiro-1', repoPath });
  releaseWorktree(cdb, {
    agentId: 'kiro-1',
    worktreePath: a.worktree_path,
    repoPath,
  });
  const b = assignWorktree(cdb, { agentId: 'kiro-1', repoPath });
  assert.equal(b.reused, false, 'not reused after released');
  // returns to the same deterministic path/branch (same worktree on reconnect)
  assert.equal(a.worktree_path, b.worktree_path);
  assert.equal(a.branch, b.branch);
  assert.ok(existsSync(b.worktree_path));
});

// ── separate fix: the issue where the reuse decision keyed on agent_id only (multi-repo / multiple tasks) ──────────
// The old impl reused "the first row of agent_id + status='active'", so when the same agent requested a
// worktree for a different repo / different task it returned the first worktree (wrong under multi-repo
// assignment). Keying on the deterministic path makes a different repo/task a different worktree.

test('assign: if the same agent requests a different repo it gets a different worktree (does not return the first one)', () => {
  // prepare a second independent git repo
  const repo2 = join(root, 'repo2');
  mkdirSync(repo2);
  git(repo2, ['init', '-q', '-b', 'main']);
  git(repo2, ['config', 'user.email', 'test@example.com']);
  git(repo2, ['config', 'user.name', 'test']);
  writeFileSync(join(repo2, 'README.md'), '# repo2\n');
  git(repo2, ['add', '.']);
  git(repo2, ['commit', '-q', '-m', 'init']);

  const a = assignWorktree(cdb, { agentId: 'claude-01', repoPath });
  const b = assignWorktree(cdb, { agentId: 'claude-01', repoPath: repo2 });

  assert.equal(b.reused, false, 'a different repo is created anew, not reused');
  assert.notEqual(a.worktree_path, b.worktree_path, 'a different repo is a different worktree path');
  // both coexist as active (can handle repo-A and repo-B at once)
  assert.equal(listWorktrees(cdb, 'claude-01').length, 2, 'worktrees for 2 repos coexist');
  assert.ok(existsSync(a.worktree_path));
  assert.ok(existsSync(b.worktree_path));

  // cleanup
  git(repo2, ['worktree', 'remove', '--force', b.worktree_path]);
});

test('assign: same agent, same repo but a different task is a different worktree', () => {
  const t1 = createTask(cdb, { repo: 'repo', title: 'task1' });
  const t2 = createTask(cdb, { repo: 'repo', title: 'task2' });
  const a = assignWorktree(cdb, { agentId: 'claude-02', repoPath, taskId: t1.id });
  const b = assignWorktree(cdb, { agentId: 'claude-02', repoPath, taskId: t2.id });

  assert.equal(b.reused, false, 'a different task is created anew, not reused');
  assert.notEqual(a.worktree_path, b.worktree_path, 'a different task is a different worktree path');
  assert.notEqual(a.branch, b.branch, 'a different task is a different branch (the deterministic slug comes from the task)');
  assert.equal(listWorktrees(cdb, 'claude-02').length, 2);
});

test('assign: 2 ULIDs generated in the same millisecond do not collide in the slug (short fix)', () => {
  // simulate same-millisecond ULIDs: the first 10 chars (timestamp part) match exactly, only the trailing
  // random part differs. With the old short()=first 10 chars they collided and fell into the same worktree.
  // After the fix the trailing part is used too, so a different worktree.
  const prefix = '01M4350000'; // the shared 10-char timestamp part
  const id1 = prefix + 'AAAAAAAAAAAAAAAA'; // 26 chars
  const id2 = prefix + 'BBBBBBBBBBBBBBBB';
  assert.equal(id1.slice(0, 10), id2.slice(0, 10), 'premise: the first 10 chars match (simulating the same millisecond)');

  // task_id is an FK, so create real tasks and overwrite their ids to reproduce the same millisecond.
  const t1 = createTask(cdb, { repo: 'repo', title: 'c1' });
  const t2 = createTask(cdb, { repo: 'repo', title: 'c2' });
  cdb.db.prepare('UPDATE tasks SET id = ? WHERE id = ?').run(id1, t1.id);
  cdb.db.prepare('UPDATE tasks SET id = ? WHERE id = ?').run(id2, t2.id);

  const a = assignWorktree(cdb, { agentId: 'claude-04', repoPath, taskId: id1 });
  const b = assignWorktree(cdb, { agentId: 'claude-04', repoPath, taskId: id2 });

  assert.equal(b.reused, false, 'even same-millisecond, a different task is a different worktree (no collision)');
  assert.notEqual(a.worktree_path, b.worktree_path);
  assert.notEqual(a.branch, b.branch);
  assert.equal(listWorktrees(cdb, 'claude-04').length, 2);
});

test('assign: a re-call for the same agent, same repo, same task is reused as before (idempotence maintained)', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'same' });
  const a = assignWorktree(cdb, { agentId: 'claude-03', repoPath, taskId: t.id });
  const b = assignWorktree(cdb, { agentId: 'claude-03', repoPath, taskId: t.id });
  assert.equal(b.reused, true, 'same agent/repo/task is reused idempotently');
  assert.equal(a.worktree_path, b.worktree_path);
  assert.equal(listWorktrees(cdb, 'claude-03').length, 1);
});

// ── list_worktrees(stale:true) (#35 option 2): visualize unreleased candidates that stayed active while tied to a done task ──
// Flipping tasks.status to 'done' is done directly via cdb.db per the existing test convention.

/** Flip a task to the done state (direct update, per the existing test convention). */
function markTaskDone(id: string): void {
  cdb.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', id);
}

test('list_stale: returns active worktrees tied to done tasks', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'stale-done' });
  const r = assignWorktree(cdb, { agentId: 'kiro-1', repoPath, taskId: t.id });
  markTaskDone(t.id);

  const stale = listStaleWorktrees(cdb);
  assert.equal(stale.length, 1, 'one done-linked active is returned');
  assert.equal(stale[0].worktree_path, r.worktree_path);
  assert.equal(stale[0].agent_id, 'kiro-1');
  assert.equal(stale[0].branch, r.branch);
  assert.equal(stale[0].task_id, t.id);
  assert.equal(stale[0].task_status, 'done');

  // cleanup.
  git(repoPath, ['worktree', 'remove', '--force', r.worktree_path]);
});

test('list_stale: active worktrees of not-done (open/in_progress) tasks are not returned', () => {
  // stays open
  const tOpen = createTask(cdb, { repo: 'repo', title: 'open' });
  const rOpen = assignWorktree(cdb, { agentId: 'kiro-open', repoPath, taskId: tOpen.id });
  // flip to in_progress
  const tInProg = createTask(cdb, { repo: 'repo', title: 'inprog' });
  const rInProg = assignWorktree(cdb, { agentId: 'kiro-inprog', repoPath, taskId: tInProg.id });
  cdb.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('in_progress', tInProg.id);

  const stale = listStaleWorktrees(cdb);
  assert.equal(stale.length, 0, 'worktrees of not-done tasks are out of scope');

  // cleanup.
  git(repoPath, ['worktree', 'remove', '--force', rOpen.worktree_path]);
  git(repoPath, ['worktree', 'remove', '--force', rInProg.worktree_path]);
});

test('list_stale: released worktrees are not returned', () => {
  const t = createTask(cdb, { repo: 'repo', title: 'released' });
  const r = assignWorktree(cdb, { agentId: 'kiro-1', repoPath, taskId: t.id });
  markTaskDone(t.id);
  // release normally (removed=true, ledger released).
  const res = releaseWorktree(cdb, {
    agentId: 'kiro-1',
    worktreePath: r.worktree_path,
    repoPath,
  });
  assert.equal(res.removed, true);

  const stale = listStaleWorktrees(cdb);
  assert.equal(stale.length, 0, 'a released row is not status=active so it is out of scope');
});

test('list_stale: an assignment with NULL task_id is not returned (drops out of the JOIN)', () => {
  // assign without task_id (task_id is NULL). even if there is a done row in tasks, it cannot JOIN.
  const tDone = createTask(cdb, { repo: 'repo', title: 'other-done' });
  markTaskDone(tDone.id);
  const r = assignWorktree(cdb, { agentId: 'kiro-null', repoPath });
  // premise: the assignment's task_id is NULL.
  assert.equal(listWorktrees(cdb, 'kiro-null')[0].task_id, null);

  const stale = listStaleWorktrees(cdb);
  assert.equal(stale.length, 0, 'NULL task_id drops out of the JOIN and is out of scope');

  // cleanup.
  git(repoPath, ['worktree', 'remove', '--force', r.worktree_path]);
});

test('list_stale: filtering by ticket_id / agent_id works', () => {
  // prepare one done task + active worktree under each of 2 tickets.
  const ticketA = openTicket(cdb, { title: 'ticket-A', repos: ['repo'] });
  const ticketB = openTicket(cdb, { title: 'ticket-B', repos: ['repo'] });
  const tA = createTask(cdb, { repo: 'repo', title: 'A-task', ticketId: ticketA.id });
  const tB = createTask(cdb, { repo: 'repo', title: 'B-task', ticketId: ticketB.id });
  const rA = assignWorktree(cdb, { agentId: 'agent-A', repoPath, taskId: tA.id });
  const rB = assignWorktree(cdb, { agentId: 'agent-B', repoPath, taskId: tB.id });
  markTaskDone(tA.id);
  markTaskDone(tB.id);

  // no filter: both returned.
  assert.equal(listStaleWorktrees(cdb).length, 2);

  // ticket_id = A: only A's worktree returned.
  const byTicket = listStaleWorktrees(cdb, { ticketId: ticketA.id });
  assert.equal(byTicket.length, 1);
  assert.equal(byTicket[0].worktree_path, rA.worktree_path);
  assert.equal(byTicket[0].ticket_id, ticketA.id);

  // agent_id = agent-B: only B's worktree returned.
  const byAgent = listStaleWorktrees(cdb, { agentId: 'agent-B' });
  assert.equal(byAgent.length, 1);
  assert.equal(byAgent[0].worktree_path, rB.worktree_path);
  assert.equal(byAgent[0].agent_id, 'agent-B');

  // cleanup.
  git(repoPath, ['worktree', 'remove', '--force', rA.worktree_path]);
  git(repoPath, ['worktree', 'remove', '--force', rB.worktree_path]);
});

// ── #36: absorbing realpath normalization differences ──────────────────────────────
// Verify that even in environments where the path git worktree list --porcelain returns and the ledger's
// worktree_path diverge as strings due to a symlink-resolution difference, a worktree with an active row is
// not misidentified as an orphan.

test('reclaim_orphan_worktrees: not an orphan even if the ledger path diverges from the git path as a string via a symlink (#36)', () => {
  // 1) assign a worktree normally.
  const r = assignWorktree(cdb, { agentId: 'symlink-agent', repoPath });
  assert.ok(existsSync(r.worktree_path), 'the physical worktree is created');

  // 2) create a symlink:
  //    create a symbolic link "link-parent" under root pointing at the real ".lockage-worktrees" directory.
  //    Rewriting the ledger's worktree_path to this via-symlink path reproduces a state where the ledger
  //    path (via symlink) and the path git returns (realpath-resolved) diverge as strings.
  const realWorktreeDir = join(root, '.lockage-worktrees');
  const symlinkDir = join(root, 'link-.lockage-worktrees');
  if (!existsSync(symlinkDir)) {
    symlinkSync(realWorktreeDir, symlinkDir, 'dir');
  }

  // the via-symlink path (the value assumed saved in the ledger). basename is the same so reuse the trailing part.
  const wtBasename = r.worktree_path.split('/').pop()!;
  const symlinkPath = join(symlinkDir, wtBasename);

  // premise: symlinkPath and r.worktree_path differ as strings but fold to the same real path with realpathSync.
  assert.notEqual(symlinkPath, r.worktree_path, 'differ as strings');
  assert.equal(realpathSync(symlinkPath), realpathSync(r.worktree_path), 'realpaths match');

  // 3) rewrite the ledger's worktree_path to the via-symlink path (simulating macOS /var→/private/var).
  cdb.db
    .prepare('UPDATE worktree_assignments SET worktree_path = ? WHERE worktree_path = ?')
    .run(symlinkPath, r.worktree_path);

  // confirm the ledger was rewritten.
  const rows = listWorktrees(cdb, 'symlink-agent');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].worktree_path, symlinkPath, 'the ledger is the via-symlink path');

  // 4) confirm reclaimOrphanWorktrees does not treat "a worktree with an active row" as an orphan.
  //    before the normalization fix, the git-derived real path and the ledger's symlink path diverged as
  //    strings, so the active row was missed and classified as an orphan (reproducing #36).
  const result = reclaimOrphanWorktrees(cdb, { repoPath });
  const falsyOrphan = result.orphans.find(
    (o) => realpathSync(o.worktree_path) === realpathSync(r.worktree_path),
  );
  assert.equal(
    falsyOrphan,
    undefined,
    'realpath normalization does not misidentify an active worktree as an orphan (#36)',
  );

  // cleanup.
  git(repoPath, ['worktree', 'remove', '--force', r.worktree_path]);
  rmSync(symlinkDir, { recursive: true, force: true });
});

// ── #41: fixing the one-sided fallback mismatch via write-side normalization ───────────────────────
// #36's approach absorbed the realpath normalization difference on the read side (reclaimOrphanWorktrees),
// but the ledger's saved value itself stayed with symlinks unresolved, leaving room for a mismatch where
// only one side normalizes successfully. #41 fixes it fundamentally by having assignWorktree "realpathSync-
// normalize after creating the physical worktree and then save to the ledger, and return the normalized
// value too", fixing the saved value to the real path.

// ── Helper for #41 tests: create a via-symlink repoPath ──────────────────────────
//
// To directly address review findings #1 / #3, make the sandbox deterministically take assignWorktree's
// `canonicalPath !== path` branch (= the write-side normalization that only fires in a symlink environment,
// and the post-normalization reuse re-check).
//
// Mechanism: assignWorktree joins `.lockage-worktrees/<name>` under repoParent = dirname(repoPath). So if
// dirname(repoPath) is via a symlink, the joined path keeps the symlink, realpathSync(path) folds it to the
// real entity, and `canonicalPath !== path` holds. Create a symlink pointing at the whole root (link-root →
// root) and return a repoPath that references the repo via that symlink to reproduce this.
//
// This sandbox's /tmp is not a symlink (realpathSync(mkdtempSync(...)) matches the input), so unless the test
// explicitly creates a symlink, `path === canonicalPath` and the branch is skipped. The symlink this helper
// creates fills that gap.
function makeSymlinkedRepoPath(agentTag: string): {
  linkRoot: string;
  repoViaLink: string;
  cleanup: () => void;
} {
  // root may not be realpathSync-resolved in before(), so fold it to the real entity here
  // (fix the base for the symlink to the real path, interposing just one symlink hop link-root → real root).
  const realRoot = realpathSync(root);
  const linkRoot = join(dirname(realRoot), `link-${agentTag}-${basename(realRoot)}`);
  if (!existsSync(linkRoot)) {
    symlinkSync(realRoot, linkRoot, 'dir');
  }
  // the repo entity is the shared repoPath (= realRoot/repo). point at the same repo via the symlink.
  const repoViaLink = join(linkRoot, 'repo');
  return {
    linkRoot,
    repoViaLink,
    cleanup: () => rmSync(linkRoot, { recursive: true, force: true }),
  };
}

test('assign: the saved worktree_path is realpath-normalized (#41)', () => {
  const r = assignWorktree(cdb, { agentId: 'canon-agent', repoPath });

  // read the DB worktree_path directly (verify the ledger's actual saved value, not assignWorktree's return value).
  const row = cdb.db
    .prepare(
      `SELECT worktree_path FROM worktree_assignments WHERE agent_id = ? AND status = 'active'`,
    )
    .get('canon-agent') as { worktree_path: string } | undefined;
  assert.ok(row, 'there is an active row in the ledger');

  // normalized at save time = realpathSync(saved value) === saved value (= a real path that cannot be folded further).
  assert.equal(
    realpathSync(row!.worktree_path),
    row!.worktree_path,
    'the saved value is realpath-normalized (#41)',
  );
  // the return value is also the normalized value (= matches the ledger saved value).
  assert.equal(r.worktree_path, row!.worktree_path, 'the return value matches the ledger saved value (#41)');

  // cleanup.
  git(repoPath, ['worktree', 'remove', '--force', r.worktree_path]);
});

// ── Addressing review finding #1: actually take the canonicalPath !== path branch ─────────────
// The old #41 test only confirmed "the saved value is realpath-resolved" in a normal environment
// (path === canonicalPath) and did not take the heart of write-side normalization, the
// `canonicalPath !== path` branch itself (review finding #1, confirmed). This test passes a via-symlink
// repoPath to force this branch and directly asserts (a) a real path different from the pre-normalization
// join path is saved to the ledger, (b) folding the pre-normalization join path with realpath matches the
// saved value (= the branch is not silently skipped).
test('assign: with a via-symlink repoPath the canonicalPath !== path branch fires and the saved value becomes the real path (#41)', () => {
  const { linkRoot, repoViaLink, cleanup } = makeSymlinkedRepoPath('canon-branch');
  try {
    const r = assignWorktree(cdb, { agentId: 'canon-branch-agent', repoPath: repoViaLink });

    // reproduce the join path assignWorktree builds before normalizing (= an un-normalized path containing the symlink).
    // to not depend on the internal spec of the deterministic slug (short/safeSlug), mechanically derive the
    // "via-symlink un-normalized path" by replacing the return value's real path (under realRoot) with linkRoot.
    const realRoot = realpathSync(root);
    const preNormalizeJoinPath = r.worktree_path.replace(realRoot, linkRoot);

    // premise: since it is via a symlink, the pre-normalization join path diverges from the realpath as a string
    // (= if this does not hold the branch does not fire and the test is meaningless).
    assert.notEqual(
      preNormalizeJoinPath,
      r.worktree_path,
      'premise: the derived un-normalized path differs as a string from the real path (= via symlink)',
    );
    assert.notEqual(
      realpathSync(preNormalizeJoinPath),
      preNormalizeJoinPath,
      'premise: via a symlink the pre-normalization path diverges from the real path (the condition for the branch to fire)',
    );

    // read the ledger's actual saved value directly.
    const row = cdb.db
      .prepare(
        `SELECT worktree_path FROM worktree_assignments WHERE agent_id = ? AND status = 'active'`,
      )
      .get('canon-branch-agent') as { worktree_path: string } | undefined;
    assert.ok(row, 'there is an active row in the ledger');

    // (a) the saved value differs from the pre-normalization join path (= evidence write-side normalization actually worked).
    assert.notEqual(
      row!.worktree_path,
      preNormalizeJoinPath,
      'the saved value is not the pre-normalization join path (the canonicalPath !== path branch fired)',
    );
    // (b) folding the pre-normalization join path with realpath matches the saved value (saved value = canonicalPath).
    assert.equal(
      realpathSync(preNormalizeJoinPath),
      row!.worktree_path,
      'the saved value matches the realpath of the pre-normalization join path (= canonicalPath)',
    );
    // the saved value itself is realpath-resolved (cannot be folded further).
    assert.equal(realpathSync(row!.worktree_path), row!.worktree_path, 'the saved value is realpath-resolved');
    // the return value is also the normalized value.
    assert.equal(r.worktree_path, row!.worktree_path, 'the return value matches the ledger saved value');

    // cleanup (pass the real path to worktree remove).
    git(repoPath, ['worktree', 'remove', '--force', r.worktree_path]);
  } finally {
    cleanup();
  }
});

// ── Review finding #1 (continued): a via-symlink re-call is reused via step2's post-normalization re-check ──
// On a new assignment, step1's reuse SELECT queries with the un-normalized path so it does not hit via a symlink.
// On the second call, step2 (re-SELECT by canonicalPath) hits and reuses; confirm the two-stage reuse decision
// works as intended in a symlink environment.
test('assign: a via-symlink re-call is reused via step2 (canonicalPath re-check) (#41)', () => {
  const { repoViaLink, cleanup } = makeSymlinkedRepoPath('canon-reuse');
  try {
    const a = assignWorktree(cdb, { agentId: 'canon-reuse-agent', repoPath: repoViaLink });
    const b = assignWorktree(cdb, { agentId: 'canon-reuse-agent', repoPath: repoViaLink });

    assert.equal(b.reused, true, 'even via a symlink the second time is reused (hits at step2)');
    assert.equal(a.worktree_path, b.worktree_path, 'returns the same normalized path');
    assert.equal(
      listWorktrees(cdb, 'canon-reuse-agent').length,
      1,
      'not double-registered (the post-normalization reuse decision works)',
    );

    // cleanup.
    git(repoPath, ['worktree', 'remove', '--force', a.worktree_path]);
  } finally {
    cleanup();
  }
});

// ── Addressing review finding #2: lazily normalize the ledger value when reusing an old un-normalized row ─────────────
// When reusing a ledger row saved un-normalized before #41 (a path containing a symlink), if the return value
// stays un-normalized it diverges from the "normalized new row", leaving the theoretical room for a normalized
// and an un-normalized row to coexist for the same worktree (review finding #2, possible). This test verifies
// that when reusing an old un-normalized row whose physical worktree remains, both the return value and the
// ledger saved value converge to the realpath-resolved form (= lazy normalization works).
test('assign: reusing an old un-normalized row lazily normalizes the ledger value to realpath (#41 review finding #2)', () => {
  const { linkRoot, repoViaLink, cleanup } = makeSymlinkedRepoPath('canon-lazy');
  try {
    // 1) first assign via the symlink and actually create the physical worktree.
    //    assignWorktree saves the realpath via write-side normalization, so it becomes a realpath row here once.
    const first = assignWorktree(cdb, { agentId: 'lazy-agent', repoPath: repoViaLink });
    const realWtPath = first.worktree_path;
    assert.equal(realpathSync(realWtPath), realWtPath, 'the first save is realpath-resolved');

    // 2) to simulate an old row (before #41), manually write back the ledger's worktree_path to an un-normalized
    //    path containing the symlink (the physical worktree stays at realWtPath).
    const unnormalized = realWtPath.replace(realpathSync(root), linkRoot);
    assert.notEqual(unnormalized, realWtPath, 'the un-normalized path differs from the realpath as a string');
    cdb.db
      .prepare(`UPDATE worktree_assignments SET worktree_path = ? WHERE agent_id = ?`)
      .run(unnormalized, 'lazy-agent');

    // 3) re-calling for the same agent/repo makes step1 hit this un-normalized row (the deterministic path is the
    //    un-normalized path containing the symlink, so it matches as a string). lazy normalization should converge it to realpath.
    const reused = assignWorktree(cdb, { agentId: 'lazy-agent', repoPath: repoViaLink });
    assert.equal(reused.reused, true, 'reuses the old row');
    assert.equal(reused.worktree_path, realWtPath, 'the return value is normalized to realpath (lazy normalization)');

    // the ledger saved value is also rewritten to realpath (= subsequent comparisons match normalized-against-normalized).
    const row = cdb.db
      .prepare(
        `SELECT worktree_path FROM worktree_assignments WHERE agent_id = ? AND status = 'active'`,
      )
      .get('lazy-agent') as { worktree_path: string };
    assert.equal(row.worktree_path, realWtPath, 'the ledger saved value also converges to realpath');
    assert.equal(listWorktrees(cdb, 'lazy-agent').length, 1, 'not double-registered');

    // cleanup.
    git(repoPath, ['worktree', 'remove', '--force', realWtPath]);
  } finally {
    cleanup();
  }
});

// ── Addressing review finding #3: contrast read-side-only normalization vs write-side normalization ─────────────
// The old second regression test did not reproduce via-symlink ledger saving and effectively degenerated into a
// "the saved value is realpath-resolved" check (review finding #3, confirmed). This test reproduces head-on the
// "one-sided fallback mismatch" #41 wanted to fix:
//
//   premise: create a symlink and physically generate the worktree under it.
//   - simulate an old row (before #41): directly INSERT the via-symlink [un-normalized] path into the ledger.
//   - simulate a new row (since #41): assignWorktree saves the [normalized] real path.
//   then delete the symlink (= the symlink string becomes realpath-unresolvable).
//
//   contrast:
//   - read-side-only normalization (= the old un-normalized row): after the symlink is deleted, normalizePath
//     falls back and stays as the symlink string, diverging from the git-derived real path and [misidentifying]
//     the active worktree as an orphan.
//   - write-side normalization (= the #41 new row): the saved value is the real path from the start, so it
//     matches the git-derived path regardless of the symlink and is [not misidentified] as an orphan.
//
// By this contrast, this test is a regression test that distinguishes the #41 fix itself, not a restatement of
// "the saved value is realpath-resolved".
test('reclaim_orphan_worktrees: read-side-only normalization misidentifies an orphan but write-side normalization does not (#41 one-sided fallback mismatch contrast)', () => {
  const { linkRoot, repoViaLink, cleanup } = makeSymlinkedRepoPath('canon-contrast');
  try {
    // 1) simulate an old row (before #41): physically generate a via-symlink worktree and directly INSERT the
    //    [un-normalized] path containing the symlink into the ledger (= the form saved before PR #40).
    const legacyBranch = 'lockage/legacy-agent/legacy-agent';
    const legacyUnnormalizedPath = join(
      linkRoot,
      '.lockage-worktrees',
      'repo-legacy-agent-legacy-agent',
    );
    git(repoPath, ['worktree', 'add', '-b', legacyBranch, legacyUnnormalizedPath, 'main']);
    cdb.db
      .prepare(
        `INSERT INTO worktree_assignments
           (id, agent_id, worktree_path, repo_path, branch, task_id, status, created_at, released_at, host_id, origin)
         VALUES (?, ?, ?, ?, ?, NULL, 'active', ?, NULL, ?, 'local')`,
      )
      .run(
        'legacy-row-1',
        'legacy-agent',
        legacyUnnormalizedPath,
        repoPath,
        legacyBranch,
        unixNow(),
        'host-test',
      );
    // premise: the saved value is an un-normalized path containing the symlink (= diverges from the real path as a string).
    assert.notEqual(
      realpathSync(legacyUnnormalizedPath),
      legacyUnnormalizedPath,
      'premise: the old row saved value contains the symlink and diverges from the real path',
    );

    // 2) simulate a new row (since #41): assignWorktree normalizes on the write side and saves.
    const neo = assignWorktree(cdb, { agentId: 'neo-agent', repoPath: repoViaLink });
    const neoRow = cdb.db
      .prepare(
        `SELECT worktree_path FROM worktree_assignments WHERE agent_id = ? AND status = 'active'`,
      )
      .get('neo-agent') as { worktree_path: string };
    assert.equal(
      realpathSync(neoRow.worktree_path),
      neoRow.worktree_path,
      'premise: the new row saved value is realpath-resolved (= write-side normalization)',
    );

    // 3) delete the symlink. now the un-normalized path (containing the symlink) becomes realpath-unresolvable.
    cleanup();

    // 4) run reclaimOrphanWorktrees and contrast the two classifications.
    const result = reclaimOrphanWorktrees(cdb, { repoPath });

    // (A) old un-normalized row: the read-side normalizePath falls back on the symlink deletion and diverges from
    //     the git-derived real path, so despite being active it is [misidentified as an orphan].
    //     this reproduces the defect of the read-side-only normalization approach before #41.
    const legacyRealPath = join(realpathSync(root), '.lockage-worktrees', 'repo-legacy-agent-legacy-agent');
    const legacyMisdetected = result.orphans.some((o) => o.worktree_path === legacyRealPath);
    assert.equal(
      legacyMisdetected,
      true,
      'read-side-only normalization (old un-normalized row) is misidentified as an orphan after symlink deletion (= the defect before #41)',
    );

    // (B) new normalized row (#41): the saved value is the real path from the start, so it matches the git-derived path and is [not misidentified as an orphan].
    const neoMisdetected = result.orphans.some(
      (o) => realpathSync(o.worktree_path) === realpathSync(neo.worktree_path),
    );
    assert.equal(
      neoMisdetected,
      false,
      'write-side normalization (#41 new row) is not misidentified as an orphan even after symlink deletion (= fixed)',
    );

    // cleanup (remove both worktrees by real path).
    git(repoPath, ['worktree', 'remove', '--force', legacyRealPath]);
    git(repoPath, ['worktree', 'remove', '--force', neo.worktree_path]);
  } finally {
    // cleanup is safe even if the symlink is already deleted since it is force (callable twice).
    cleanup();
  }
});

// ── FEAT-002 (Issue #52 proposal 1): assign_worktree records the branch-point SHA into base_sha ──────
// So the "diff from the branch point (git diff --name-only <base_sha>...HEAD)" can be computed later,
// resolve baseRef to a real existing SHA at new assignment time and save it to worktree_assignments.base_sha.
// On an idempotent reuse of an existing active assignment, do not overwrite it to keep the first branch point.

test('assign: on a new assignment base_sha matches the base branch HEAD SHA (FEAT-002)', () => {
  const r = assignWorktree(cdb, { agentId: 'base-agent', repoPath });

  // read the ledger's base_sha directly.
  const row = cdb.db
    .prepare(
      `SELECT base_sha FROM worktree_assignments WHERE agent_id = ? AND status = 'active'`,
    )
    .get('base-agent') as { base_sha: string | null } | undefined;
  assert.ok(row, 'there is an active row in the ledger');

  // the repo's default base branch is main (specified -b main in before()). use its HEAD SHA as the expected value.
  const expected = git(repoPath, ['rev-parse', '--verify', 'main^{commit}']);
  assert.equal(row!.base_sha, expected, 'base_sha matches the base branch HEAD SHA');
  // it holds a 40-digit SHA (a resolved SHA, not a branch name).
  assert.equal(row!.base_sha!.length, 40, 'base_sha is a resolved full SHA');

  // cleanup.
  git(repoPath, ['worktree', 'remove', '--force', r.worktree_path]);
});

test('assign: on a reassignment (reused=true) base_sha stays at the first value unchanged (FEAT-002)', () => {
  // first time: base_sha is recorded.
  const a = assignWorktree(cdb, { agentId: 'base-reuse-agent', repoPath });
  const first = (
    cdb.db
      .prepare(
        `SELECT base_sha FROM worktree_assignments WHERE agent_id = ? AND status = 'active'`,
      )
      .get('base-reuse-agent') as { base_sha: string | null }
  ).base_sha;
  assert.ok(first, 'base_sha is recorded on the first assignment');

  // stack a new commit on the base branch to advance HEAD (= a situation where resolveRefSha('main') is a different value).
  writeFileSync(join(repoPath, 'NEW.md'), '# advance main\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', 'advance main']);
  const advanced = git(repoPath, ['rev-parse', '--verify', 'main^{commit}']);
  assert.notEqual(advanced, first, 'premise: the base branch HEAD has advanced');

  // second time: idempotent reuse. base_sha stays at the first value (not overwritten with the new HEAD).
  const b = assignWorktree(cdb, { agentId: 'base-reuse-agent', repoPath });
  assert.equal(b.reused, true, 'same agent/repo/task is reused idempotently');
  assert.equal(a.worktree_path, b.worktree_path);

  const second = (
    cdb.db
      .prepare(
        `SELECT base_sha FROM worktree_assignments WHERE agent_id = ? AND status = 'active'`,
      )
      .get('base-reuse-agent') as { base_sha: string | null }
  ).base_sha;
  assert.equal(second, first, 'on a reassignment base_sha stays at the first branch point unchanged');

  // cleanup.
  git(repoPath, ['worktree', 'remove', '--force', a.worktree_path]);
});

// ── Issue #8: assign_worktree がローカル base ではなくリモート追跡 (origin/<base>) から切る ──────────
// 外部ネットワークを使わず、ローカルの bare リポジトリを remote として add し push することで
// git fetch とリモート追跡 ref をネットワーク無しに再現する（共有 repoPath を汚さないよう各テストで
// 専用リポジトリを作る）。

/**
 * 専用の作業用 git リポジトリを作る。initialBranch を既定ブランチにし初期コミットを置く。
 * @returns 作成したリポジトリのパス。
 */
function makeRepo(tag: string, initialBranch: string): string {
  const p = join(root, `issue8-${tag}`);
  mkdirSync(p);
  git(p, ['init', '-q', '-b', initialBranch]);
  git(p, ['config', 'user.email', 'test@example.com']);
  git(p, ['config', 'user.name', 'test']);
  writeFileSync(join(p, 'README.md'), '# test\n');
  git(p, ['add', '.']);
  git(p, ['commit', '-q', '-m', 'init']);
  return p;
}

/**
 * repo に bare リモートを add し、`dev` を 1 コミット進めて push した後、ローカル `dev` を 1 件戻す。
 * これで「ローカル dev が origin/dev から 1 件遅れている」状態を作る（ネットワーク不要）。
 * @returns origin/dev の進んだ SHA。
 */
function setupLaggingRemote(repo: string, tag: string): string {
  git(repo, ['branch', 'dev']);
  git(repo, ['checkout', '-q', 'dev']);
  const bare = join(root, `issue8-remote-${tag}.git`);
  mkdirSync(bare);
  git(bare, ['init', '-q', '--bare', '-b', 'dev']);
  git(repo, ['remote', 'add', 'origin', bare]);
  writeFileSync(join(repo, 'remote-only.txt'), 'from remote\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'advance dev on remote']);
  git(repo, ['push', '-q', 'origin', 'dev']);
  const remoteSha = git(repo, ['rev-parse', '--verify', 'dev^{commit}']);
  // ローカル dev を 1 件戻してリモートから遅らせる。
  git(repo, ['reset', '-q', '--hard', 'HEAD~1']);
  return remoteSha;
}

test('assign (Issue #8): base_ref 省略で remote があるとき origin/dev から切り base_sha が origin/dev に一致する', () => {
  const repo = makeRepo('remote', 'main');
  const remoteSha = setupLaggingRemote(repo, 'remote');
  const localSha = git(repo, ['rev-parse', '--verify', 'dev^{commit}']);
  assert.notEqual(localSha, remoteSha, '前提: ローカル dev と origin/dev が異なる');

  const r = assignWorktree(cdb, { agentId: 'issue8-remote', repoPath: repo });

  // リモート追跡から切ったことが応答に出る。
  assert.equal(r.base_source, 'remote');
  assert.equal(r.base_ref_used, 'origin/dev');
  assert.equal(r.behind, 1, 'ローカル dev は origin/dev から 1 件遅れている');

  // 切った worktree の HEAD は origin/dev の SHA。
  const wtHead = git(r.worktree_path, ['rev-parse', 'HEAD']);
  assert.equal(wtHead, remoteSha, 'worktree の HEAD は origin/dev の SHA');

  // 台帳の base_sha も origin/dev の SHA（古いローカル SHA ではない）。
  const row = cdb.db
    .prepare(`SELECT base_sha FROM worktree_assignments WHERE agent_id = ? AND status = 'active'`)
    .get('issue8-remote') as { base_sha: string | null };
  assert.equal(row.base_sha, remoteSha, 'base_sha は origin/dev の SHA');
  assert.notEqual(row.base_sha, localSha, 'base_sha は古いローカル SHA ではない');

  git(repo, ['worktree', 'remove', '--force', r.worktree_path]);
});

test('assign (Issue #8): remote が無いリポジトリでは従来どおりローカル base から切る (base_source=local, behind=null)', () => {
  const repo = makeRepo('noremote', 'main');
  git(repo, ['branch', 'dev']);
  const localSha = git(repo, ['rev-parse', '--verify', 'dev^{commit}']);

  const r = assignWorktree(cdb, { agentId: 'issue8-noremote', repoPath: repo });

  assert.equal(r.base_source, 'local', 'remote 無しはローカルから切る');
  assert.equal(r.base_ref_used, 'dev');
  assert.equal(r.behind, null, 'remote 無しは behind=null');

  const row = cdb.db
    .prepare(`SELECT base_sha FROM worktree_assignments WHERE agent_id = ? AND status = 'active'`)
    .get('issue8-noremote') as { base_sha: string | null };
  assert.equal(row.base_sha, localSha, 'base_sha はローカル base の SHA（現状挙動維持）');

  git(repo, ['worktree', 'remove', '--force', r.worktree_path]);
});

test('assign (Issue #8): base_ref を明示したときは remote fetch に関係なくその ref から切る (follow-up 後方互換)', () => {
  const repo = makeRepo('explicit', 'main');
  setupLaggingRemote(repo, 'explicit');
  // 明示的な統合ブランチ相当の ref を用意（現在の dev=ローカルの遅れた状態から branch を切る）。
  git(repo, ['branch', 'integration']);
  const integrationSha = git(repo, ['rev-parse', '--verify', 'integration^{commit}']);

  const r = assignWorktree(cdb, {
    agentId: 'issue8-explicit',
    repoPath: repo,
    baseRef: 'integration',
  });

  // base_ref 明示時はリモート追従を行わずその ref をそのまま使う。
  assert.equal(r.base_source, 'local');
  assert.equal(r.base_ref_used, 'integration');

  const wtHead = git(r.worktree_path, ['rev-parse', 'HEAD']);
  assert.equal(wtHead, integrationSha, 'worktree の HEAD は明示 ref の SHA');
  const row = cdb.db
    .prepare(`SELECT base_sha FROM worktree_assignments WHERE agent_id = ? AND status = 'active'`)
    .get('issue8-explicit') as { base_sha: string | null };
  assert.equal(row.base_sha, integrationSha, 'base_sha は明示 ref の SHA');

  git(repo, ['worktree', 'remove', '--force', r.worktree_path]);
});

test('assign (Issue #8): base_from_remote=false のときはリモートがあってもローカルから切る', () => {
  const repo = makeRepo('optoff', 'main');
  const remoteSha = setupLaggingRemote(repo, 'optoff');
  const localSha = git(repo, ['rev-parse', '--verify', 'dev^{commit}']);
  assert.notEqual(localSha, remoteSha, '前提: ローカル dev と origin/dev が異なる');

  const r = assignWorktree(cdb, {
    agentId: 'issue8-optoff',
    repoPath: repo,
    baseFromRemote: false,
  });

  assert.equal(r.base_source, 'local', 'base_from_remote=false はローカルから切る');
  assert.equal(r.base_ref_used, 'dev');

  const row = cdb.db
    .prepare(`SELECT base_sha FROM worktree_assignments WHERE agent_id = ? AND status = 'active'`)
    .get('issue8-optoff') as { base_sha: string | null };
  assert.equal(row.base_sha, localSha, 'base_from_remote=false は古いローカル SHA を使う（従来挙動）');

  git(repo, ['worktree', 'remove', '--force', r.worktree_path]);
});
