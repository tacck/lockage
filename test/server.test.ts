import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb } from '../src/db/index.js';
import { buildServer, OPTIONAL_TOOLSETS, parseToolsets, type OptionalToolset } from '../src/index.js';

/**
 * Connectivity test for the MCP server itself.
 * Connect client and server directly with InMemoryTransport and verify tools/list and the round trip of
 * representative tools.
 * (worktree/merge paths that involve real git operations are already verified in the lockage/* tests, so
 *  here we focus on "the tools are registered, callable over JSON-RPC, and the CAS claim works on the round trip".)
 */

async function connect(toolsets: OptionalToolset[] = []) {
  const cdb = openDb({ path: ':memory:', hostId: 'test-host' });
  const server = buildServer(cdb, { toolsets });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, cdb };
}

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

/** Tools registered when no toolset is specified (core). */
const CORE_TOOLS = [
  // 2.1 tasks
  'create_task', 'claim_task', 'release_task', 'task_done', 'heartbeat',
  'add_dependency', 'list_tasks', 'block_task', 'resume_task', 'handoff_task',
  // 2.2 tickets
  'open_ticket', 'update_ticket', 'list_tickets', 'read_ticket', 'link_task_to_ticket',
  // 2.3 file coordination
  'claim_files', 'release_claim', 'list_claims', 'publish_dirty', 'list_dirty',
  // 2.5 board
  'post_board', 'read_board', 'resolve_question',
  // 2.6 worktree
  'assign_worktree', 'release_worktree', 'list_worktrees',
  // publisher observation
  'publisher_status',
  // 2.7 waiting
  'wait_for_unblock',
];

async function listedTools(toolsets: OptionalToolset[]): Promise<string[]> {
  const { client, cdb } = await connect(toolsets);
  const { tools } = await client.listTools();
  cdb.close();
  return tools.map((t) => t.name).sort();
}

test('tools/list: when no toolset is specified, only the core tools are registered', async () => {
  assert.deepEqual(await listedTools([]), [...CORE_TOOLS].sort());
});

test('tools/list: enabling a toolset adds that toolset\'s tools to core', async () => {
  for (const set of Object.keys(OPTIONAL_TOOLSETS) as OptionalToolset[]) {
    assert.deepEqual(
      await listedTools([set]),
      [...CORE_TOOLS, ...OPTIONAL_TOOLSETS[set]].sort(),
      `toolset ${set}`,
    );
  }
  assert.deepEqual(
    await listedTools(['publisher', 'maintenance']),
    [...CORE_TOOLS, ...OPTIONAL_TOOLSETS.publisher, ...OPTIONAL_TOOLSETS.maintenance].sort(),
  );
});

test('parseToolsets: ignores empty/core, reads comma-separated toolsets, and stops on an unknown name', () => {
  assert.deepEqual([...parseToolsets(undefined)], []);
  assert.deepEqual([...parseToolsets(' core , ')], []);
  assert.deepEqual([...parseToolsets('core,publisher, maintenance')].sort(), ['maintenance', 'publisher']);
  assert.throws(() => parseToolsets('publsher'), /unknown toolset: publsher/);
});

test('every tool has a description and an inputSchema', async () => {
  const { client, cdb } = await connect(Object.keys(OPTIONAL_TOOLSETS) as OptionalToolset[]);
  const { tools } = await client.listTools();
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 0, `${t.name} has no description`);
    assert.ok(t.inputSchema, `${t.name} has no inputSchema`);
  }
  cdb.close();
});

test('create_task → list_tasks(status:open) → claim_task round-trips over JSON-RPC', async () => {
  const { client, cdb } = await connect();

  const created = parse(
    await client.callTool({
      name: 'create_task',
      arguments: { repo: 'r', title: 'task A' },
    }),
  );
  assert.equal(created.status, 'open');
  assert.equal(created.version, 0);

  const openList = parse(
    await client.callTool({ name: 'list_tasks', arguments: { status: 'open' } }),
  );
  assert.equal(openList.length, 1);
  assert.equal(openList[0].id, created.id);

  // claim succeeds with the correct version
  const claim = parse(
    await client.callTool({
      name: 'claim_task',
      arguments: { task_id: created.id, agent_id: 'agentA', expected_version: 0 },
    }),
  );
  assert.equal(claim.ok, true);
  assert.equal(claim.task.assignee, 'agentA');
  assert.equal(claim.task.status, 'in_progress');

  cdb.close();
});

