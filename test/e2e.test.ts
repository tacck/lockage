import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * 2-client end-to-end automatic verification.
 *
 * Reproduces the production configuration itself: start 2 of dist/index.js as **separate-process MCP
 * servers** (agents A / B) and point both at the **same LOCKAGE_DB file**. This verifies the heart of the
 * design "multiple clients share one coordination space (DB)" with a real stdio transport + a real file DB,
 * not InMemory.
 *
 * Scenario (corresponds to the README's e2e 8 steps):
 *   1. A creates a task
 *   2. B can see it (= confirm DB sharing)
 *   3. A's claim succeeds
 *   4. B's claim is conflict (= physically reject a double claim via CAS)
 *   5. A assigns a worktree (= physical isolation, real git)
 *   6. A publishes dirty
 *   7. B publishes the same file as dirty → overlap warning (= warn, never block)
 *   8. while B is in wait_for_unblock, A posts to the board → B returns with woke_by:"board" (= A2A wake)
 *
 * Premise: `npm run build` has been done (it starts dist/index.js).
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = join(PROJECT_ROOT, 'dist', 'index.js');

/** The scratch area (auto-reclaimed on session end). Falls back to os.tmpdir if absent. */
const SCRATCH = process.env.KIROCREW_SCRATCH ?? tmpdir();

interface Agent {
  client: Client;
  transport: StdioClientTransport;
}

/** Start dist/index.js as a separate-process stdio server and connect an MCP client. */
async function connectAgent(name: string, dbPath: string): Promise<Agent> {
  const transport = new StdioClientTransport({
    command: process.execPath, // the current node absolute path
    args: [SERVER_ENTRY],
    env: { ...process.env, LOCKAGE_DB: dbPath },
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name, version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/** Parse a tool result (the JSON of the text content). */
function parse(result: any): any {
  assert.ok(!result.isError, `tool error: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

/** Initialize a real git repository and return the repo path. */
function initGitRepo(root: string): string {
  const repo = join(root, 'myrepo');
  mkdirSync(repo, { recursive: true });
  const sh = (cmd: string) => {
    execSync(cmd, { cwd: repo, stdio: 'pipe' });
  };
  sh('git init -q');
  sh('git config user.email e2e@test.local');
  sh('git config user.name e2e');
  sh('git commit -q --allow-empty -m init');
  return repo;
}

test('2-client e2e: verify claim conflict / overlap warning / A2A wake in real processes', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-e2e-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initGitRepo(workdir);

  const a = await connectAgent('agent-A', dbPath);
  const b = await connectAgent('agent-B', dbPath);

  t.after(async () => {
    await a.client.close().catch(() => { });
    await b.client.close().catch(() => { });
    rmSync(workdir, { recursive: true, force: true });
  });

  // ── 1. A creates a task ──────────────────────────────────────────
  const created = parse(
    await a.client.callTool({
      name: 'create_task',
      arguments: { repo: 'myrepo', title: 'login fix' },
    }),
  );
  assert.equal(created.status, 'open');
  assert.equal(created.version, 0);
  const taskId = created.id;

  // ── 2. B can see the same task (= DB sharing across a separate process and client) ──
  const seenByB = parse(
    await b.client.callTool({ name: 'list_tasks', arguments: { status: 'open', repo: 'myrepo' } }),
  );
  assert.equal(seenByB.length, 1, 'B cannot see the task A created (DB sharing broken)');
  assert.equal(seenByB[0].id, taskId);

  // ── 3. A's claim succeeds ────────────────────────────────────────
  const claimA = parse(
    await a.client.callTool({
      name: 'claim_task',
      arguments: { task_id: taskId, agent_id: 'A', expected_version: 0 },
    }),
  );
  assert.equal(claimA.ok, true);
  assert.equal(claimA.task.assignee, 'A');

  // ── 4. B's claim is conflict (= physically reject a double claim via CAS) ──
  const claimB = parse(
    await b.client.callTool({
      name: 'claim_task',
      arguments: { task_id: taskId, agent_id: 'B', expected_version: 0 },
    }),
  );
  assert.equal(claimB.ok, false, 'B\'s double claim is not rejected (CAS broken)');
  assert.equal(claimB.reason, 'conflict');
  assert.equal(claimB.current.assignee, 'A');

  // ── 5. A assigns a worktree (= physical isolation, a real git worktree) ────────
  const wt = parse(
    await a.client.callTool({
      name: 'assign_worktree',
      arguments: { agent_id: 'A', task_id: taskId, repo_path: repoPath },
    }),
  );
  assert.ok(wt.worktree_path, 'the worktree path is not returned');
  assert.match(wt.branch, /^lockage\/A\//, 'not a deterministic branch name');

  // ── 6. A publishes dirty ────────────────────────────────────────
  const dirtyA = parse(
    await a.client.callTool({
      name: 'publish_dirty',
      arguments: { agent_id: 'A', worktree_path: wt.worktree_path, files: ['src/login.ts'] },
    }),
  );
  assert.equal(dirtyA.overlaps.dirty.length, 0);
  assert.equal(dirtyA.overlaps.claims.length, 0);

  // ── 7. B publishes the same file as dirty → overlap warning (warn, never block) ──
  const dirtyB = parse(
    await b.client.callTool({
      name: 'publish_dirty',
      arguments: {
        agent_id: 'B',
        worktree_path: '/tmp/b-wt', // B's worktree is unused in this verification (dirty publish only)
        files: ['src/login.ts'],
      },
    }),
  );
  // B's publish is established while the dirty overlap with A is warned (not blocked)
  assert.equal(dirtyB.ok, true, 'the dirty publish was blocked (warn-never-block violation)');
  assert.equal(dirtyB.overlaps.dirty.length, 1, 'the overlap of the same file is not detected');
  assert.equal(dirtyB.overlaps.dirty[0].agent_id, 'A');
  assert.ok(
    dirtyB.overlaps.dirty[0].files.includes('src/login.ts'),
    'the conflicting file is not included in overlap',
  );
  // the overlap peer (A) is enumerated as a wake target
  assert.ok(dirtyB.wake_targets.includes('A'), 'the overlap peer is not in the wake targets');

  // ── 8. while B is in wait_for_unblock, A posts to the board → B returns via board (A2A wake) ──
  //    fire the long-poll first and have A post to the board a bit later.
  const waitB = b.client.callTool({
    name: 'wait_for_unblock',
    arguments: { agent_id: 'B', timeout_sec: 10 },
  });
  // wait for the long-poll to start its internal polling before posting (even if racing it is picked up before timeout)
  await new Promise((r) => setTimeout(r, 300));
  const posted = parse(
    await a.client.callTool({
      name: 'post_board',
      arguments: { agent_id: 'A', body: 'login fix done, please review', kind: 'note' },
    }),
  );
  assert.ok(posted.message_id, 'the board post failed');

  const woke = parse(await waitB);
  assert.equal(woke.woke_by, 'board', `B did not return via board (woke_by=${woke.woke_by})`);
  assert.ok(Array.isArray(woke.payload) && woke.payload.length >= 1, 'the board payload is empty');
  assert.equal(woke.payload[0].body, 'login fix done, please review');
});

test('2-client e2e: a dependent task\'s done makes wait_for_unblock return via task_ready', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-e2e-dep-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initGitRepo(workdir);

  const a = await connectAgent('agent-A', dbPath);
  const b = await connectAgent('agent-B', dbPath);

  t.after(async () => {
    await a.client.close().catch(() => { });
    await b.client.close().catch(() => { });
    rmSync(workdir, { recursive: true, force: true });
  });

  // A creates task1 (the dependency source), B creates task2 (blocked by task1)
  const t1 = parse(
    await a.client.callTool({
      name: 'create_task',
      arguments: { repo: 'myrepo', title: 'foundation task (finishes first)' },
    }),
  );
  const t2 = parse(
    await b.client.callTool({
      name: 'create_task',
      arguments: { repo: 'myrepo', title: 'dependent task (waiting on t1)' },
    }),
  );

  // task_edges(blocks): t1 → t2 (t1 blocks t2). draw it via the add_dependency tool.
  const dep = parse(
    await a.client.callTool({
      name: 'add_dependency',
      arguments: { from_task: t1.id, to_task: t2.id },
    }),
  );
  assert.equal(dep.ok, true, 'add_dependency failed');

  // A claims t1, changes and commits in a dedicated worktree
  await a.client.callTool({
    name: 'claim_task',
    arguments: { task_id: t1.id, agent_id: 'A', expected_version: 0 },
  });
  const wt = parse(
    await a.client.callTool({
      name: 'assign_worktree',
      arguments: { agent_id: 'A', task_id: t1.id, repo_path: repoPath },
    }),
  );
  // commit inside the worktree (create the merge target)
  execSync('git commit -q --allow-empty -m "t1 work"', { cwd: wt.worktree_path, stdio: 'pipe' });

  // B waits for t2's unblock. since t1 is not done yet it does not become task_ready and waits.
  const waitB = b.client.callTool({
    name: 'wait_for_unblock',
    arguments: { agent_id: 'B', task_id: t2.id, timeout_sec: 10 },
  });
  await new Promise((r) => setTimeout(r, 300));

  // A task_dones t1 → t1 becomes done and t2 becomes ready
  const done = parse(
    await a.client.callTool({
      name: 'task_done',
      arguments: {
        agent_id: 'A',
        worktree_path: wt.worktree_path,
        branch: wt.branch,
        repo: repoPath,
        task_id: t1.id,
      },
    }),
  );
  assert.equal(done.ok, true, `task_done failed (reason=${done.reason})`);
  assert.equal(done.merged.length, 1, 't1 was not merged');

  // B returns via task_ready (unblocked by dependency t1's done)
  const woke = parse(await waitB);
  assert.equal(
    woke.woke_by,
    'task_ready',
    `B did not return via unblock (woke_by=${woke.woke_by})`,
  );
});


test('2-client e2e: a blocked task\'s handoff wakes to_agent via a board notification (point B)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-e2e-handoff-'));
  const dbPath = join(workdir, 'lockage.sqlite');
  const repoPath = initGitRepo(workdir);

  const a = await connectAgent('agent-A', dbPath);
  const b = await connectAgent('agent-B', dbPath);

  t.after(async () => {
    await a.client.close().catch(() => { });
    await b.client.close().catch(() => { });
    rmSync(workdir, { recursive: true, force: true });
  });

  // A creates, claims, and assigns a worktree for a task, then starts
  const task = parse(
    await a.client.callTool({
      name: 'create_task',
      arguments: { repo: 'myrepo', title: 'cross-cutting feature (front/back)' },
    }),
  );
  await a.client.callTool({
    name: 'claim_task',
    arguments: { task_id: task.id, agent_id: 'A', expected_version: 0 },
  });
  await a.client.callTool({
    name: 'assign_worktree',
    arguments: { agent_id: 'A', task_id: task.id, repo_path: repoPath },
  });

  // A gets stuck: per the convention, leave a question first, then block
  await a.client.callTool({
    name: 'post_board',
    arguments: {
      agent_id: 'A',
      kind: 'question',
      to_agent: 'orchestrator',
      ref_task_id: task.id,
      body: 'insufficient permission to touch the back API key. need a design decision',
    },
  });
  const blocked = parse(
    await a.client.callTool({
      name: 'block_task',
      arguments: { task_id: task.id, agent_id: 'A' },
    }),
  );
  assert.equal(blocked.ok, true, 'block_task failed');

  // B enters wait_for_unblock (waits for the handoff notification via the board path)
  const waitB = b.client.callTool({
    name: 'wait_for_unblock',
    arguments: { agent_id: 'B', timeout_sec: 10 },
  });
  await new Promise((r) => setTimeout(r, 300));

  // a human hands off A → B via the orchestrator (explicitly naming a different worker)
  const ho = parse(
    await a.client.callTool({
      name: 'handoff_task',
      arguments: { task_id: task.id, from_agent: 'A', to_agent: 'B' },
    }),
  );
  assert.equal(ho.ok, true, `handoff failed (reason=${ho.reason})`);

  // B returns via the board path and receives the handoff notification (= the actual behavior of point B)
  const woke = parse(await waitB);
  assert.equal(woke.woke_by, 'board', `B did not return via handoff (woke_by=${woke.woke_by})`);
  const handoffMsg = (woke.payload as any[]).find((m) => m.kind === 'handoff');
  assert.ok(handoffMsg, 'the handoff board notification is not in the payload');
  assert.equal(handoffMsg.to_agent, 'B', 'the handoff notification\'s recipient is not B');
  assert.equal(handoffMsg.ref_task_id, task.id, 'the handoff notification\'s ref_task_id does not point to the task');

  // the arriving B can trace the predecessor's question (the reason it got stuck) via ref_task_id
  const q = parse(
    await b.client.callTool({
      name: 'read_board',
      arguments: { kind: 'question', to_agent: 'orchestrator' },
    }),
  );
  const myQ = q.messages.find((m: any) => m.ref_task_id === task.id);
  assert.ok(myQ, 'B cannot trace the predecessor\'s question');
  assert.match(myQ.body, /insufficient permission/, 'the question body cannot be read');

  // the handoff result: the task is in_progress held by B, and the worktree moved to B too
  const mine = parse(
    await b.client.callTool({
      name: 'list_tasks',
      arguments: { assignee: 'B', status: 'in_progress' },
    }),
  );
  assert.ok(
    mine.find((x: any) => x.id === task.id),
    'after handoff the task is not B\'s in_progress',
  );
});

test('e2e: LOCKAGE_TOOLSETS at startup changes the exposed tools, and an unknown toolset name does not start (#65)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-e2e-toolsets-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const dbPath = join(workdir, 'lockage.sqlite');

  const listTools = async (toolsets: string): Promise<string[]> => {
    const client = new Client({ name: 'e2e-toolsets', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_ENTRY],
        env: { ...(process.env as Record<string, string>), LOCKAGE_DB: dbPath, LOCKAGE_TOOLSETS: toolsets },
      }),
    );
    try {
      return (await client.listTools()).tools.map((x) => x.name);
    } finally {
      await client.close();
    }
  };
  const core = await listTools('');
  assert.ok(core.includes('list_tasks'));
  assert.ok(!core.includes('close_ticket_on_merge'), 'by default do not expose the publisher set');
  assert.ok(!core.includes('process_merge_queue'), 'by default do not expose the maintenance set');
  assert.ok((await listTools('publisher')).includes('close_ticket_on_merge'));

  const bad = spawnSync(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, LOCKAGE_DB: dbPath, LOCKAGE_TOOLSETS: 'publsher' },
    input: '',
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown toolset: publsher/);
});
