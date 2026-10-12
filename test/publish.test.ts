import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, type CoordDb } from '../src/db/index.ts';
import { createTask, claimTask } from '../src/lockage/claim.ts';
import { claimFiles, listClaims } from '../src/lockage/files.ts';
import { openTicket } from '../src/lockage/tickets.ts';
import { assignWorktree } from '../src/lockage/worktree.ts';
import { onTaskDone } from '../src/lockage/merge.ts';
import { short } from '../src/lockage/git.ts';
import { LockageClient } from '../src/launcher/client.ts';
import {
  publishReadyTickets,
  reconcileMergedPrs,
  renderPrBody,
  closeTicketAfterMerge,
} from '../src/launcher/publish.ts';
import { PublishNoDiffError, type PublishAdapter, type PrRef } from '../src/launcher/publish-adapter.ts';

/**
 * Verification of the publish core (3) B-2 (design v1 §2 / §4.4).
 *
 * publishReadyTickets reads board/ticket from the core over MCP, so use a **real Lockage server** (start
 * dist/index.js via LockageClient) + a **real file DB**. ticket_ready + integration_branch are created for
 * real by running the in-process aggregation flow (onTaskDone) against the same file DB (the same path as
 * problem A). The publish side (push/PR) is an external side effect, so inject a **fake PublishAdapter** and
 * record how many times it was called and with what arguments.
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = join(PROJECT_ROOT, 'dist', 'index.js');
const SCRATCH = process.env.KIROCREW_SCRATCH ?? tmpdir();

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

/**
 * Aggregate 2 tasks of the same ticket → all done creates ticket_ready + integration_branch for real.
 * Run in-process against the file DB (the MCP server then reads the same DB).
 * @returns ticketId and the predicted integration branch name.
 */
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

/** A fake adapter that records the push/openPr/findPrByHead/deleteRemoteBranch it was called with. */
function makeFakeAdapter(opts?: {
  existing?: PrRef | null;
  prNumber?: number;
  openPrThrows?: Error;
  pushThrows?: Error;
  prStateValue?: 'OPEN' | 'MERGED' | 'CLOSED';
  deleteRemoteThrows?: Error;
}): PublishAdapter & {
  pushed: string[];
  openedHeads: string[];
  bodyFiles: string[];
  deletedRemote: string[];
} {
  const pushed: string[] = [];
  const openedHeads: string[] = [];
  const bodyFiles: string[] = [];
  const deletedRemote: string[] = [];
  let n = opts?.prNumber ?? 100;
  return {
    id: 'github',
    pushed,
    openedHeads,
    bodyFiles,
    deletedRemote,
    async pushBranch(_repo, branch) {
      if (opts?.pushThrows) throw opts.pushThrows;
      pushed.push(branch);
    },
    async openPr(a) {
      openedHeads.push(a.head);
      bodyFiles.push(a.bodyFile);
      if (opts?.openPrThrows) throw opts.openPrThrows;
      const num = n++;
      return { number: num, state: 'OPEN', url: `https://github.com/acme/repo/pull/${num}` };
    },
    async findPrByHead() {
      return opts?.existing ?? null;
    },
    async prState() {
      return opts?.prStateValue ?? 'OPEN';
    },
    async deleteRemoteBranch(_repo, branch) {
      if (opts?.deleteRemoteThrows) throw opts.deleteRemoteThrows;
      deletedRemote.push(branch);
    },
  };
}

// ── renderPrBody alone ────────────────────────────────────────────────

test('renderPrBody: includes the ticket body + task list + integration branch + lockage ticket, and omits Closes', () => {
  const body = renderPrBody(
    { id: 'I1', title: 't', body: 'acceptance criteria for the OAuth migration', integration_branch: 'lockage/ticket/ib', ticket_ready_at: 1 },
    [
      { id: 'T1', title: 'add greet', ticket_id: 'I1' },
      { id: 'T2', title: 'add farewell', ticket_id: 'I1' },
    ],
  );
  assert.match(body, /acceptance criteria for the OAuth migration/);
  assert.match(body, /## Tasks included in this PR/);
  assert.match(body, /- add greet \(T1\)/);
  assert.match(body, /- add farewell \(T2\)/);
  assert.match(body, /integration branch: lockage\/ticket\/ib/);
  assert.match(body, /lockage ticket: I1/);
  assert.doesNotMatch(body, /Closes #/, 'Phase 1 omits Closes (recommended scope D-B2)');
});

test('renderPrBody: does not fail even if tasks are empty', () => {
  const body = renderPrBody(
    { id: 'I1', title: 't', body: null, integration_branch: 'b', ticket_ready_at: 1 },
    [],
  );
  assert.match(body, /- \(none\)/);
});

// ── publishReadyTickets integration (real Lockage + fake adapter) ──────────────────

test('publishReadyTickets: publishes 1 ticket_ready and leaves pr_opened on the board', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub2-publish-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  // create a ready ticket in-process against the same file DB → close (the MCP server opens it).
  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId, branch } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  const adapter = makeFakeAdapter({ prNumber: 7 });
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => true, // the integration branch physically exists locally from in-process aggregation
  });

  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0], {
    ticketId,
    result: 'published',
    prNumber: 7,
    url: 'https://github.com/acme/repo/pull/7',
  });
  assert.deepEqual(adapter.pushed, [branch], 'pushed the integration branch');
  assert.deepEqual(adapter.openedHeads, [branch], 'created the PR with head=integration branch');

  // 1 pr_opened (ref_ticket_id) remains on the board
  const opened = await client.callTool('read_board', { kind: 'pr_opened' });
  const mine = opened.messages.filter((m: any) => m.ref_ticket_id === ticketId);
  assert.equal(mine.length, 1);
  assert.match(mine[0].body, /PR #7/);
});

