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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb, unixNow, type CoordDb } from '../src/db/index.js';
import { buildServer } from '../src/index.js';
import { assignWorktree } from '../src/lockage/worktree.js';
import {
  claimFiles,
  publishDirty,
  listDirty,
  reconcileDirtyFromWorktrees,
} from '../src/lockage/files.js';

// Issue #52 proposals 2/3: verify reconcileDirtyFromWorktrees, which auto-computes dirty from the git state
// of assigned worktrees, with a real git repo + worktree (follows worktree.test.ts's real-git pattern).

const SCRATCH = process.env.KIROCREW_SCRATCH ?? tmpdir();

let root: string;
let repoPath: string;
let cdb: CoordDb;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

before(() => {
  root = mkdtempSync(join(SCRATCH, 'lockage-dirty-'));
  repoPath = join(root, 'repo');
  mkdirSync(repoPath);
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'test']);
  // initial files on the base branch (main). prepare src/ and docs/.
  mkdirSync(join(repoPath, 'src'));
  mkdirSync(join(repoPath, 'docs'));
  writeFileSync(join(repoPath, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repoPath, 'docs', 'readme.md'), '# docs\n');
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

test('reconcile: merely changing a worktree file via fs (publish not called) shows up in dirty (acceptance condition 1)', () => {
  const wt = assignWorktree(cdb, { agentId: 'A', repoPath });
  // without calling publishDirty at all, directly change a file inside the worktree.
  writeFileSync(join(wt.worktree_path, 'src', 'a.ts'), 'export const a = 2;\n');
  const r = reconcileDirtyFromWorktrees(cdb, { agentId: 'A' });
  assert.ok(r.dirty_files.includes('src/a.ts'), 'src/a.ts is included in dirty');
  // reflected into list_dirty / dirty_sets too.
  const rows = listDirty(cdb, 'A');
  assert.equal(rows.length, 1);
  assert.ok(JSON.parse(rows[0].files).includes('src/a.ts'));
});

test('reconcile: untracked files (??) are also included in dirty', () => {
  const wt = assignWorktree(cdb, { agentId: 'A', repoPath });
  writeFileSync(join(wt.worktree_path, 'src', 'new.ts'), 'export const n = 1;\n');
  const r = reconcileDirtyFromWorktrees(cdb, { agentId: 'A' });
  assert.ok(r.dirty_files.includes('src/new.ts'));
});

test('reconcile: working-tree-only changes ( M) with multiple lines + paths with spaces do not break the path (porcelain -z)', () => {
  const wt = assignWorktree(cdb, { agentId: 'A', repoPath });
  // first add one tracked file with a "path containing spaces" to base (so later changes are tracked = ` M`).
  // without it in base it would be `??` untracked and not take the porcelain v1 bug path (leading space
  // remaining), so commit it to base once to make it tracked.
  writeFileSync(join(wt.worktree_path, 'src', 'c with space.ts'), 'export const c = 0;\n');
  git(wt.worktree_path, ['add', '.']);
  git(wt.worktree_path, ['commit', '-q', '-m', 'add spaced file']);
  // from here make multiple "working-tree-only changes ( M …)". rewrite both a.ts and the spaced file
  // without adding (the index stays clean = each line's X is a space = ` M path`).
  writeFileSync(join(wt.worktree_path, 'src', 'a.ts'), 'export const a = 2;\n');
  writeFileSync(join(wt.worktree_path, 'src', 'b.ts'), 'export const b = 2;\n');
  git(wt.worktree_path, ['add', 'src/b.ts']);
  git(wt.worktree_path, ['commit', '-q', '-m', 'add b']);
  writeFileSync(join(wt.worktree_path, 'src', 'b.ts'), 'export const b = 3;\n');
  writeFileSync(
    join(wt.worktree_path, 'src', 'c with space.ts'),
    'export const c = 1;\n',
  );
  // 3 ` M`s (working-tree-only changes) line up. even if a leading space remains from line 2 on, a -z
  // fixed-width parse does not break the path. in particular confirm a path with spaces is not split on tokenization.
  const r = reconcileDirtyFromWorktrees(cdb, { agentId: 'A', minIntervalSec: 0 });
  assert.ok(r.dirty_files.includes('src/a.ts'), 'src/a.ts is picked up correctly');
  assert.ok(r.dirty_files.includes('src/b.ts'), 'src/b.ts is picked up correctly');
  assert.ok(
    r.dirty_files.includes('src/c with space.ts'),
    'a path with spaces is picked up correctly without being split midway',
  );
  // no broken path from the old impl's bug (trailing tokenization) is mixed in.
  assert.ok(
    !r.dirty_files.some((f) => f === 'space.ts' || f === 'space.ts"'),
    'no broken path (space.ts etc.) is mixed in',
  );
});