test('list_tasks(status:blocked) returns orphan-decision info, and does not add it when status is unspecified', async () => {
  const { client, cdb } = await connect();
  const created = parse(
    await client.callTool({ name: 'create_task', arguments: { repo: 'r', title: 'stuck' } }),
  );
  parse(
    await client.callTool({
      name: 'claim_task',
      arguments: { task_id: created.id, agent_id: 'agentA', expected_version: 0 },
    }),
  );
  parse(
    await client.callTool({
      name: 'post_board',
      arguments: { agent_id: 'agentA', kind: 'question', body: 'no permission', ref_task_id: created.id },
    }),
  );
  parse(
    await client.callTool({ name: 'block_task', arguments: { task_id: created.id, agent_id: 'agentA' } }),
  );

  const blocked = parse(
    await client.callTool({ name: 'list_tasks', arguments: { status: 'blocked', repo: 'r' } }),
  );
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].id, created.id);
  assert.equal(typeof blocked[0].blocked_age_sec, 'number');
  assert.ok('agent_silent_sec' in blocked[0]);
  assert.equal(blocked[0].last_question, 'no permission');

  const all = parse(await client.callTool({ name: 'list_tasks', arguments: {} }));
  assert.equal('blocked_age_sec' in all[0], false, 'does not add it when status is unspecified');
  cdb.close();
});

test('list_worktrees(stale:true) returns only active assignments tied to done tasks', async () => {
  const { client, cdb } = await connect();
  const done = parse(
    await client.callTool({ name: 'create_task', arguments: { repo: 'r', title: 'finished' } }),
  );
  const working = parse(
    await client.callTool({ name: 'create_task', arguments: { repo: 'r', title: 'in progress' } }),
  );
  cdb.db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(done.id);
  const insert = cdb.db.prepare(
    `INSERT INTO worktree_assignments (id, agent_id, worktree_path, branch, task_id, created_at, host_id)
     VALUES (?, 'agentA', ?, ?, ?, 1, 'test-host')`,
  );
  insert.run('w1', '/wt/done', 'lockage/agentA/done', done.id);
  insert.run('w2', '/wt/working', 'lockage/agentA/working', working.id);

  const active = parse(await client.callTool({ name: 'list_worktrees', arguments: {} }));
  assert.equal(active.length, 2);

  const stale = parse(
    await client.callTool({ name: 'list_worktrees', arguments: { stale: true, agent_id: 'agentA' } }),
  );
  assert.deepEqual(
    stale.map((w: { worktree_path: string; task_status: string }) => [w.worktree_path, w.task_status]),
    [['/wt/done', 'done']],
  );
  cdb.close();
});

test('list_worktrees\' ticket_id narrows to assignments under that ticket regardless of stale', async () => {
  const { client, cdb } = await connect();
  const ticketA = parse(await client.callTool({ name: 'open_ticket', arguments: { title: 'A' } }));
  const ticketB = parse(await client.callTool({ name: 'open_ticket', arguments: { title: 'B' } }));
  const create = async (title: string, ticketId: string) =>
    parse(
      await client.callTool({ name: 'create_task', arguments: { repo: 'r', title, ticket_id: ticketId } }),
    );
  const a1 = await create('a1', ticketA.id);
  const a2 = await create('a2', ticketA.id);
  const b1 = await create('b1', ticketB.id);
  cdb.db.prepare(`UPDATE tasks SET status = 'done' WHERE id IN (?, ?)`).run(a1.id, b1.id);
  const insert = cdb.db.prepare(
    `INSERT INTO worktree_assignments (id, agent_id, worktree_path, branch, task_id, created_at, host_id)
     VALUES (?, 'agentA', ?, ?, ?, ?, 'test-host')`,
  );
  insert.run('w1', '/wt/a1', 'lockage/agentA/a1', a1.id, 1);
  insert.run('w2', '/wt/a2', 'lockage/agentA/a2', a2.id, 2);
  insert.run('w3', '/wt/b1', 'lockage/agentA/b1', b1.id, 3);

  const paths = async (args: Record<string, unknown>) =>
    parse(await client.callTool({ name: 'list_worktrees', arguments: args })).map(
      (w: { worktree_path: string }) => w.worktree_path,
    );
  assert.deepEqual(await paths({ ticket_id: ticketA.id }), ['/wt/a1', '/wt/a2']);
  assert.deepEqual(await paths({ ticket_id: ticketA.id, stale: true }), ['/wt/a1']);
  assert.deepEqual(await paths({ ticket_id: 'no-such-ticket' }), [], 'returns nothing for an unknown ticket');
  cdb.close();
});