test('publishReadyTickets: idempotent — the second time skips tickets that have pr_opened (openPr only once)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub2-idem-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  const adapter = makeFakeAdapter();
  const args = { repoPath, base: 'main', agentId: 'publisher', localBranchExists: () => true };

  const first = await publishReadyTickets(client, adapter, args);
  assert.equal(first[0].result, 'published');
  const second = await publishReadyTickets(client, adapter, args);
  assert.equal(second.length, 1);
  assert.equal(second[0].result, 'already_opened', 'the second time skips via the board pr_opened');
  assert.equal(adapter.openedHeads.length, 1, 'openPr is called once in total (no double PR)');

  const opened = await client.callTool('read_board', { kind: 'pr_opened' });
  assert.equal(
    opened.messages.filter((m: any) => m.ref_ticket_id === ticketId).length,
    1,
    'pr_opened is also just 1',
  );
});

test('publishReadyTickets: existing-PR detection — if findPrByHead returns, do not call openPr and only leave pr_opened', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub2-existing-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  // no pr_opened on the board, but the forge already has PR #99 (re-run after a crash)
  const adapter = makeFakeAdapter({
    existing: { number: 99, state: 'OPEN', url: 'https://github.com/acme/repo/pull/99' },
  });
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => true,
  });

  assert.equal(outcomes[0].result, 'existing_pr');
  assert.equal((outcomes[0] as any).prNumber, 99);
  assert.equal(adapter.openedHeads.length, 0, 'does not call openPr (no double creation)');
  assert.equal(adapter.pushed.length, 0, 'does not push either (an existing PR is present)');

  const opened = await client.callTool('read_board', { kind: 'pr_opened' });
  const mine = opened.messages.filter((m: any) => m.ref_ticket_id === ticketId);
  assert.equal(mine.length, 1);
  assert.match(mine[0].body, /PR #99/);
});

test('publishReadyTickets: skip if the integration branch is not local (§3 point 9)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub2-notlocal-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  const adapter = makeFakeAdapter();
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => false, // generated on another host so no local entity
  });

  assert.equal(outcomes[0].result, 'skipped');
  assert.equal((outcomes[0] as any).reason, 'branch_not_local');
  assert.equal(adapter.pushed.length, 0, 'does not push');
  assert.equal(adapter.openedHeads.length, 0, 'does not create a PR either');
  const opened = await client.callTool('read_board', { kind: 'pr_opened' });
  assert.equal(opened.messages.filter((m: any) => m.ref_ticket_id === ticketId).length, 0);
});

test('publishReadyTickets: with onlyTicket, process only that ticket', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub2-only-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const a = seedReadyTicket(cdb, repoPath, 'issa');
  const b = seedReadyTicket(cdb, repoPath, 'issb');
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  const adapter = makeFakeAdapter();
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    onlyTicket: b.ticketId,
    localBranchExists: () => true,
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ticketId, b.ticketId);
  assert.equal(adapter.openedHeads.length, 1);
  assert.notEqual(a.ticketId, b.ticketId);
});

test('publishReadyTickets: if openPr is PublishNoDiffError, skip (no_diff) and the loop does not fail (M-1)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub2-nodiff-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  const adapter = makeFakeAdapter({ openPrThrows: new PublishNoDiffError('lockage/ticket/x', 'main') });
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => true,
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].result, 'skipped');
  assert.equal((outcomes[0] as any).reason, 'no_diff');
  // with no diff, do not leave pr_opened (it can be reprocessed if a diff appears later)
  const opened = await client.callTool('read_board', { kind: 'pr_opened' });
  assert.equal(opened.messages.filter((m: any) => m.ref_ticket_id === ticketId).length, 0);
});

test('publishReadyTickets: even on an unexpected openPr error, record failed and continue other tickets (M-1)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub2-failed-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  seedReadyTicket(cdb, repoPath, 'fa');
  seedReadyTicket(cdb, repoPath, 'fb');
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  // all tickets' openPr fails with the same unexpected error → each is recorded failed and the loop runs to the end
  const adapter = makeFakeAdapter({ openPrThrows: new Error('gh exploded') });
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => true,
  });

  assert.equal(outcomes.length, 2, 'one ticket\'s failure does not stop the batch; both are processed');
  for (const o of outcomes) {
    assert.equal(o.result, 'failed');
    assert.match((o as any).error, /gh exploded/);
  }
});

// ── reconcileMergedPrs B-3 (merge-detection cleanup) ──────────────────────

/** Publish 1 ticket_ready and stack pr_opened on the board (set up the premise for reconcile). */
async function publishOne(
  client: LockageClient,
  repoPath: string,
): Promise<{ ticketId: string; branch: string }> {
  const adapter = makeFakeAdapter({ prNumber: 1 });
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => true,
  });
  const published = outcomes.find((o) => o.result === 'published');
  assert.ok(published, 'premise: published');
  return { ticketId: published!.ticketId, branch: adapter.pushed[0] };
}