test('reconcile: committed diffs from base_sha are also included in dirty (acceptance condition 2)', () => {
  const wt = assignWorktree(cdb, { agentId: 'A', repoPath });
  // change in the worktree and commit (= the working tree is clean but there is a diff from base).
  writeFileSync(join(wt.worktree_path, 'src', 'a.ts'), 'export const a = 3;\n');
  git(wt.worktree_path, ['add', '.']);
  git(wt.worktree_path, ['commit', '-q', '-m', 'change a']);
  // confirm the working tree is clean (not surfaced from git status).
  assert.equal(git(wt.worktree_path, ['status', '--porcelain']), '');
  const r = reconcileDirtyFromWorktrees(cdb, { agentId: 'A' });
  assert.ok(
    r.dirty_files.includes('src/a.ts'),
    'the committed (diff from base_sha) is included in dirty',
  );
});

test('reconcile: overlapping another agent\'s dirty produces overlaps and a wake (acceptance condition 3)', () => {
  const wt = assignWorktree(cdb, { agentId: 'A', repoPath });
  // B publishes src/a.ts as dirty first.
  publishDirty(cdb, { agentId: 'B', worktreePath: '/wt/b', files: ['src/a.ts'] });
  // A changes the same file in the worktree → reconcile raises an overlap and a wake.
  writeFileSync(join(wt.worktree_path, 'src', 'a.ts'), 'export const a = 9;\n');
  const r = reconcileDirtyFromWorktrees(cdb, { agentId: 'A' });
  assert.equal(r.overlaps.dirty.length, 1);
  assert.equal(r.overlaps.dirty[0].agent_id, 'B');
  assert.deepEqual(r.overlaps.dirty[0].files, ['src/a.ts']);
  assert.deepEqual(r.wake_targets, ['B']);
});

test('reconcile: overlapping another agent\'s claim produces overlaps.claims and a wake (acceptance condition 3)', () => {
  const wt = assignWorktree(cdb, { agentId: 'A', repoPath });
  claimFiles(cdb, { agentId: 'B', globs: ['src/**'] });
  writeFileSync(join(wt.worktree_path, 'src', 'a.ts'), 'export const a = 8;\n');
  const r = reconcileDirtyFromWorktrees(cdb, { agentId: 'A' });
  assert.equal(r.overlaps.claims.length, 1);
  assert.equal(r.overlaps.claims[0].agent_id, 'B');
  assert.deepEqual(r.wake_targets, ['B']);
});

test('reconcile: outside the claim glob shows up in unclaimed / inside the glob does not (acceptance condition 4)', () => {
  const wt = assignWorktree(cdb, { agentId: 'A', repoPath });
  // A claims src/**. src/a.ts is inside the claim, docs/readme.md is outside.
  claimFiles(cdb, { agentId: 'A', globs: ['src/**'] });
  writeFileSync(join(wt.worktree_path, 'src', 'a.ts'), 'export const a = 4;\n');
  writeFileSync(join(wt.worktree_path, 'docs', 'readme.md'), '# docs changed\n');
  const r = reconcileDirtyFromWorktrees(cdb, { agentId: 'A' });
  assert.ok(r.unclaimed.includes('docs/readme.md'), 'outside the claim shows up in unclaimed');
  assert.ok(!r.unclaimed.includes('src/a.ts'), 'inside the claim does not show up in unclaimed');
});

test('reconcile: the second git read is throttled by the minimum interval and the explicit publish in between is preserved (acceptance condition 5/6)', () => {
  const wt = assignWorktree(cdb, { agentId: 'A', repoPath });
  // first time: compute dirty from the worktree's git state (change src/a.ts).
  writeFileSync(join(wt.worktree_path, 'src', 'a.ts'), 'export const a = 5;\n');
  const r1 = reconcileDirtyFromWorktrees(cdb, { agentId: 'A' });
  assert.ok(r1.dirty_files.includes('src/a.ts'));
  assert.deepEqual(r1.reconciled_worktrees, [wt.worktree_path]);

  // in between, add a planned file with an explicit publish (updated time advances to now).
  publishDirty(cdb, {
    agentId: 'A',
    worktreePath: wt.worktree_path,
    files: ['src/a.ts', 'planned/future.ts'],
  });

  // change yet another file on the worktree side, but since it is within the minimum interval the second time throttles the git read.
  writeFileSync(join(wt.worktree_path, 'src', 'later.ts'), 'export const l = 1;\n');
  const r2 = reconcileDirtyFromWorktrees(cdb, { agentId: 'A' });
  // throttled, so the git-derived later.ts is not picked up, and the just-published (planned) one stays.
  assert.deepEqual(r2.reconciled_worktrees, [], 'the git read is skipped within the minimum interval');
  assert.ok(r2.dirty_files.includes('planned/future.ts'), 'the explicit publish\'s planned entry is preserved');
  assert.ok(!r2.dirty_files.includes('src/later.ts'), 'throttling does not pick up the new git change');
});