test('a double claim makes the later one conflict (CAS works over JSON-RPC too)', async () => {
  const { client, cdb } = await connect();
  const created = parse(
    await client.callTool({
      name: 'create_task',
      arguments: { repo: 'r', title: 'task B' },
    }),
  );
  const first = parse(
    await client.callTool({
      name: 'claim_task',
      arguments: { task_id: created.id, agent_id: 'A', expected_version: 0 },
    }),
  );
  assert.equal(first.ok, true);
  // B claims with the stale version 0 → conflict
  const second = parse(
    await client.callTool({
      name: 'claim_task',
      arguments: { task_id: created.id, agent_id: 'B', expected_version: 0 },
    }),
  );
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'conflict');
  assert.equal(second.current.assignee, 'A');
  cdb.close();
});

test('claim_files warns about overlap but does not block (advisory over JSON-RPC too)', async () => {
  const { client, cdb } = await connect();
  const a = parse(
    await client.callTool({
      name: 'claim_files',
      arguments: { agent_id: 'A', globs: ['src/**'] },
    }),
  );
  assert.ok(a.claim_id);
  assert.equal(a.overlaps.length, 0);

  const b = parse(
    await client.callTool({
      name: 'claim_files',
      arguments: { agent_id: 'B', globs: ['src/db/**'] },
    }),
  );
  // B's claim is established while the overlap with A is warned (not blocked)
  assert.ok(b.claim_id);
  assert.equal(b.overlaps.length, 1);
  assert.equal(b.overlaps[0].agent_id, 'A');
  cdb.close();
});

test('post_board → read_board can fetch deltas with the since cursor', async () => {
  const { client, cdb } = await connect();
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'A', body: 'hello', kind: 'note' },
  });
  const board = parse(
    await client.callTool({ name: 'read_board', arguments: { since: 0 } }),
  );
  assert.equal(board.messages.length, 1);
  assert.equal(board.messages[0].body, 'hello');
  // aligning since to the cursor head yields a zero delta
  const empty = parse(
    await client.callTool({
      name: 'read_board',
      arguments: { since: board.messages[0].seq },
    }),
  );
  assert.equal(empty.messages.length, 0);
  cdb.close();
});

test('resolve_question → read_board(unresolved_only) works over JSON-RPC', async () => {
  const { client, cdb } = await connect();
  // post one question.
  const posted = parse(
    await client.callTool({
      name: 'post_board',
      arguments: { agent_id: 'A', body: 'why I got stuck', kind: 'question' },
    }),
  );
  // before resolving, it appears with unresolved_only:true.
  const before = parse(
    await client.callTool({ name: 'read_board', arguments: { unresolved_only: true } }),
  );
  assert.equal(before.messages.length, 1);
  // resolve it.
  const resolved = parse(
    await client.callTool({
      name: 'resolve_question',
      arguments: { agent_id: 'A', message_id: posted.message_id },
    }),
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.already_resolved, false);
  // after resolving, it disappears from unresolved_only:true.
  const after = parse(
    await client.callTool({ name: 'read_board', arguments: { unresolved_only: true } }),
  );
  assert.equal(after.messages.length, 0);
  // idempotent: the second time is already_resolved:true.
  const again = parse(
    await client.callTool({
      name: 'resolve_question',
      arguments: { agent_id: 'A', message_id: posted.message_id },
    }),
  );
  assert.equal(again.ok, true);
  assert.equal(again.already_resolved, true);
  cdb.close();
});