test('reconcileMergedPrs: detect PR MERGED and do remote delete + integration_branch NULL reset + pr_merged', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-rec-merged-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { branch } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  const { ticketId } = await publishOne(client, repoPath);
  // premise-confirm via read_ticket that integration_branch is set. also record the version
  // (close is a dedicated path that does not bump version, so confirm later that version is kept after close).
  const before = await client.callTool('read_ticket', { ticket_id: ticketId });
  assert.equal(before.ticket.integration_branch, branch);
  const versionBefore = before.ticket.version;

  // the PR became MERGED
  const adapter = makeFakeAdapter({ prStateValue: 'MERGED' });
  const deletedLocal: string[] = [];
  const outcomes = await reconcileMergedPrs(client, adapter, {
    repoPath,
    agentId: 'publisher',
    deleteLocalBranch: (_r, b) => {
      deletedLocal.push(b);
      return true;
    },
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].result, 'merged');
  assert.equal((outcomes[0] as any).cleared, true);
  assert.equal((outcomes[0] as any).branchDeleted, true);
  assert.equal((outcomes[0] as any).ticketClosed, 'closed', 'closed the ticket after merge');
  assert.deepEqual(adapter.deletedRemote, [branch], 'deleted the remote branch');
  assert.deepEqual(deletedLocal, [branch], 'deleted the local branch');

  // integration_branch is reset to NULL
  const after = await client.callTool('read_ticket', { ticket_id: ticketId });
  assert.equal(after.ticket.integration_branch, null);
  // the ticket becomes closed (do not leave merged work open)
  assert.equal(after.ticket.status, 'closed', 'ticket.status is closed');
  // close is a dedicated path (close_ticket_on_merge) that does not bump version, so version is kept
  // (D-B1: post-merge cleanup is a system operation and does not ride the user-edit version-CAS).
  assert.equal(after.ticket.version, versionBefore, 'close does not bump version');
  // 1 pr_merged on the board
  const m = await client.callTool('read_board', { kind: 'pr_merged' });
  assert.equal(m.messages.filter((x: any) => x.ref_ticket_id === ticketId).length, 1);
});

test('reconcileMergedPrs: if the PR is still OPEN, still_open and clean up nothing', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-rec-open-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { branch } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  const { ticketId } = await publishOne(client, repoPath);

  const adapter = makeFakeAdapter({ prStateValue: 'OPEN' });
  const outcomes = await reconcileMergedPrs(client, adapter, { repoPath, agentId: 'publisher' });

  assert.equal(outcomes[0].result, 'still_open');
  assert.equal(adapter.deletedRemote.length, 0, 'does not delete');
  const after = await client.callTool('read_ticket', { ticket_id: ticketId });
  assert.equal(after.ticket.integration_branch, branch, 'integration_branch remains');
  assert.notEqual(after.ticket.status, 'closed', 'does not close the ticket while unmerged (OPEN)');
  const m = await client.callTool('read_board', { kind: 'pr_merged' });
  assert.equal(m.messages.length, 0, 'no pr_merged appears');
});

test('reconcileMergedPrs: idempotent — the second time does not touch tickets that have pr_merged', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-rec-idem-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  await publishOne(client, repoPath);

  const adapter = makeFakeAdapter({ prStateValue: 'MERGED' });
  const first = await reconcileMergedPrs(client, adapter, {
    repoPath,
    agentId: 'publisher',
    deleteLocalBranch: () => true,
  });
  assert.equal(first[0].result, 'merged');

  const second = await reconcileMergedPrs(client, adapter, {
    repoPath,
    agentId: 'publisher',
    deleteLocalBranch: () => true,
  });
  assert.equal(second.length, 0, 'the second time has zero targets since pr_merged is present');
  assert.equal(adapter.deletedRemote.length, 1, 'remote delete is once in total');
  const m = await client.callTool('read_board', { kind: 'pr_merged' });
  assert.equal(m.messages.length, 1, 'pr_merged also stays at 1');
});

// ── #32: reconcile's MERGED path releases done-task worktrees under the ticket ──────────

test('reconcileMergedPrs: with PR MERGED and all tasks done, release the done-task worktrees under the ticket (#32)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-rec-wt-release-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  const { ticketId } = await publishOne(client, repoPath);

  // premise: the 1-B path (onTaskDone) does not release worktrees, so even all-done the worktrees stay active.
  const before = await client.callTool('list_worktrees', {});
  assert.equal(before.length, 2, 'before reconcile 2 worktrees are active (1-B does not release)');

  const adapter = makeFakeAdapter({ prStateValue: 'MERGED' });
  const outcomes = await reconcileMergedPrs(client, adapter, {
    repoPath,
    agentId: 'publisher',
    deleteLocalBranch: () => true,
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].result, 'merged');
  assert.equal((outcomes[0] as any).worktreesReleased, 2, 'released 2 done-task worktrees');

  // after reconcile the worktree assignments under that ticket are no longer active (not in list_worktrees).
  const after = await client.callTool('list_worktrees', {});
  assert.equal(after.length, 0, 'reconcile released all worktrees and 0 are active');
  void ticketId;
});

// ── Issue #45: reconcile's MERGED path releases leftover claims tied to done tasks under the ticket ──────────

