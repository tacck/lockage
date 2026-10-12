import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, unixNow } from '../src/db/index.ts';
import {
  claimFiles,
  releaseClaim,
  listClaims,
  publishDirty,
  listDirty,
  computeUnclaimed,
  DEFAULT_CLAIM_TTL_SEC,
  DIRTY_RECONCILE_MIN_INTERVAL_SEC,
} from '../src/lockage/files.ts';

function freshDb() {
  return openDb({ path: ':memory:', hostId: 'test-host' });
}

// ---------- claim_files (advisory lease, §4.3) ----------

test('claim_files: a solo claim succeeds with no overlap', () => {
  const cdb = freshDb();
  const r = claimFiles(cdb, { agentId: 'A', globs: ['src/**'] });
  assert.ok(r.claim_id);
  assert.deepEqual(r.overlaps, []);
  assert.equal(listClaims(cdb, 'A').length, 1);
});

test('claim_files: an overlap is returned as a warning in overlaps but does not block (warn, never block)', () => {
  const cdb = freshDb();
  claimFiles(cdb, { agentId: 'A', globs: ['src/auth/**'] });
  const r = claimFiles(cdb, { agentId: 'B', globs: ['src/**'] });
  // B's claim is established (not blocked)
  assert.ok(r.claim_id);
  // and the overlap with A is returned as a warning
  assert.equal(r.overlaps.length, 1);
  assert.equal(r.overlaps[0].agent_id, 'A');
  assert.deepEqual(r.overlaps[0].globs, ['src/auth/**']);
  // both active
  assert.equal(listClaims(cdb).length, 2);
});

test('claim_files: does not overlap with one\'s own claim', () => {
  const cdb = freshDb();
  claimFiles(cdb, { agentId: 'A', globs: ['src/**'] });
  const r = claimFiles(cdb, { agentId: 'A', globs: ['src/auth/**'] });
  assert.deepEqual(r.overlaps, []);
});

test('claim_files: a claim on an unrelated area does not overlap', () => {
  const cdb = freshDb();
  claimFiles(cdb, { agentId: 'A', globs: ['src/a/**'] });
  const r = claimFiles(cdb, { agentId: 'B', globs: ['src/b/**'] });
  assert.deepEqual(r.overlaps, []);
});

test('claim_files: expires_at = now + ttl (default 8h)', () => {
  const cdb = freshDb();
  const before = unixNow();
  claimFiles(cdb, { agentId: 'A', globs: ['x/**'] });
  const row = listClaims(cdb, 'A')[0] as unknown as {
    heartbeat_at: number;
    expires_at: number;
    lease_ttl_sec: number;
  };
  assert.equal(row.lease_ttl_sec, DEFAULT_CLAIM_TTL_SEC);
  assert.ok(row.expires_at >= before + DEFAULT_CLAIM_TTL_SEC);
});

test('claim_files: an expired claim is not counted in overlap (sweep piggyback)', () => {
  const cdb = freshDb();
  // insert a claim with ttl=1s and expire it in the past
  claimFiles(cdb, { agentId: 'A', globs: ['src/**'], ttlSec: 1 });
  // force expires_at into the past
  cdb.db.prepare('UPDATE claims SET expires_at = ? WHERE holder = ?').run(
    unixNow() - 10,
    'A',
  );
  // on B's claim the sweep runs and A is treated as expired → no overlap
  const r = claimFiles(cdb, { agentId: 'B', globs: ['src/**'] });
  assert.deepEqual(r.overlaps, []);
});

// ---------- publish_dirty (dirty set, §4.4) ----------

test('publish_dirty: a solo publish has no overlap, 1 worktree=1 row', () => {
  const cdb = freshDb();
  const r = publishDirty(cdb, {
    agentId: 'A',
    worktreePath: '/wt/a',
    files: ['src/a.ts'],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.overlaps.dirty, []);
  assert.deepEqual(r.overlaps.claims, []);
  assert.equal(listDirty(cdb, 'A').length, 1);
});

test('publish_dirty: the same (agent, worktree) is overwritten by UPSERT', () => {
  const cdb = freshDb();
  publishDirty(cdb, { agentId: 'A', worktreePath: '/wt/a', files: ['src/a.ts'] });
  publishDirty(cdb, {
    agentId: 'A',
    worktreePath: '/wt/a',
    files: ['src/a.ts', 'src/b.ts'],
  });
  const rows = listDirty(cdb, 'A');
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].files), ['src/a.ts', 'src/b.ts']);
});