test('heartbeat returns unread_count / unread_preview and read_board(unread_only) reads them over JSON-RPC', async () => {
  const { client, cdb } = await connect();
  // A appears first, so only later broadcasts count for it
  await client.callTool({ name: 'heartbeat', arguments: { agent_id: 'A' } });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'B', to_agent: 'A', kind: 'question', body: 'can you check?' },
  });
  await client.callTool({ name: 'post_board', arguments: { agent_id: 'B', body: 'to everyone' } });
  await client.callTool({ name: 'post_board', arguments: { agent_id: 'A', body: 'my own' } });

  const hb = parse(await client.callTool({ name: 'heartbeat', arguments: { agent_id: 'A' } }));
  assert.equal(hb.unread_count, 2);
  assert.deepEqual(
    hb.unread_preview.map((m: any) => [m.kind, m.body_head]),
    [
      ['question', 'can you check?'],
      ['note', 'to everyone'],
    ],
  );
  // heartbeat does not mark read
  const hb2 = parse(await client.callTool({ name: 'heartbeat', arguments: { agent_id: 'A' } }));
  assert.equal(hb2.unread_count, 2);

  const unread = parse(
    await client.callTool({ name: 'read_board', arguments: { agent_id: 'A', unread_only: true } }),
  );
  assert.deepEqual(
    unread.messages.map((m: any) => m.body),
    ['can you check?', 'to everyone'],
  );
  const hb3 = parse(await client.callTool({ name: 'heartbeat', arguments: { agent_id: 'A' } }));
  assert.equal(hb3.unread_count, 0);
  assert.deepEqual(hb3.unread_preview, []);
  cdb.close();
});

test('an agent whose first call is post_board, task_done, release_claim or release_worktree still gets later broadcasts over JSON-RPC', async () => {
  const { client, cdb } = await connect();
  await client.callTool({ name: 'post_board', arguments: { agent_id: 'B', body: 'old broadcast' } });
  // each agent's first call carrying its own agent_id (the last three fail, but still identify it)
  await client.callTool({ name: 'post_board', arguments: { agent_id: 'A', body: 'A joined' } });
  await client.callTool({
    name: 'task_done',
    arguments: { agent_id: 'T', worktree_path: '/nowhere', branch: 'x', repo: '/nowhere' },
  });
  await client.callTool({ name: 'release_claim', arguments: { agent_id: 'C', claim_id: 'none' } });
  await client.callTool({
    name: 'release_worktree',
    arguments: { agent_id: 'W', worktree_path: '/nowhere', repo_path: '/nowhere' },
  });
  // reading someone else's posts does not start their tracking
  await client.callTool({ name: 'read_board', arguments: { to_agent: 'R' } });
  await client.callTool({ name: 'post_board', arguments: { agent_id: 'B', body: 'after they appeared' } });

  for (const agent of ['A', 'T', 'C', 'W']) {
    const hb = parse(await client.callTool({ name: 'heartbeat', arguments: { agent_id: agent } }));
    assert.equal(hb.unread_count, 1, agent);
    assert.equal(hb.unread_preview[0]?.body_head, 'after they appeared', agent);
  }
  const r = cdb.db.prepare(`SELECT 1 FROM board_cursors WHERE agent_id = 'R'`).get();
  assert.equal(r, undefined, 'read_board(to_agent) created a read position for R');
  cdb.close();
});

test('read_board(unread_only) rejects a missing agent_id and other filters', async () => {
  const { client, cdb } = await connect();
  const noAgent = await client.callTool({ name: 'read_board', arguments: { unread_only: true } });
  assert.equal(noAgent.isError, true);
  const withKind = await client.callTool({
    name: 'read_board',
    arguments: { agent_id: 'A', unread_only: true, kind: 'question' },
  });
  assert.equal(withKind.isError, true);
  const zeroLimit = await client.callTool({
    name: 'read_board',
    arguments: { agent_id: 'A', unread_only: true, limit: 0 },
  });
  assert.equal(zeroLimit.isError, true, 'a limit below 1 was accepted');
  cdb.close();
});