test('reconcileMergedPrs: with PR MERGED and all tasks done, release the done-task claims under the ticket (#45)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-rec-claim-release-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId } = seedReadyTicket(cdb, repoPath);
  // reproduce a leftover: directly insert an active claim tied to a done task under the ticket.
  // seedReadyTicket goes through onTaskDone (task_done), but here to simulate "a leftover from before
  // item 1 was introduced" or "a task that became done without task_done", place the claim after it is done.
  const doneTask = cdb.db
    .prepare(`SELECT id FROM tasks WHERE ticket_id = ? AND status = 'done' LIMIT 1`)
    .get(ticketId) as { id: string };
  claimFiles(cdb, { agentId: 'straggler-agent', globs: ['src/**'], taskId: doneTask.id });
  assert.equal(listClaims(cdb).length, 1, 'before reconcile the leftover claim is active');
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  const { ticketId: pubId } = await publishOne(client, repoPath);
  assert.equal(pubId, ticketId);

  const adapter = makeFakeAdapter({ prStateValue: 'MERGED' });
  const outcomes = await reconcileMergedPrs(client, adapter, {
    repoPath,
    agentId: 'publisher',
    deleteLocalBranch: () => true,
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].result, 'merged');
  assert.equal((outcomes[0] as any).claimsReleased, 1, 'released 1 leftover claim of a done task');

  // after reconcile that claim is no longer active (not in list_claims).
  const remaining = await client.callTool('list_claims', {});
  assert.equal(remaining.length, 0, 'reconcile released the leftover claim and 0 are active');
});

test('reconcileMergedPrs: for a ticket with a not-done task remaining, do not release worktrees (skipped_unmerged_tasks)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-rec-wt-guard-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId } = seedReadyTicket(cdb, repoPath);
  // add a not-done task to the same ticket later (a re-arm situation).
  createTask(cdb, { repo: 'repo', title: 'a later-added B', ticketId });
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  const { ticketId: pubId } = await publishOne(client, repoPath);
  assert.equal(pubId, ticketId);

  const beforeCount = (await client.callTool('list_worktrees', {})).length;
  assert.equal(beforeCount, 2, 'before reconcile 2 worktrees are active');

  const adapter = makeFakeAdapter({ prStateValue: 'MERGED' });
  const outcomes = await reconcileMergedPrs(client, adapter, {
    repoPath,
    agentId: 'publisher',
    deleteLocalBranch: () => true,
  });

  assert.equal(outcomes[0].result, 'skipped_unmerged_tasks', 'skip because a not-done task remains');
  // the skip path does not reach worktree release (worktrees stay active).
  const after = await client.callTool('list_worktrees', {});
  assert.equal(after.length, 2, 'while a not-done task remains, do not release worktrees');
});

// ── #37: dirty-mixed — release the clean ones and keep the dirty ones active (worktreesReleased < the assignment count) ──

test('reconcileMergedPrs: with a dirty worktree mixed in, release only the clean one and keep the dirty one active (worktreesReleased < the assignment count) (#37)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-rec-wt-dirty-mix-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  await publishOne(client, repoPath);

  // premise: the 1-B path (onTaskDone) does not release worktrees, so both worktrees stay clean and active.
  const before = (await client.callTool('list_worktrees', {})) as Array<{
    agent_id: string;
    worktree_path: string;
    branch: string;
  }>;
  assert.equal(before.length, 2, 'before reconcile 2 worktrees are active (1-B does not release)');

  // deterministically make one of the two (the one whose agent_id ends with -claude-02) dirty.
  // dirtying method: overwrite README.md (committed by initRepo as a tracked file) inside the worktree and
  // do not add/commit (= an uncommitted tracked diff). this makes `git worktree remove` (without --force)
  // refuse, so that worktree is not released and stays active (the FEAT-002/#33 behavior).
  const dirtyRow = before.find((w) => w.agent_id.endsWith('-claude-02'));
  const cleanRow = before.find((w) => w.agent_id.endsWith('-claude-01'));
  assert.ok(dirtyRow, 'the dirtying target (-claude-02) worktree assignment exists');
  assert.ok(cleanRow, 'the stays-clean (-claude-01) worktree assignment exists');
  writeFileSync(join(dirtyRow!.worktree_path, 'README.md'), '# dirty — an uncommitted tracked diff\n');

  const adapter = makeFakeAdapter({ prStateValue: 'MERGED' });
  const outcomes = await reconcileMergedPrs(client, adapter, {
    repoPath,
    agentId: 'publisher',
    deleteLocalBranch: () => true,
  });

  // the MERGED path runs. but the 1 dirty one cannot be released due to a remove refusal, so
  // worktreesReleased is the number actually released (= 1) = less than the assignment count (2).
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].result, 'merged');
  assert.equal(
    (outcomes[0] as any).worktreesReleased,
    1,
    'only the clean 1 is released, the dirty 1 cannot be (less than the assignment count 2)',
  );

  // the clean one disappears from the ledger (no longer active) and the dirty one stays active.
  const after = (await client.callTool('list_worktrees', {})) as Array<{
    agent_id: string;
    worktree_path: string;
    branch: string;
  }>;
  assert.equal(after.length, 1, 'only the dirty 1 stays active');
  assert.equal(after[0].agent_id, dirtyRow!.agent_id, 'what remained is the dirtied -claude-02 worktree');
  assert.ok(
    !after.some((w) => w.agent_id === cleanRow!.agent_id),
    'the clean -claude-01 worktree was released and disappeared from the ledger',
  );
});