test('publish_dirty: files overlapping another agent\'s dirty become a warning + wake target', () => {
  const cdb = freshDb();
  publishDirty(cdb, { agentId: 'A', worktreePath: '/wt/a', files: ['src/x.ts'] });
  const r = publishDirty(cdb, {
    agentId: 'B',
    worktreePath: '/wt/b',
    files: ['src/x.ts', 'src/y.ts'],
  });
  assert.equal(r.overlaps.dirty.length, 1);
  assert.equal(r.overlaps.dirty[0].agent_id, 'A');
  assert.deepEqual(r.overlaps.dirty[0].files, ['src/x.ts']);
  assert.deepEqual(r.wake_targets, ['A']);
});

test('publish_dirty: files overlapping an active claim (glob) are warned', () => {
  const cdb = freshDb();
  claimFiles(cdb, { agentId: 'A', globs: ['src/**'] });
  const r = publishDirty(cdb, {
    agentId: 'B',
    worktreePath: '/wt/b',
    files: ['src/deep/z.ts'],
  });
  assert.equal(r.overlaps.claims.length, 1);
  assert.equal(r.overlaps.claims[0].agent_id, 'A');
  assert.deepEqual(r.wake_targets, ['A']);
});

test('publish_dirty: does not overlap with one\'s own claim/dirty', () => {
  const cdb = freshDb();
  claimFiles(cdb, { agentId: 'A', globs: ['src/**'] });
  publishDirty(cdb, { agentId: 'A', worktreePath: '/wt/a', files: ['src/a.ts'] });
  const r = publishDirty(cdb, {
    agentId: 'A',
    worktreePath: '/wt/a',
    files: ['src/a.ts', 'src/b.ts'],
  });
  assert.deepEqual(r.overlaps.dirty, []);
  assert.deepEqual(r.overlaps.claims, []);
  assert.deepEqual(r.wake_targets, []);
});

// ---------- unclaimed computation (Issue #52 proposal 3) ----------

test('computeUnclaimed: returns only files outside the glob of one\'s own claim', () => {
  const cdb = freshDb();
  claimFiles(cdb, { agentId: 'A', globs: ['src/**'] });
  const now = unixNow();
  const r = computeUnclaimed(cdb, 'A', ['src/a.ts', 'docs/readme.md'], now);
  // only docs/readme.md, which is not under src/**, is unclaimed.
  assert.deepEqual(r, ['docs/readme.md']);
});

test('computeUnclaimed: if one has no claim, all files are unclaimed', () => {
  const cdb = freshDb();
  const now = unixNow();
  const r = computeUnclaimed(cdb, 'A', ['src/a.ts', 'docs/readme.md'], now);
  assert.deepEqual(r, ['src/a.ts', 'docs/readme.md']);
});

test('computeUnclaimed: another agent\'s claim does not affect one\'s own unclaimed decision', () => {
  const cdb = freshDb();
  // even if B claims src/**, from A's view src/a.ts is outside A's own claim = unclaimed.
  claimFiles(cdb, { agentId: 'B', globs: ['src/**'] });
  const now = unixNow();
  const r = computeUnclaimed(cdb, 'A', ['src/a.ts'], now);
  assert.deepEqual(r, ['src/a.ts']);
});

test('publish_dirty: includes unclaimed (outside the glob of one\'s own claim) in the response', () => {
  const cdb = freshDb();
  claimFiles(cdb, { agentId: 'A', globs: ['src/**'] });
  const r = publishDirty(cdb, {
    agentId: 'A',
    worktreePath: '/wt/a',
    files: ['src/a.ts', 'docs/x.md'],
  });
  assert.deepEqual(r.unclaimed, ['docs/x.md']);
});

test('constant: DIRTY_RECONCILE_MIN_INTERVAL_SEC is 30 seconds', () => {
  assert.equal(DIRTY_RECONCILE_MIN_INTERVAL_SEC, 30);
});

test('release_claim: only the holder can release, and it drops from active thereafter', () => {
  const cdb = freshDb();
  const r = claimFiles(cdb, { agentId: 'A', globs: ['x/**'] });
  assert.equal(releaseClaim(cdb, r.claim_id, 'B').ok, false, 'a non-holder cannot release');
  assert.equal(listClaims(cdb, 'A').length, 1, 'still active after a non-holder fails');
  assert.equal(releaseClaim(cdb, r.claim_id, 'A').ok, true, 'the holder can release');
  // drops from active after release
  assert.equal(listClaims(cdb, 'A').length, 0);
  cdb.close();
});