test('publisher_status: with only a ticket_ready it appears in pending, and pr_opened clears it', async () => {
  const { client, cdb } = await connect();

  // open one ticket to observe (used as ref_ticket_id).
  const ticket = parse(
    await client.callTool({
      name: 'open_ticket',
      arguments: { title: 'ticket waiting to become a PR' },
    }),
  );

  // post one ticket_ready (= trace that it became ready to be turned into a PR).
  await client.callTool({
    name: 'post_board',
    arguments: {
      agent_id: 'server',
      body: 'all tasks under the ticket are done',
      kind: 'ticket_ready',
      ref_ticket_id: ticket.id,
    },
  });

  // publisher unprocessed: pending_count=1 / includes this ticket / no pr_opened trace.
  const before = parse(
    await client.callTool({ name: 'publisher_status', arguments: {} }),
  );
  assert.equal(before.pending_count, 1);
  assert.ok(
    before.pending_tickets.some((p: any) => p.ref_ticket_id === ticket.id),
    'this ticket is not included in pending_tickets',
  );
  assert.equal(before.last_pr_opened_at, null);

  // stack the trace that the publisher opened a PR (= cleared).
  await client.callTool({
    name: 'post_board',
    arguments: {
      agent_id: 'publisher',
      body: 'opened a PR',
      kind: 'pr_opened',
      ref_ticket_id: ticket.id,
    },
  });

  // after clearing: pending_count=0 / last_pr_opened_at is non-null.
  const after = parse(
    await client.callTool({ name: 'publisher_status', arguments: {} }),
  );
  assert.equal(after.pending_count, 0);
  assert.ok(
    !after.pending_tickets.some((p: any) => p.ref_ticket_id === ticket.id),
    'still in pending even after pr_opened',
  );
  assert.notEqual(after.last_pr_opened_at, null);

  cdb.close();
});

test('publisher_status: the ticket\'s integration_branch is bundled into pending_tickets', async () => {
  const { client, cdb } = await connect();

  const ticket = parse(
    await client.callTool({
      name: 'open_ticket',
      arguments: { title: 'ticket with an integration branch' },
    }),
  );
  // the integration branch is normally a system column reserved at merge-aggregation time. Here we set it directly to verify observability.
  cdb.db
    .prepare('UPDATE tickets SET integration_branch = ? WHERE id = ?')
    .run('lockage/ticket/abc123', ticket.id);

  await client.callTool({
    name: 'post_board',
    arguments: {
      agent_id: 'server',
      body: 'all tasks under the ticket are done',
      kind: 'ticket_ready',
      ref_ticket_id: ticket.id,
    },
  });

  const status = parse(
    await client.callTool({ name: 'publisher_status', arguments: {} }),
  );
  const pending = status.pending_tickets.find((p: any) => p.ref_ticket_id === ticket.id);
  assert.ok(pending, 'this ticket is not included in pending_tickets');
  assert.equal(pending.integration_branch, 'lockage/ticket/abc123');

  cdb.close();
});