// ── Fix proposal A: reconcile guard (protect the branch while a not-done task remains) ──────────

test('reconcileMergedPrs: even with PR MERGED, if a not-done task remains under the ticket skip (protect the branch)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-rec-guard-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId, branch } = seedReadyTicket(cdb, repoPath);
  // add a not-done task (B) to the same ticket later (= a re-arm situation. do not make it done).
  // createTask re-arms if the ticket was already ready, so ticket_ready_at also resets to NULL.
  createTask(cdb, { repo: 'repo', title: 'a later-added B', ticketId });
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  // create pr_opened first (A's PR).
  const { ticketId: pubId } = await publishOne(client, repoPath);
  assert.equal(pubId, ticketId);

  // A's PR became MERGED, but the not-done B is mid-way being stacked onto the integration branch.
  const adapter = makeFakeAdapter({ prStateValue: 'MERGED' });
  const deletedLocal: string[] = [];
  const outcomes = await reconcileMergedPrs(client, adapter, {
    repoPath,
    agentId: 'publisher',
    deleteLocalBranch: (_r, b) => {
      deletedLocal.push(b);
      return true;
    },
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].result, 'skipped_unmerged_tasks', 'skip because a not-done task remains');
  assert.equal(adapter.deletedRemote.length, 0, 'does not delete the remote branch');
  assert.equal(deletedLocal.length, 0, 'does not delete the local branch either');
  // integration_branch remains (B does not disappear).
  const after = await client.callTool('read_ticket', { ticket_id: ticketId });
  assert.equal(after.ticket.integration_branch, branch, 'integration_branch does not reset to NULL');
  // since a not-done task remains, the ticket is not closed either (skipped_unmerged_tasks does not close).
  assert.notEqual(after.ticket.status, 'closed', 'skipped_unmerged_tasks does not close the ticket');
  // pr_merged is not posted (re-evaluated on the next run).
  const m = await client.callTool('read_board', { kind: 'pr_merged' });
  assert.equal(m.messages.filter((x: any) => x.ref_ticket_id === ticketId).length, 0, 'no pr_merged appears');
});

// ── Fix proposal A: a re-emission for an already-opened ticket updates the existing PR via a follow-up push ──

test('publishReadyTickets: a ticket_ready re-emission for a pr_opened ticket re-pushes the integration branch to update the existing PR', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-update-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId, branch } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  // first time: create a new PR (pr_opened remains on the board).
  const first = await publishOne(client, repoPath);
  assert.equal(first.ticketId, ticketId);

  // create a situation where ticket_ready is re-emitted "after pr_opened" by a re-arm.
  // (in production the re-arm of createTask/linkTaskToTicket → a new task done makes tryEmitTicketReady
  //  re-emit. here reproduce the board seq relation = "a ticket_ready newer than pr_opened" directly via post_board.)
  await client.callTool('post_board', {
    agent_id: 'system',
    kind: 'ticket_ready',
    ref_ticket_id: ticketId,
    body: `ticket ${ticketId}: all tasks done (re-emit)`,
  });

  // second time: pr_opened present + ticket_ready re-emitted afterward.
  // do not call openPr; follow-up push the integration branch to update the existing PR (result='updated').
  const adapter = makeFakeAdapter();
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => true,
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].result, 'updated', 'the existing-PR update path');
  assert.equal((outcomes[0] as any).branch, branch);
  assert.deepEqual(adapter.pushed, [branch], 're-pushed the integration branch (the PR auto-follows the update)');
  assert.equal(adapter.openedHeads.length, 0, 'does not call openPr (does not create a new PR)');

  // pr_opened stays at 1 (no new PR was created).
  const opened = await client.callTool('read_board', { kind: 'pr_opened' });
  assert.equal(
    opened.messages.filter((m: any) => m.ref_ticket_id === ticketId).length,
    1,
    'pr_opened stays at 1',
  );
});

test('publishReadyTickets: even if judged waiting-for-update, if the integration branch is not local skip with branch_not_local (no silent skip)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-update-notlocal-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  // first time: create a new PR (pr_opened remains on the board).
  const first = await publishOne(client, repoPath);
  assert.equal(first.ticketId, ticketId);

  // re-emit ticket_ready after pr_opened (= waiting for a follow-up push).
  await client.callTool('post_board', {
    agent_id: 'system',
    kind: 'ticket_ready',
    ref_ticket_id: ticketId,
    body: `ticket ${ticketId}: all tasks done (re-emit)`,
  });

  // judged "should update (re-emitted)", but the integration branch is not local (generated on another host / not generated).
  // do not silently fold into already_opened; visualize it with the distinguishable branch_not_local.
  const adapter = makeFakeAdapter();
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => false,
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].result, 'skipped', 'an explicit skip rather than a silent skip');
  assert.equal((outcomes[0] as any).reason, 'branch_not_local');
  assert.equal(adapter.pushed.length, 0, 'the follow-up push is not called (no local branch)');
  assert.equal(adapter.openedHeads.length, 0, 'does not create a new PR either');

  // pr_opened stays at 1 (no new PR was created).
  const opened = await client.callTool('read_board', { kind: 'pr_opened' });
  assert.equal(
    opened.messages.filter((m: any) => m.ref_ticket_id === ticketId).length,
    1,
    'pr_opened stays at 1',
  );
});