test('reconcile: disabling throttling (minIntervalSec=0) yields the union of the explicit publish planned entries and the git-derived ones (acceptance condition 6)', () => {
  const wt = assignWorktree(cdb, { agentId: 'A', repoPath });
  // surface a planned file with an explicit publish.
  publishDirty(cdb, {
    agentId: 'A',
    worktreePath: wt.worktree_path,
    files: ['planned/future.ts'],
  });
  // also change the worktree's git state.
  writeFileSync(join(wt.worktree_path, 'src', 'a.ts'), 'export const a = 7;\n');
  // with minIntervalSec=0 always do the git read and take the union of the planned and git-derived.
  const r = reconcileDirtyFromWorktrees(cdb, {
    agentId: 'A',
    minIntervalSec: 0,
  });
  assert.ok(r.dirty_files.includes('planned/future.ts'), 'the explicit publish planned entry stays in the union');
  assert.ok(r.dirty_files.includes('src/a.ts'), 'the git-derived change is also in the union');
});

test('reconcile: for a worktree row with no base_sha (unset) it falls back to status only', () => {
  const wt = assignWorktree(cdb, { agentId: 'A', repoPath });
  // force base_sha to NULL to simulate an old row (before FEAT-002).
  cdb.db
    .prepare(`UPDATE worktree_assignments SET base_sha = NULL WHERE agent_id = ?`)
    .run('A');
  // just commit to make the worktree clean (not surfaced from status).
  writeFileSync(join(wt.worktree_path, 'src', 'a.ts'), 'export const a = 11;\n');
  git(wt.worktree_path, ['add', '.']);
  git(wt.worktree_path, ['commit', '-q', '-m', 'c']);
  const r = reconcileDirtyFromWorktrees(cdb, { agentId: 'A', minIntervalSec: 0 });
  // no base_sha so the committed diff is not picked up, and status is clean so dirty is empty.
  assert.deepEqual(r.dirty_files, []);
  void unixNow;
});

test('publish_dirty handler: in a single call the union of explicit publish ∪ git state is returned (integration, acceptance condition 5/6)', async () => {
  // this test hits index.ts's publish_dirty handler over MCP. The handler passes minIntervalSec:0 to
  // reconcileDirtyFromWorktrees, so even if the min-interval skip would happen on the dirty row publishDirty
  // just wrote (updated_at=now), the same response always includes git-derived changes (untracked files) in
  // the union (verifies in integration that the old behavior of "a reconcile right after publishDirty via
  // the handler always skips" is fixed).
  const server = buildServer(cdb);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  // assign a worktree (create the active row).
  const assigned = JSON.parse(
    (
      (await client.callTool({
        name: 'assign_worktree',
        arguments: { agent_id: 'A', repo_path: repoPath },
      })) as any
    ).content[0].text,
  );
  const worktreePath: string = assigned.worktree_path;

  // make a git-derived change (an untracked file) in the worktree. not declared in publish_dirty.
  writeFileSync(join(worktreePath, 'src', 'gitonly.ts'), 'export const g = 1;\n');

  // explicitly publish only the planned file via publish_dirty.
  const res = JSON.parse(
    (
      (await client.callTool({
        name: 'publish_dirty',
        arguments: {
          agent_id: 'A',
          worktree_path: worktreePath,
          files: ['planned/future.ts'],
        },
      })) as any
    ).content[0].text,
  );

  // the dirty set has both the explicit publish (planned) and the git-derived (untracked) in the union.
  const rows = listDirty(cdb, 'A');
  assert.equal(rows.length, 1);
  const files: string[] = JSON.parse(rows[0].files);
  assert.ok(files.includes('planned/future.ts'), 'the explicitly published planned file stays in the union');
  assert.ok(
    files.includes('src/gitonly.ts'),
    'in the same call the git-derived untracked file is also in the union (minIntervalSec:0)',
  );
  // the response shape (ok/overlaps/wake_targets/unclaimed) is not broken either.
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.wake_targets));
  assert.ok(Array.isArray(res.unclaimed));
});