test('publisher_status: a ticket_ready stacked after pr_opened is visualized as waiting-for-update and does not appear in pure pending', async () => {
  const { client, cdb } = await connect();

  const ticket = parse(
    await client.callTool({
      name: 'open_ticket',
      arguments: { title: 'ticket waiting for a follow-up push' },
    }),
  );

  // stack ticket_ready → pr_opened → an even newer ticket_ready onto the board (seq increases monotonically in post order).
  await client.callTool({
    name: 'post_board',
    arguments: {
      agent_id: 'server',
      body: 'all tasks under the ticket are done',
      kind: 'ticket_ready',
      ref_ticket_id: ticket.id,
    },
  });
  await client.callTool({
    name: 'post_board',
    arguments: {
      agent_id: 'publisher',
      body: 'opened a PR',
      kind: 'pr_opened',
      ref_ticket_id: ticket.id,
    },
  });
  // a ticket_ready re-armed and stacked after pr_opened (larger seq) (= waiting for a follow-up push).
  await client.callTool({
    name: 'post_board',
    arguments: {
      agent_id: 'server',
      body: 'a later-added B is done, re-emitting ticket_ready',
      kind: 'ticket_ready',
      ref_ticket_id: ticket.id,
    },
  });

  const status = parse(
    await client.callTool({ name: 'publisher_status', arguments: {} }),
  );
  // this ticket enters the waiting-for-update field.
  assert.equal(status.pending_update_count, 1);
  assert.ok(
    status.pending_update_tickets.some((p: any) => p.ref_ticket_id === ticket.id),
    'this ticket is not included in pending_update_tickets',
  );
  // it does not enter pure "waiting to become a PR" (= never pr_opened).
  assert.equal(status.pending_count, 0);
  assert.ok(
    !status.pending_tickets.some((p: any) => p.ref_ticket_id === ticket.id),
    'the waiting-for-update ticket is also double-counted in pure pending',
  );

  cdb.close();
});

test('publisher_status: a pr_opened and unmerged ticket appears in awaiting_merge and disappears after pr_merged', async () => {
  const { client, cdb } = await connect();

  const ticket = parse(
    await client.callTool({
      name: 'open_ticket',
      arguments: { title: 'ticket waiting for merge' },
    }),
  );

  // stack ticket_ready → pr_opened (a PR was created but not merged yet).
  await client.callTool({
    name: 'post_board',
    arguments: {
      agent_id: 'server',
      body: 'all tasks under the ticket are done',
      kind: 'ticket_ready',
      ref_ticket_id: ticket.id,
    },
  });
  await client.callTool({
    name: 'post_board',
    arguments: {
      agent_id: 'publisher',
      body: 'opened PR #42',
      kind: 'pr_opened',
      ref_ticket_id: ticket.id,
    },
  });

  // pr_opened ∧ ¬pr_merged = waiting for merge. does not appear in pure "waiting to become a PR" (pending) (already cleared).
  const before = parse(await client.callTool({ name: 'publisher_status', arguments: {} }));
  assert.equal(before.awaiting_merge_count, 1);
  assert.ok(
    before.awaiting_merge_tickets.some((p: any) => p.ref_ticket_id === ticket.id),
    'this ticket should be included in awaiting_merge_tickets',
  );
  assert.equal(before.pending_count, 0, 'cleared by pr_opened, so it does not appear in pending');

  // reconcile complete, stack pr_merged → disappears from awaiting_merge.
  await client.callTool({
    name: 'post_board',
    arguments: {
      agent_id: 'publisher',
      body: 'PR #42 merged',
      kind: 'pr_merged',
      ref_ticket_id: ticket.id,
    },
  });

  const after = parse(await client.callTool({ name: 'publisher_status', arguments: {} }));
  assert.equal(after.awaiting_merge_count, 0, 'disappears from awaiting_merge after pr_merged');
  assert.ok(
    !after.awaiting_merge_tickets.some((p: any) => p.ref_ticket_id === ticket.id),
    'should disappear from awaiting_merge after pr_merged',
  );
  assert.notEqual(after.last_pr_merged_at, null);

  cdb.close();
});