test('reconcileMergedPrs: even if remote delete fails (already deleted) the post-processing continues', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-rec-delfail-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  const { ticketId } = await publishOne(client, repoPath);

  // the case where GitHub's auto-delete already removed it and deleteRemoteBranch throws
  const adapter = makeFakeAdapter({
    prStateValue: 'MERGED',
    deleteRemoteThrows: new Error('remote ref does not exist'),
  });
  const outcomes = await reconcileMergedPrs(client, adapter, {
    repoPath,
    agentId: 'publisher',
    deleteLocalBranch: () => true,
  });

  assert.equal(outcomes[0].result, 'merged', 'completes post-processing as merged even if remote delete fails');
  const after = await client.callTool('read_ticket', { ticket_id: ticketId });
  assert.equal(after.ticket.integration_branch, null, 'integration_branch resets to NULL');
  const m = await client.callTool('read_board', { kind: 'pr_merged' });
  assert.equal(m.messages.filter((x: any) => x.ref_ticket_id === ticketId).length, 1);
});

// ── regression prevention for the 100-row window (the old default limit) problem ──────────────────────────────
//
// board is a cumulative log, so if the publisher reads read_board at the default limit=100 (seq ASC = the
// oldest 100), as operation time grows and board rows increase, "the latest ticket_ready / pr_opened" falls
// out of the window. FEAT-002 aligned publishReadyTickets / reconcileMergedPrs read_board to read all rows
// (limit=BOARD_READ_ALL_LIMIT) to eliminate the miss.
//
// the following 2 are meaningful regression tests that fail if FEAT-002 is reverted (omit limit = back to the
// oldest-100 window). read_board's kind filter takes effect in the SQL WHERE, so stack 101+ messages of the
// target kind to push "the target ticket's latest message" out of that kind's 100-row window.

test('publishReadyTickets: even on a 100+ row board, pick up the latest re-emitted ticket_ready and follow-up push the existing PR (regression prevention for the 100-row window problem)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-window-ready-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId, branch } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  // first time: create a new PR (pr_opened remains on the board).
  const first = await publishOne(client, repoPath);
  assert.equal(first.ticketId, ticketId);

  // to fill read_board(kind='ticket_ready')'s default 100-row window, stack 101 dummy ticket_ready and push
  // up seq. ref_ticket_id is an FK to tickets(id) so a real ticket is required = here use NULL
  // (the publish side skips rows with no ref_ticket_id, but as kind='ticket_ready' they consume the 100-row
  // window slot). This pushes the target ticket's "latest ticket_ready" out of the oldest-100 window.
  for (let i = 0; i < 101; i++) {
    await client.callTool('post_board', {
      agent_id: 'system',
      kind: 'ticket_ready',
      ref_ticket_id: null,
      body: `dummy ticket_ready (window filler) #${i}`,
    });
  }

  // re-emit the target ticket's ticket_ready at the latest seq after pr_opened (equivalent to a re-arm).
  await client.callTool('post_board', {
    agent_id: 'system',
    kind: 'ticket_ready',
    ref_ticket_id: ticketId,
    body: `ticket ${ticketId}: all tasks done (re-emit)`,
  });

  // with read-all it picks up the latest re-emitted ticket_ready and updates the existing PR via a follow-up push of the integration branch.
  // in the old impl (oldest-100 window) the re-emitted ticket_ready is unreadable out of the window and does not become updated = fails on revert.
  const adapter = makeFakeAdapter();
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => true,
  });

  const mine = outcomes.find((o) => o.ticketId === ticketId);
  assert.ok(mine, 'the target ticket is included in the outcome (picked up even out of the window)');
  assert.equal(mine!.result, 'updated', 'picks up the latest re-emitted ticket_ready and enters the existing-PR update path');
  assert.equal((mine as any).branch, branch);
  assert.deepEqual(adapter.pushed, [branch], 're-pushed the integration branch (the PR auto-follows the update)');
  assert.equal(adapter.openedHeads.length, 0, 'does not call openPr (does not create a new PR)');
});