test('publisher_status: the same ticket appears in both pending_update and awaiting_merge at once (the axes are not exclusive)', async () => {
  const { client, cdb } = await connect();

  const ticket = parse(
    await client.callTool({
      name: 'open_ticket',
      arguments: { title: 'ticket waiting for both update and merge' },
    }),
  );

  // stack ticket_ready → pr_opened → an even newer ticket_ready (do not stack pr_merged).
  // this makes the ticket satisfy both "there is a ticket_ready after pr_opened (= pending_update)" and
  // "pr_opened present ∧ pr_merged absent (= awaiting_merge)" at once.
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'server', body: 'ready', kind: 'ticket_ready', ref_ticket_id: ticket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'publisher', body: 'opened PR #7', kind: 'pr_opened', ref_ticket_id: ticket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'server', body: 're-emit', kind: 'ticket_ready', ref_ticket_id: ticket.id },
  });

  const status = parse(await client.callTool({ name: 'publisher_status', arguments: {} }));

  // the same ticket appears on both axes (= not exclusive).
  assert.ok(
    status.pending_update_tickets.some((p: any) => p.ref_ticket_id === ticket.id),
    'should appear in pending_update',
  );
  assert.ok(
    status.awaiting_merge_tickets.some((p: any) => p.ref_ticket_id === ticket.id),
    'should appear in awaiting_merge',
  );
  // it does not appear in pure "waiting to become a PR" (never pr_opened) (= exclusive with pending).
  assert.ok(
    !status.pending_tickets.some((p: any) => p.ref_ticket_id === ticket.id),
    'does not appear in pending (because pr_opened is present)',
  );
  // a simple sum of counts does not equal the unique ticket count (this one ticket is double-counted across 2 axes).
  assert.equal(status.pending_count, 0);
  assert.equal(status.pending_update_count, 1);
  assert.equal(status.awaiting_merge_count, 1);

  cdb.close();
});

test('publisher_status: a successful follow-up push (pr_updated) removes it from waiting-for-update, and a newer ticket_ready re-adds it', async () => {
  const { client, cdb } = await connect();

  const ticket = parse(
    await client.callTool({
      name: 'open_ticket',
      arguments: { title: 'ticket that should disappear after a follow-up push' },
    }),
  );

  // stack ticket_ready → pr_opened → ticket_ready (re-emit) (= waiting for update at this point).
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'server', body: 'ready', kind: 'ticket_ready', ref_ticket_id: ticket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'publisher', body: 'opened a PR', kind: 'pr_opened', ref_ticket_id: ticket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'server', body: 're-emit', kind: 'ticket_ready', ref_ticket_id: ticket.id },
  });

  const beforeUpdate = parse(await client.callTool({ name: 'publisher_status', arguments: {} }));
  assert.equal(beforeUpdate.pending_update_count, 1, 'waiting for update before the follow-up push');
  assert.ok(beforeUpdate.pending_update_tickets.some((p: any) => p.ref_ticket_id === ticket.id));

  // follow-up push succeeded → the publisher leaves one pr_updated (seq after ticket_ready).
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'publisher', body: 'updated with a follow-up push', kind: 'pr_updated', ref_ticket_id: ticket.id },
  });

  const afterUpdate = parse(await client.callTool({ name: 'publisher_status', arguments: {} }));
  assert.equal(afterUpdate.pending_update_count, 0, 'pr_updated removes it from waiting-for-update');
  assert.ok(
    !afterUpdate.pending_update_tickets.some((p: any) => p.ref_ticket_id === ticket.id),
    'should disappear from pending_update after pr_updated',
  );

  // add a further task and a ticket_ready is stacked after pr_updated → re-enters waiting-for-update.
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'server', body: 're-emit again', kind: 'ticket_ready', ref_ticket_id: ticket.id },
  });
  const reArmed = parse(await client.callTool({ name: 'publisher_status', arguments: {} }));
  assert.equal(reArmed.pending_update_count, 1, 'a ticket_ready newer than pr_updated puts it back in waiting-for-update');
  assert.ok(reArmed.pending_update_tickets.some((p: any) => p.ref_ticket_id === ticket.id));

  cdb.close();
});

test('publisher_status: an already-pr_merged ticket does not appear in waiting-for-update even if ticket_ready is after pr_opened', async () => {
  const { client, cdb } = await connect();

  const ticket = parse(
    await client.callTool({
      name: 'open_ticket',
      arguments: { title: 'already-merged ticket (does not appear in waiting-for-update)' },
    }),
  );

  // stack ticket_ready → pr_opened → ticket_ready (re-emit) → pr_merged.
  // by seq alone ticket_ready is after pr_opened, but since it is merged no follow-up push is possible.
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'server', body: 'ready', kind: 'ticket_ready', ref_ticket_id: ticket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'publisher', body: 'opened PR #225', kind: 'pr_opened', ref_ticket_id: ticket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'server', body: 're-emit', kind: 'ticket_ready', ref_ticket_id: ticket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'publisher', body: 'PR #225 merged', kind: 'pr_merged', ref_ticket_id: ticket.id },
  });

  const status = parse(await client.callTool({ name: 'publisher_status', arguments: {} }));
  assert.equal(status.pending_update_count, 0, 'already-pr_merged does not appear in waiting-for-update');
  assert.ok(
    !status.pending_update_tickets.some((p: any) => p.ref_ticket_id === ticket.id),
    'a merged ticket remains in pending_update',
  );
  // awaiting_merge disappears on pr_merged (as before).
  assert.equal(status.awaiting_merge_count, 0);

  cdb.close();
});

test('publisher_status: a closed ticket does not appear in waiting-for-update', async () => {
  const { client, cdb } = await connect();

  const ticket = parse(
    await client.callTool({
      name: 'open_ticket',
      arguments: { title: 'closed ticket (does not appear in waiting-for-update)' },
    }),
  );

  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'server', body: 'ready', kind: 'ticket_ready', ref_ticket_id: ticket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'publisher', body: 'opened a PR', kind: 'pr_opened', ref_ticket_id: ticket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'server', body: 're-emit', kind: 'ticket_ready', ref_ticket_id: ticket.id },
  });

  // close the ticket (situation after reconcile).
  const upd = parse(
    await client.callTool({
      name: 'update_ticket',
      arguments: { ticket_id: ticket.id, expected_version: ticket.version, status: 'closed' },
    }),
  );
  assert.equal(upd.ok, true);

  const status = parse(await client.callTool({ name: 'publisher_status', arguments: {} }));
  assert.equal(status.pending_update_count, 0, 'a closed ticket does not appear in waiting-for-update');
  assert.ok(
    !status.pending_update_tickets.some((p: any) => p.ref_ticket_id === ticket.id),
    'a closed ticket remains in pending_update',
  );

  cdb.close();
});

test('publisher_status: even on an existing DB with no pr_updated at all, an already-pr_merged ticket is excluded from waiting-for-update (backward compatible)', async () => {
  const { client, cdb } = await connect();

  // merged ticket: ticket_ready → pr_opened → ticket_ready → pr_merged (no pr_updated at all).
  const mergedTicket = parse(
    await client.callTool({ name: 'open_ticket', arguments: { title: 'merged (no pr_updated)' } }),
  );
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'server', body: 'ready', kind: 'ticket_ready', ref_ticket_id: mergedTicket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'publisher', body: 'opened a PR', kind: 'pr_opened', ref_ticket_id: mergedTicket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'server', body: 're-emit', kind: 'ticket_ready', ref_ticket_id: mergedTicket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'publisher', body: 'PR merged', kind: 'pr_merged', ref_ticket_id: mergedTicket.id },
  });

  // unmerged, already-re-emitted ticket: keeps appearing in waiting-for-update as before (no pr_updated).
  const liveTicket = parse(
    await client.callTool({ name: 'open_ticket', arguments: { title: 'unmerged, re-emitted (no pr_updated)' } }),
  );
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'server', body: 'ready', kind: 'ticket_ready', ref_ticket_id: liveTicket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'publisher', body: 'opened a PR', kind: 'pr_opened', ref_ticket_id: liveTicket.id },
  });
  await client.callTool({
    name: 'post_board',
    arguments: { agent_id: 'server', body: 're-emit', kind: 'ticket_ready', ref_ticket_id: liveTicket.id },
  });

  const status = parse(await client.callTool({ name: 'publisher_status', arguments: {} }));
  // merged is excluded, only unmerged/re-emitted remains.
  assert.ok(
    !status.pending_update_tickets.some((p: any) => p.ref_ticket_id === mergedTicket.id),
    'an already-pr_merged ticket should be excluded from waiting-for-update even without pr_updated',
  );
  assert.ok(
    status.pending_update_tickets.some((p: any) => p.ref_ticket_id === liveTicket.id),
    'an unmerged/re-emitted ticket should remain in waiting-for-update as before',
  );
  assert.equal(status.pending_update_count, 1);

  cdb.close();
});