test('reconcileMergedPrs: even on a 100+ row board, detect the MERGED of a pr_opened out of the window and clean up (regression prevention for the 100-row window problem)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-rec-window-opened-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId, branch } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  // first fill read_board(kind='pr_opened')'s default 100-row window. read_board returns seq ASC = the oldest 100,
  // so to make the target ticket's pr_opened "out of the window" we need to stack dummies first and make the
  // target pr_opened the latest seq. ref_ticket_id is an FK to tickets(id) so a real ticket is required = here use NULL
  // (the reconcile side skips rows with no ref_ticket_id, but as kind='pr_opened' they consume the 100-row window slot).
  for (let i = 0; i < 101; i++) {
    await client.callTool('post_board', {
      agent_id: 'publisher',
      kind: 'pr_opened',
      ref_ticket_id: null,
      body: `PR #${900 + i} https://github.com/acme/repo/pull/${900 + i}`,
    });
  }

  // after the dummies, stack the target ticket's pr_opened via publishOne (= the latest seq). this puts the
  // target pr_opened out of the oldest-100 window. the old impl cannot read this target pr_opened and misses it from reconcile.
  const { ticketId: pubId } = await publishOne(client, repoPath);
  assert.equal(pubId, ticketId);

  // the target ticket's PR became MERGED. with read-all it picks up the out-of-window pr_opened and detects the merge.
  // in the old impl (oldest-100 window) it cannot read the out-of-window pr_opened and misses the target ticket from the outcome = fails on revert.
  // seedReadyTicket's 2 tasks are done, so it does not hit the not-done guard (skipped_unmerged_tasks).
  const adapter = makeFakeAdapter({ prStateValue: 'MERGED' });
  const deletedLocal: string[] = [];
  const outcomes = await reconcileMergedPrs(client, adapter, {
    repoPath,
    agentId: 'publisher',
    deleteLocalBranch: (_r, b) => {
      deletedLocal.push(b);
      return true;
    },
  });

  const mine = outcomes.find((o) => o.ticketId === ticketId);
  assert.ok(mine, 'the target ticket is included in the outcome (picked up even out of the window)');
  assert.equal(mine!.result, 'merged', 'detected the MERGED of the out-of-window pr_opened and cleaned up');
  assert.deepEqual(adapter.deletedRemote, [branch], 'deleted the remote branch');
  assert.deepEqual(deletedLocal, [branch], 'deleted the local branch');

  // integration_branch resets to NULL and 1 pr_merged remains on the board.
  const after = await client.callTool('read_ticket', { ticket_id: ticketId });
  assert.equal(after.ticket.integration_branch, null);
  const m = await client.callTool('read_board', { kind: 'pr_merged', limit: 1_000_000 });
  assert.equal(m.messages.filter((x: any) => x.ref_ticket_id === ticketId).length, 1);
});

// ── Fix: reconcile's MERGED path closes the ticket ──────────────

/** A minimal LockageClient stub with only callTool (for closeTicketAfterMerge unit tests). */
function makeClientStub(handler: (tool: string, args: any) => any): any {
  return {
    async callTool(tool: string, args: any) {
      return handler(tool, args);
    },
  };
}

test('closeTicketAfterMerge: calls close_ticket_on_merge once and returns closed if closed:true', async () => {
  const calls: Array<{ tool: string; args: any }> = [];
  const client = makeClientStub((tool, args) => {
    calls.push({ tool, args });
    if (tool === 'close_ticket_on_merge') return { ok: true, closed: true };
    throw new Error(`unexpected tool ${tool}`);
  });
  const res = await closeTicketAfterMerge(client, 'I1');
  assert.equal(res, 'closed');
  // hit the version-not-bumping dedicated path exactly once (does not call read_ticket or update_ticket).
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'close_ticket_on_merge');
  assert.deepEqual(calls[0].args, { ticket_id: 'I1' });
});

test('closeTicketAfterMerge: if already closed (closed:false), return already_closed', async () => {
  const calls: string[] = [];
  const client = makeClientStub((tool) => {
    calls.push(tool);
    if (tool === 'close_ticket_on_merge') return { ok: true, closed: false };
    throw new Error(`unexpected tool ${tool}`);
  });
  const res = await closeTicketAfterMerge(client, 'I1');
  assert.equal(res, 'already_closed');
  assert.deepEqual(calls, ['close_ticket_on_merge']);
});

test('closeTicketAfterMerge: if the ticket is missing (ok:false, not_found), return not_found', async () => {
  const client = makeClientStub((tool) => {
    if (tool === 'close_ticket_on_merge') return { ok: false, reason: 'not_found' };
    throw new Error(`unexpected tool ${tool}`);
  });
  const res = await closeTicketAfterMerge(client, 'I1');
  assert.equal(res, 'not_found');
});

test('reconcileMergedPrs: an already-closed ticket is not re-updated (version not bumped) but pr_merged appears', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-rec-already-closed-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  await publishOne(client, repoPath);

  // close the ticket by hand first (= an already-closed situation). record the version.
  const before = await client.callTool('read_ticket', { ticket_id: ticketId });
  const upd = await client.callTool('update_ticket', {
    ticket_id: ticketId,
    expected_version: before.ticket.version,
    status: 'closed',
  });
  assert.equal(upd.ok, true);
  const closedVersion = upd.ticket.version;

  const adapter = makeFakeAdapter({ prStateValue: 'MERGED' });
  const outcomes = await reconcileMergedPrs(client, adapter, {
    repoPath,
    agentId: 'publisher',
    deleteLocalBranch: () => true,
  });

  assert.equal(outcomes[0].result, 'merged');
  assert.equal((outcomes[0] as any).ticketClosed, 'already_closed', 'already closed so no re-update');

  // version is not bumped (not re-updated).
  const after = await client.callTool('read_ticket', { ticket_id: ticketId });
  assert.equal(after.ticket.status, 'closed');
  assert.equal(after.ticket.version, closedVersion, 'does not bump the version of an already-closed ticket');
  // pr_merged appears (cleanup proceeds).
  const m = await client.callTool('read_board', { kind: 'pr_merged' });
  assert.equal(m.messages.filter((x: any) => x.ref_ticket_id === ticketId).length, 1);
});

// ── This fix: a successful follow-up push leaves pr_updated and does not redo the same push every time ──────────

test('publishReadyTickets: a successful follow-up push leaves 1 pr_updated and the next time does not re-push (waiting-for-update resolved)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-prupdated-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId, branch } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  // first time: create a new PR.
  await publishOne(client, repoPath);
  // re-emit ticket_ready after pr_opened by a re-arm (= waiting for a follow-up push).
  await client.callTool('post_board', {
    agent_id: 'system',
    kind: 'ticket_ready',
    ref_ticket_id: ticketId,
    body: `ticket ${ticketId}: re-emit`,
  });

  // second time: update via a follow-up push → 1 pr_updated remains.
  const adapter = makeFakeAdapter();
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => true,
  });
  assert.equal(outcomes[0].result, 'updated');
  assert.deepEqual(adapter.pushed, [branch], 'the follow-up push runs');

  const updated1 = await client.callTool('read_board', { kind: 'pr_updated' });
  assert.equal(
    updated1.messages.filter((m: any) => m.ref_ticket_id === ticketId).length,
    1,
    '1 pr_updated remains',
  );

  // it disappears from publisher_status's pending_update (corresponds to the acceptance check).
  const statusAfter = await client.callTool('publisher_status', {});
  assert.ok(
    !statusAfter.pending_update_tickets.some((p: any) => p.ref_ticket_id === ticketId),
    'after a follow-up push it disappears from pending_update',
  );

  // third time: no new ticket_ready stacked → already follow-up pushed so no re-push (idempotent).
  const adapter2 = makeFakeAdapter();
  const outcomes2 = await publishReadyTickets(client, adapter2, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => true,
  });
  assert.equal(outcomes2[0].result, 'already_opened', 'pr_updated present so no re-push');
  assert.equal(adapter2.pushed.length, 0, 'does not redo the same push');
  const updated2 = await client.callTool('read_board', { kind: 'pr_updated' });
  assert.equal(
    updated2.messages.filter((m: any) => m.ref_ticket_id === ticketId).length,
    1,
    'pr_updated stays at 1 (does not increase)',
  );
});

test('publishReadyTickets: if the follow-up push fails, do not leave pr_updated (stays waiting-for-update)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-prupdated-fail-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  await publishOne(client, repoPath);
  await client.callTool('post_board', {
    agent_id: 'system',
    kind: 'ticket_ready',
    ref_ticket_id: ticketId,
    body: `ticket ${ticketId}: re-emit`,
  });

  // an adapter whose follow-up push fails. no pr_updated remains and it becomes failed.
  const adapter = makeFakeAdapter({ pushThrows: new Error('push rejected') });
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => true,
  });
  assert.equal(outcomes[0].result, 'failed', 'a push failure is failed');

  const updated = await client.callTool('read_board', { kind: 'pr_updated' });
  assert.equal(
    updated.messages.filter((m: any) => m.ref_ticket_id === ticketId).length,
    0,
    'on a push failure do not leave pr_updated',
  );
  // stays waiting-for-update (re-evaluated next time).
  const status = await client.callTool('publisher_status', {});
  assert.ok(
    status.pending_update_tickets.some((p: any) => p.ref_ticket_id === ticketId),
    'on a push failure it stays waiting-for-update',
  );
});

test('publishReadyTickets: if the integration branch is not local the follow-up push cannot run, so no pr_updated is left', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-prupdated-notlocal-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  await publishOne(client, repoPath);
  await client.callTool('post_board', {
    agent_id: 'system',
    kind: 'ticket_ready',
    ref_ticket_id: ticketId,
    body: `ticket ${ticketId}: re-emit`,
  });

  const adapter = makeFakeAdapter();
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => false,
  });
  assert.equal(outcomes[0].result, 'skipped');
  assert.equal((outcomes[0] as any).reason, 'branch_not_local');
  const updated = await client.callTool('read_board', { kind: 'pr_updated' });
  assert.equal(
    updated.messages.filter((m: any) => m.ref_ticket_id === ticketId).length,
    0,
    'not local so no push, hence no pr_updated left',
  );
});

test('publishReadyTickets: an already-pr_merged ticket does not enter the update path even if ticket_ready is later (no pr_updated left)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-merged-noupdate-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initRepo(workdir);
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const cdb = openDb({ path: dbPath, hostId: 'host-test' });
  const { ticketId } = seedReadyTicket(cdb, repoPath);
  cdb.close();

  const client = new LockageClient({ serverEntry: SERVER_ENTRY, dbPath, toolsets: ['publisher'] });
  await client.connect();
  t.after(() => client.close());

  await publishOne(client, repoPath);
  // make it merged (stack the pr_merged reconcile would add directly).
  await client.callTool('post_board', {
    agent_id: 'publisher',
    kind: 'pr_merged',
    ref_ticket_id: ticketId,
    body: 'PR merged',
  });
  // even if ticket_ready is stacked after merge (seq later), a follow-up push is impossible.
  await client.callTool('post_board', {
    agent_id: 'system',
    kind: 'ticket_ready',
    ref_ticket_id: ticketId,
    body: `ticket ${ticketId}: re-emit`,
  });

  const adapter = makeFakeAdapter();
  const outcomes = await publishReadyTickets(client, adapter, {
    repoPath,
    base: 'main',
    agentId: 'publisher',
    localBranchExists: () => true,
  });
  assert.equal(outcomes[0].result, 'already_opened', 'already merged does not enter the update path');
  assert.equal(adapter.pushed.length, 0, 'does not follow-up push');
  const updated = await client.callTool('read_board', { kind: 'pr_updated' });
  assert.equal(
    updated.messages.filter((m: any) => m.ref_ticket_id === ticketId).length,
    0,
    'already merged leaves no pr_updated',
  );
});
