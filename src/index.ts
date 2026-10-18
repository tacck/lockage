#!/usr/bin/env node
/**
 * lockage — the coordinated-development MCP server itself (Phase 1: single host).
 *
 * Exposes the coordination logic implemented so far under src/lockage/* (atomic claim,
 * worktree physical isolation, advisory claim/dirty set, integration merge gate,
 * board/A2A wake) as MCP tools. It starts on the stdio transport and can be driven from
 * MCP clients such as Claude Code / Kiro.
 *
 * The 7 design categories (§2):
 *   2.1 Task operations    create_task / list_tasks / claim_task / release_task / block_task / resume_task / handoff_task / task_done / heartbeat
 *   2.3 File coordination  claim_files / release_claim / list_claims / publish_dirty / list_dirty
 *   2.5 Context sharing (board) post_board / read_board / resolve_question
 *   2.6 worktree           assign_worktree / release_worktree / list_worktrees
 *   2.7 Waiting (A2A wake) wait_for_unblock
 *   (merge gate)           process_merge_queue / list_merge_queue (maintenance toolset; not exposed by default)
 *   (publisher observation) publisher_status
 *
 * Differences from the design (Phase 1 scope): ticket operations (2.2) are implemented.
 * The git-commit-linked context sharing (2.4) was never used and has been dropped (#69).
 * handoff (§4.7) is implemented as handing a blocked task to another worker (handoff_task).
 * agent_id is self-declared by the client (Phase 1 assumes a single host inside the trust boundary).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { openDb, type CoordDb } from './db/index.js';
import {
  claimTask,
  createTask,
  addDependency,
  getTask,
  heartbeat,
  listTasks,
  releaseTask,
  blockTask,
  resumeTask,
  handoffTask,
} from './lockage/claim.js';
import {
  openTicket,
  updateTicket,
  listTickets,
  linkTaskToTicket,
  getTicket,
  ticketRepos,
  clearIntegrationBranch,
  closeTicketOnMerge,
} from './lockage/tickets.js';
import {
  assignWorktree,
  listWorktrees,
  listStaleWorktrees,
  releaseWorktree,
  releaseWorktreesForTicket,
  reclaimOrphanWorktrees,
} from './lockage/worktree.js';
import {
  claimFiles,
  listClaims,
  listDirty,
  mergeDirtyResults,
  publishDirty,
  reconcileDirtyFromWorktrees,
  releaseClaim,
  releaseClaimsForFinishedTicketTasks,
} from './lockage/files.js';
import { onTaskDone, listMergeQueue, processMergeQueue } from './lockage/merge.js';
import { acquirePublishLock, releasePublishLock } from './lockage/publish-lock.js';
import {
  postBoard,
  readBoard,
  resolveQuestion,
  waitForUnblock,
  computePublisherStatus,
} from './lockage/board.js';
import { readPackageVersion } from './version.js';

/** Shared helper that returns a tool result as MCP text content (JSON). */
function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}
function fail(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
  };
}

/**
 * DB path. Overridable via the LOCKAGE_DB environment variable.
 * Defaults to ~/.lockage/lockage.sqlite (home-absolute path).
 * Pinned to a home-absolute path to match the design intent that the cross-repo ledger is
 * globally single. A CWD-relative path would split the ledger per launch repo and break the
 * "cross-repo" guarantee.
 */
const DB_PATH = process.env.LOCKAGE_DB ?? join(homedir(), '.lockage', 'lockage.sqlite');

/**
 * Toolsets not registered by default (#65). Enabled at server startup via the LOCKAGE_TOOLSETS
 * environment variable (comma-separated). Tools that belong to no toolset (core) are always
 * registered. lockage-publish also uses core tools such as read_ticket and list_tasks, so there
 * is no option to drop core.
 *
 * - publisher: cleanup tools called only by lockage-publish. If an agent calls them it could
 *   close tickets or clear integration branch names, so they are not shown in the agent's list.
 * - maintenance: for maintenance/diagnostics. Enabled only when a human needs it.
 *
 * The actual registration split is the `if (toolsets.has(...))` in buildServer; this list exists
 * to cross-check that against the README (drift is detected by tests). We do not register
 * everything and then remove some, because the MCP SDK has no public API to look up a registered
 * tool by name and remove it.
 */
export const OPTIONAL_TOOLSETS = {
  publisher: [
    'acquire_publish_lock',
    'release_publish_lock',
    'clear_integration_branch',
    'close_ticket_on_merge',
    'release_ticket_worktrees',
    'release_ticket_claims',
  ],
  maintenance: ['reclaim_orphan_worktrees', 'process_merge_queue', 'list_merge_queue'],
} as const;

export type OptionalToolset = keyof typeof OPTIONAL_TOOLSETS;

/**
 * Turns the LOCKAGE_TOOLSETS value into a set of toolsets. `core` is always enabled, so it is
 * ignored even if written. An unknown name is a configuration error (e.g. a typo), so instead of
 * silently ignoring it we stop startup.
 */
export function parseToolsets(value: string | undefined): Set<OptionalToolset> {
  const result = new Set<OptionalToolset>();
  for (const raw of (value ?? '').split(',')) {
    const name = raw.trim();
    if (name === '' || name === 'core') continue;
    if (!Object.hasOwn(OPTIONAL_TOOLSETS, name)) {
      throw new Error(
        `LOCKAGE_TOOLSETS has an unknown toolset: ${name} (valid: core, ${Object.keys(OPTIONAL_TOOLSETS).join(', ')})`,
      );
    }
    result.add(name as OptionalToolset);
  }
  return result;
}

/**
 * The version this server reports in the MCP initialize handshake. Read from package.json via
 * the shared reader in src/version.ts so it stays in sync with the published package (previously
 * hard-coded to '0.0.1', which gave clients no way to tell the running version — see #3).
 */
const SERVER_VERSION = readPackageVersion();

export function buildServer(
  cdb: CoordDb,
  opts: { toolsets?: Iterable<OptionalToolset> } = {},
): McpServer {
  const toolsets = new Set(opts.toolsets ?? []);
  const server = new McpServer({
    name: 'lockage',
    version: SERVER_VERSION,
  });

  // ── 2.1 Task operations ──────────────────────────────────────────
  server.registerTool(
    'create_task',
    {
      description:
        'Create a task. Right after creation it is open and unassigned. ticket_id is optional (you can also create minor tasks not tied to a ticket). This task does not become ready until every task passed in depends_on is done. If the dependencies form a cycle, returns {ok:false, reason:"cycle"}.',
      inputSchema: {
        repo: z.string().describe('target repo identifier'),
        title: z.string(),
        description: z.string().optional(),
        ticket_id: z.string().nullable().optional(),
        priority: z
          .number()
          .int()
          .optional()
          .describe(
            'priority (integer, default 0). Larger is higher priority. Ties break by created_at ascending (oldest first). Negatives are allowed (explicitly deprioritize). Guide: -10=low / 0=normal / 10=high / 100=interrupt (top)',
          ),
        depends_on: z
          .array(z.string())
          .optional()
          .describe('array of existing task ids that block this task (dependencies; not ready until all are done)'),
      },
    },
    async (a) =>
      ok(
        createTask(cdb, {
          repo: a.repo,
          title: a.title,
          description: a.description,
          ticketId: a.ticket_id ?? null,
          priority: a.priority,
          dependsOn: a.depends_on ?? [],
        }),
      ),
  );

  server.registerTool(
    'add_dependency',
    {
      description:
        'Add a dependency between two existing tasks. to_task does not become ready until from_task is done (the version that adds create_task\'s depends_on afterward). If it would create a cycle, returns {ok:false, reason:"cycle"}; "not_found" if a task is missing; "self" if both ids are the same.',
      inputSchema: {
        from_task: z.string().describe('the blocking side (the dependency that finishes first)'),
        to_task: z.string().describe('the blocked side (waits for from_task to finish)'),
      },
    },
    async (a) => ok(addDependency(cdb, a.from_task, a.to_task)),
  );

  server.registerTool(
    'list_tasks',
    {
      description:
        'List tasks (regardless of status, highest priority first, oldest first on ties). Each row includes the version to pass to claim_task. Filter by status/assignee/ticket_id/repo. To find unassigned tasks use status="open". With ready_only=true, returns only tasks whose dependencies are all done. When status="blocked", to help find tasks left stuck, each row carries blocked_age_sec (seconds since the task was last updated; usually time since it became blocked), agent_silent_sec (seconds since the assignee\'s last activity; null if unknown), and last_question (the latest unresolved question for this task) (sort by blocked_age_sec to see the longest-neglected first).',
      inputSchema: {
        status: z
          .enum(['open', 'in_progress', 'done', 'abandoned', 'blocked'])
          .optional(),
        assignee: z.string().optional(),
        ticket_id: z.string().optional().describe('narrow to tasks under this parent ticket'),
        repo: z.string().optional(),
        ready_only: z
          .boolean()
          .optional()
          .describe('true for only tasks whose dependencies are all done (unblocked)'),
      },
    },
    async (a) =>
      ok(
        listTasks(cdb, {
          status: a.status,
          assignee: a.assignee,
          ticketId: a.ticket_id,
          repo: a.repo,
          readyOnly: a.ready_only,
        }),
      ),
  );

  server.registerTool(
    'claim_task',
    {
      description:
        'Claim a task atomically (set it to in_progress and make yourself the assignee). Pass the version read from list_tasks as expected_version. If another agent claimed it first, or it changed after you read it, returns {ok:false} with the current value without blocking. In that case do not steal it — pick another task.',
      inputSchema: {
        task_id: z.string(),
        agent_id: z.string(),
        expected_version: z.number().int(),
      },
    },
    async (a) => {
      heartbeat(cdb, a.agent_id);
      return ok(claimTask(cdb, a.task_id, a.agent_id, a.expected_version));
    },
  );

  server.registerTool(
    'release_task',
    {
      description:
        'Release a claimed task (usable only on your own in_progress task; not usable on a blocked task). outcome="open" (default) returns it to open so anyone can re-claim it; "abandoned" marks it as no longer being worked on. When finished, use task_done instead.',
      inputSchema: {
        task_id: z.string(),
        agent_id: z.string(),
        outcome: z.enum(['open', 'abandoned']).optional().describe('default open'),
      },
    },
    async (a) => {
      heartbeat(cdb, a.agent_id);
      return ok(releaseTask(cdb, a.task_id, a.agent_id, a.outcome ?? 'open'));
    },
  );

  server.registerTool(
    'block_task',
    {
      description:
        'Suspend a task to wait for a human decision (in_progress→blocked). Call this before exiting when you cannot finish — e.g. lacking permission, or a design decision is needed. Unlike release_task, you keep the assignment and worktree, and it is not taken away on timeout. Record the reason you got stuck first via post_board(kind="question", ref_task_id). Usable only on your own in_progress task.',
      inputSchema: {
        task_id: z.string(),
        agent_id: z.string(),
      },
    },
    async (a) => {
      // Invoked by an operator (not the worker itself = orchestrator/human), so do not touch
      // agents.last_seen (to avoid polluting agent_silent_sec of list_tasks(status="blocked") with
      // the operation time). blockTask intentionally keeps the task's heartbeat_at, so we do not
      // pass taskId here either.
      heartbeat(cdb, a.agent_id, { touchAgent: false });
      return ok(blockTask(cdb, a.task_id, a.agent_id));
    },
  );

  server.registerTool(
    'resume_task',
    {
      description:
        'When a human says "continue", resume a suspended task with the same agent (blocked→in_progress). The worktree is still usable. After resuming it returns to normal in_progress, and if heartbeat lapses it is returned to open. Usable only on your own blocked task. To hand it to another agent, use handoff_task.',
      inputSchema: {
        task_id: z.string(),
        agent_id: z.string(),
      },
    },
    async (a) => {
      // resume is invoked by the human/orchestrator, and only then does the launcher start the
      // worker, so at resume time the worker process is not yet alive. Touching agents.last_seen
      // would be misread as "alive before launch" and skew orphan detection, hence touchAgent=false.
      // The task's heartbeat_at revival (lease restart) is done inside resumeTask, so the launched
      // worker records liveness via its normal heartbeat afterward.
      heartbeat(cdb, a.agent_id, { touchAgent: false });
      return ok(resumeTask(cdb, a.task_id, a.agent_id));
    },
  );

  server.registerTool(
    'handoff_task',
    {
      description:
        'Move a blocked task to another agent named by a human (use only when a human says so explicitly; the usual resume is resume_task). Reassigns the task\'s assignee, worktree, claims, and dirty from from_agent to to_agent together (branch and path do not change), posts a handoff to the board, and wakes to_agent. to_agent can trace the predecessor\'s question from ref_task_id. After the move it becomes to_agent\'s in_progress task and must have its lease extended by heartbeat. If it is not a blocked task held by from_agent, returns {ok:false, reason:"conflict", current} without changing anything ("not_found" if the task is missing). An in_progress task cannot be moved.',
      inputSchema: {
        task_id: z.string(),
        from_agent: z.string().describe('the original agent_id that got stuck and set it to blocked'),
        to_agent: z.string().describe('the handoff-target agent_id named by the human'),
      },
    },
    async (a) => {
      // handoff is invoked by the human/orchestrator, and to_agent's worker process is not yet
      // started at this point (order: handoff → launcher starts it in the worktree). Recording
      // agents.last_seen for to_agent would be misread as "alive before launch", delaying orphan
      // detection if to_agent stays dead. So touchAgent=false. The task's heartbeat_at revival is
      // done inside handoffTask, and the launched to_agent records liveness via its normal
      // heartbeat afterward.
      heartbeat(cdb, a.to_agent, { touchAgent: false });
      const r = handoffTask(cdb, {
        taskId: a.task_id,
        fromAgent: a.from_agent,
        toAgent: a.to_agent,
      });
      // Only when the move is committed do we leave a trace on the board, which wakes to_agent (point B).
      // handoffTask opens BEGIN IMMEDIATE internally, so to avoid a nested BEGIN we do the board
      // integration after success is confirmed (the atomicity of the state reassignment and the
      // notification are separate concerns).
      //   - post_board(kind='handoff', author=from, to_agent=to, ref_task_id): the arriving to_agent
      //     learns it was handed the task and can trace the predecessor's question via ref (D-3's
      //     directed board notification).
      //   No separate board wake: the handoff is unread for to_agent (directed posts count from seq 0
      //   even before it has a read position), so its first wait_for_unblock returns on it.
      if (r.ok) {
        postBoard(cdb, {
          agentId: a.from_agent,
          kind: 'handoff',
          toAgent: a.to_agent,
          refTaskId: a.task_id,
          body: `Handed task ${a.task_id} over from ${a.from_agent}. worktree: ${r.worktrees.join(', ') || '(none)'
            }. Check the stuck reason the predecessor left via read_board(kind='question', ref_task_id).`,
        });
      }
      return ok(r);
    },
  );

  server.registerTool(
    'task_done',
    {
      description:
        'Complete a task and hand it to the merge gate. Call it after committing your work in the worktree. A task with a ticket_id merges to the ticket\'s integration branch (lockage/ticket/<short id>); a task with no ticket_id (also when task_id is omitted) merges to the base branch. If a conflict looks likely, it does not merge and returns needs_review (each element\'s contested lists the files that would conflict; the task stays in_progress) — resolve in the worktree and call again. For a worktree_path you are not assigned, a branch equal to base, or a task not assigned to you, it changes nothing and returns {ok:false, reason:"no_active_worktree"|"branch_is_base"|"not_assignee"}. For a lease-expired task (heartbeat lapsed, so the task went back to unassigned), if your assignment is tied to that task it re-claims and continues (rescue). not_assignee means the task is not yours (another agent owns it, or the worktree assignment is not tied to that task and is not eligible for rescue), and repeating the same call will not succeed — check with list_tasks, and if another agent owns it, do not steal it; move to another task. If it is unassigned/open, confirm the task_id + worktree_path pair is your own work, then claim_task with the list_tasks version as expected_version and call task_done again. If the rescue re-claim loses a race and the task is still unassigned, returns {ok:false, reason:"lease_expired"}, so wait a few seconds and call again (retry at most 3 times after the first call). If it is still lease_expired, check with list_tasks: if unassigned/open, do the same as not_assignee — claim_task then call task_done (on conflict, start over from list_tasks). If another agent owns it, do not steal it; move to another task. Otherwise leave a question and stop (block_task only works when the task is yours and in_progress). When all of a ticket\'s tasks are done, ticket_ready is emitted automatically. PRs are created by lockage-publish (a CLI, not an MCP tool; not resident): after you set the ticket\'s last task to done, confirm it appears as awaiting PR via publisher_status, then run lockage-publish --repo-path <repo absolute path> --ticket <ticket_id>. gh pr create is not used.',
      inputSchema: {
        agent_id: z.string(),
        worktree_path: z.string(),
        branch: z.string(),
        repo: z.string().describe('absolute path to the repo root'),
        task_id: z.string().nullable().optional(),
      },
    },
    async (a) => {
      // Issue #52: before running task_done (= while the worktree is still active), recompute dirty
      // from the worktree's git state and capture files outside the claim glob as unclaimed. Since
      // onTaskDone clears that worktree's dirty set on a successful merge, this computation must
      // happen before it. OnTaskDoneResult itself is unchanged; the handler merges in unclaimed and
      // returns via ok().
      const rc = reconcileDirtyFromWorktrees(cdb, {
        agentId: a.agent_id,
        worktreePath: a.worktree_path,
      });
      const res = onTaskDone(cdb, {
        agentId: a.agent_id,
        worktreePath: a.worktree_path,
        branch: a.branch,
        repo: a.repo,
        taskId: a.task_id ?? null,
      });
      return ok({ ...res, unclaimed: rc.unclaimed });
    },
  );

  server.registerTool(
    'heartbeat',
    {
      description:
        'Signal that you are alive and extend the lease on the tasks and claims you hold (task lease is 15 minutes). Calling claim_task, release_task, claim_files, publish_dirty, resolve_question, assign_worktree, or wait_for_unblock also extends it, but post_board, task_done, release_claim, release_worktree, etc. do not, so call this at intervals shorter than 15 minutes while working (around 10 minutes). Passing task_id extends only that task. It also auto-computes changes (dirty) in your assigned worktree, returning overlaps if they overlap another agent\'s dirty or claims, and files changed outside your claim glob as unclaimed.',
      inputSchema: { agent_id: z.string(), task_id: z.string().optional() },
    },
    async (a) => {
      heartbeat(cdb, a.agent_id, a.task_id);
      // Issue #52: auto-compute dirty from the assigned worktree's git state and return overlaps/wake/unclaimed.
      const rc = reconcileDirtyFromWorktrees(cdb, { agentId: a.agent_id });
      return ok({
        ok: true,
        overlaps: rc.overlaps,
        wake_targets: rc.wake_targets,
        unclaimed: rc.unclaimed,
      });
    },
  );

  // ── 2.2 Ticket operations (model 3: a grouping unit for issues) ───────────
  server.registerTool(
    'open_ticket',
    {
      description:
        'Create a ticket. A ticket groups multiple tasks and is a work unit that eventually becomes a PR from an integration branch; it is not claimed (it is distinct from a GitHub Issue). Omitting or leaving repos empty makes a ticket that relates to any repo. The title and body are full-text searchable via list_tickets\' query.',
      inputSchema: {
        title: z.string(),
        body: z.string().nullable().optional(),
        repos: z.array(z.string()).optional().describe('the repos involved. Omitted or empty means it relates to any repo'),
        priority: z
          .number()
          .int()
          .optional()
          .describe(
            'priority (integer, default 0). Larger is higher priority. Ties break by created_at ascending (oldest first). Negatives are allowed (explicitly deprioritize). Guide: -10=low / 0=normal / 10=high / 100=interrupt (top)',
          ),
        created_by: z.string().nullable().optional(),
      },
    },
    async (a) =>
      ok(
        openTicket(cdb, {
          title: a.title,
          body: a.body ?? null,
          repos: a.repos,
          priority: a.priority,
          createdBy: a.created_by ?? null,
        }),
      ),
  );

  server.registerTool(
    'update_ticket',
    {
      description:
        'Partially update a ticket\'s status, body, priority, and assignee. Pass the version read via read_ticket (etc.) as expected_version. If it changed after you read it, returns {ok:false, reason:"conflict", current}. If the ticket is missing, {ok:false, reason:"not_found"}. When status changes automatically via a claim or a PR merge, the version is not bumped.',
      inputSchema: {
        ticket_id: z.string(),
        expected_version: z.number().int(),
        status: z.enum(['open', 'in_progress', 'closed']).optional(),
        body: z.string().nullable().optional(),
        priority: z
          .number()
          .int()
          .optional()
          .describe(
            'priority (integer, default 0). Larger is higher priority. Ties break by created_at ascending (oldest first). Negatives are allowed (explicitly deprioritize). Guide: -10=low / 0=normal / 10=high / 100=interrupt (top)',
          ),
        assignee: z.string().nullable().optional(),
      },
    },
    async (a) =>
      ok(
        updateTicket(cdb, {
          ticketId: a.ticket_id,
          expectedVersion: a.expected_version,
          status: a.status,
          body: a.body,
          priority: a.priority,
          assignee: a.assignee,
        }),
      ),
  );

  server.registerTool(
    'list_tickets',
    {
      description:
        'List and search tickets (regardless of status/query, highest priority first, oldest first on ties). Filter by status. Passing repo returns tickets related to that repo plus tickets related to any repo. query full-text searches the title and body. Each ticket carries repos (empty means it relates to any repo).',
      inputSchema: {
        status: z.enum(['open', 'in_progress', 'closed']).optional(),
        repo: z.string().optional(),
        query: z.string().optional().describe('terms to full-text search the title and body (an FTS5 query expression; wrap words containing symbols such as - or # in "…")'),
        limit: z.number().int().optional(),
      },
    },
    async (a) =>
      ok(listTickets(cdb, { status: a.status, repo: a.repo, query: a.query, limit: a.limit })),
  );

  server.registerTool(
    'read_ticket',
    {
      description:
        'Read a single ticket ({ticket:null} if missing). Includes the integration branch name (integration_branch), the time ticket_ready was emitted (ticket_ready_at), and repos.',
      inputSchema: {
        ticket_id: z.string(),
      },
    },
    async (a) => {
      const ticket = getTicket(cdb, a.ticket_id);
      if (!ticket) return ok({ ticket: null });
      return ok({ ticket: { ...ticket, repos: ticketRepos(cdb, a.ticket_id) } });
    },
  );

  if (toolsets.has('publisher')) {
    server.registerTool(
      'clear_integration_branch',
      {
        description:
          'As post-merge cleanup for a PR, clear the ticket\'s integration branch name (integration_branch) (called by lockage-publish\'s reconcile). Does not bump the version. Passing expected_branch clears it only when the name matches (to avoid clearing a newly re-created branch name). Returns cleared:false if already cleared, not_found if the ticket is missing.',
        inputSchema: {
          ticket_id: z.string(),
          expected_branch: z
            .string()
            .optional()
            .describe('clear only when the name matches this (if omitted, clear regardless of name)'),
        },
      },
      async (a) => ok(clearIntegrationBranch(cdb, a.ticket_id, a.expected_branch)),
    );

    server.registerTool(
      'close_ticket_on_merge',
      {
        description:
          'As post-merge cleanup for a PR, set the ticket to closed (called by lockage-publish\'s reconcile). Does not bump the version, so it does not conflict with a human concurrently editing the body etc. Returns closed:false if already closed, not_found if the ticket is missing.',
        inputSchema: {
          ticket_id: z.string(),
        },
      },
      async (a) => ok(closeTicketOnMerge(cdb, a.ticket_id)),
    );
  }

  server.registerTool(
    'link_task_to_ticket',
    {
      description:
        'Re-link a task to a parent ticket (ticket_id=null to unlink). Work spanning multiple repos is represented by creating one task per repo under the same ticket_id. If the task or ticket is missing, declines with a reason.',
      inputSchema: {
        task_id: z.string(),
        ticket_id: z.string().nullable().optional().describe('null to unlink the parent ticket'),
      },
    },
    async (a) => ok(linkTaskToTicket(cdb, a.task_id, a.ticket_id ?? null)),
  );

  // ── 2.3 File coordination (advisory) ─────────────────────────────
  server.registerTool(
    'claim_files',
    {
      description:
        'Declare the files you are about to touch as globs. It does not block if it overlaps another agent\'s declaration — it reports them as overlaps. A declaration has a lease; heartbeat extends it, and it expires when heartbeat stops. Re-declaring recomputes the changes in your assigned worktree and returns files already changed outside the declared glob as unclaimed.',
      inputSchema: {
        agent_id: z.string(),
        globs: z.array(z.string()).describe('the glob patterns you take responsibility for'),
        ttl_sec: z.number().int().optional(),
        task_id: z.string().nullable().optional(),
      },
    },
    async (a) => {
      heartbeat(cdb, a.agent_id);
      const res = claimFiles(cdb, {
        agentId: a.agent_id,
        globs: a.globs,
        ttlSec: a.ttl_sec,
        taskId: a.task_id ?? null,
      });
      // Issue #52: after re-declaring the claim, recompute dirty from the worktree's git state and
      // return files outside the declared glob as unclaimed (surface out-of-scope changes).
      const rc = reconcileDirtyFromWorktrees(cdb, { agentId: a.agent_id });
      return ok({ ...res, unclaimed: rc.unclaimed, dirty_overlaps: rc.overlaps });
    },
  );

  server.registerTool(
    'release_claim',
    {
      description:
        'Release a file claim (only the declarer may call it). Claims tied to a task are released by task_done, release_task, and PR post-merge cleanup, so you usually need not call this. Release claims not tied to a task with this (even if you do not, they are reclaimed on expiry after heartbeat stops).',
      inputSchema: { claim_id: z.string(), agent_id: z.string() },
    },
    async (a) => ok(releaseClaim(cdb, a.claim_id, a.agent_id)),
  );

  server.registerTool(
    'list_claims',
    {
      description: 'List active file claims (filter by holder).',
      inputSchema: { holder: z.string().optional() },
    },
    async (a) => ok(listClaims(cdb, a.holder)),
  );

  server.registerTool(
    'publish_dirty',
    {
      description:
        'Announce files you have already changed (dirty). If they overlap another agent\'s dirty or claims, reports them via overlaps and wakes that peer. Files outside your claim glob are returned as unclaimed. dirty is also auto-computed and added from the worktree\'s git state, so call this when you want to announce ahead of that automatic computation, for example.',
      inputSchema: {
        agent_id: z.string(),
        worktree_path: z.string(),
        files: z.array(z.string()).describe('list of changed files (repo-relative)'),
      },
    },
    async (a) => {
      heartbeat(cdb, a.agent_id);
      const res = publishDirty(cdb, {
        agentId: a.agent_id,
        worktreePath: a.worktree_path,
        files: a.files,
      });
      // Issue #52: in addition to the explicitly announced files, include the same worktree's git
      // state in the union. reconcile overwrites with the union of existing dirty (the announcement
      // just published) and git-derived files, so the announced files always remain.
      //
      // Here we explicitly pass minIntervalSec: 0. The dirty rows publishDirty just wrote have
      // updated_at=now, so at the default minimum interval (30 seconds) reconcile would judge them
      // "fresh", skip reading git, and leave git-derived changes out of the same response (which
      // would contradict the tool's description that it also adds and returns dirty computed from
      // git state). Only the publish_dirty path disables the throttle so that "explicit announce ∪
      // git state" is always unioned in the same call (the announced files are part of the union, so
      // nothing breaks).
      const rc = reconcileDirtyFromWorktrees(cdb, {
        agentId: a.agent_id,
        worktreePath: a.worktree_path,
        minIntervalSec: 0,
      });
      // Issue #52 regression fix: overwriting res wholesale with rc would, when the worktree_path
      // passed to publish_dirty is not in an active assignment (e.g. no assign_worktree), make rc
      // empty and swallow the overlap/wake/unclaimed that publishDirty actually detected. Merge the
      // two so that res's detection always remains even if reconcile cannot find the worktree
      // (dedup included).
      const merged = mergeDirtyResults(res, rc);
      // Explicitly build and return the 3 items from merged (ok/overlaps/wake_targets/unclaimed).
      // We avoid a `...res` spread that overwrites just the 3 items on res's shape, since res and
      // merged share the same keys and are easy to mix up (behavior is unchanged = the same 4 keys
      // as PublishDirtyResult).
      return ok({
        ok: true,
        overlaps: merged.overlaps,
        wake_targets: merged.wake_targets,
        unclaimed: merged.unclaimed,
      });
    },
  );

  server.registerTool(
    'list_dirty',
    {
      description: 'List dirty (changed) files (filter by agent_id).',
      inputSchema: { agent_id: z.string().optional() },
    },
    async (a) => ok(listDirty(cdb, a.agent_id)),
  );

  // ── 2.5 Context sharing (board) ──────────────────────────────────
  server.registerTool(
    'post_board',
    {
      description:
        'Post to the shared board. Specifying to_agent addresses it to that peer. An agent waiting in wait_for_unblock wakes on posts addressed to it or to everyone (regardless of kind). Attach the target task to a question via ref_task_id. ticket_ready is posted by the server; pr_opened, pr_updated, and pr_merged are posted by lockage-publish.',
      inputSchema: {
        agent_id: z.string(),
        body: z.string(),
        kind: z
          .enum(['note', 'handoff', 'question', 'ticket_ready', 'pr_opened', 'pr_updated', 'pr_merged'])
          .optional(),
        to_agent: z.string().nullable().optional(),
        ref_task_id: z.string().nullable().optional(),
        ref_ticket_id: z.string().nullable().optional(),
      },
    },
    async (a) =>
      ok(
        postBoard(cdb, {
          agentId: a.agent_id,
          body: a.body,
          kind: a.kind,
          toAgent: a.to_agent ?? null,
          refTaskId: a.ref_task_id ?? null,
          refTicketId: a.ref_ticket_id ?? null,
        }),
      ),
  );

  server.registerTool(
    'read_board',
    {
      description:
        'Read the board. Passing the last-read seq as since returns only the diff. Passing to_agent returns posts addressed to you and to everyone. Filter by kind (ticket_ready = tickets ready to become a PR; pr_opened, pr_updated, pr_merged = records from lockage-publish). unresolved_only=true excludes resolved questions (kinds other than question are still returned, so combine with kind="question" to see only unresolved questions).',
      inputSchema: {
        since: z.number().int().optional(),
        to_agent: z.string().optional(),
        kind: z
          .enum(['note', 'handoff', 'question', 'ticket_ready', 'pr_opened', 'pr_updated', 'pr_merged'])
          .optional(),
        limit: z.number().int().optional(),
        unresolved_only: z.boolean().optional(),
      },
    },
    async (a) =>
      ok(
        readBoard(cdb, {
          since: a.since,
          toAgent: a.to_agent,
          kind: a.kind,
          limit: a.limit,
          unresolvedOnly: a.unresolved_only,
        }),
      ),
  );

  server.registerTool(
    'resolve_question',
    {
      description:
        'Mark a question resolved. Questions are resolved automatically when their ref_task_id task becomes done or abandoned, so call this for questions not tied to a task, or questions you want to close with just an answer without resuming the task. If already resolved, {ok:true, already_resolved:true}. A message_id that is not a question or does not exist returns {ok:false, reason}. Read unresolved questions via read_board(kind="question", unresolved_only:true).',
      inputSchema: {
        agent_id: z.string(),
        message_id: z.string(),
      },
    },
    async (a) => {
      heartbeat(cdb, a.agent_id);
      return ok(resolveQuestion(cdb, { agentId: a.agent_id, messageId: a.message_id }));
    },
  );

  // ── 2.6 worktree ───────────────────────────────────────────────
  server.registerTool(
    'assign_worktree',
    {
      description:
        'Assign a git worktree for a task. Do all editing inside the returned worktree_path. If an equivalent assignment is still valid, returns it (reused=true). The branch name is lockage/<agent>/<slug>.',
      inputSchema: {
        agent_id: z.string(),
        repo_path: z.string().describe('the repo root on the filesystem'),
        task_id: z.string().nullable().optional(),
        base_ref: z.string().optional().describe('the branch to fork from (default: the first of dev / stg / main / master that actually exists in the repo)'),
        base_from_remote: z.boolean().optional().describe('when base_ref is omitted, fetch and fork from the remote-tracking ref (origin/<base>) so the fork point is not a stale local base (default: true). Falls back to the local base when there is no remote or no tracking ref. false forks from the local base as before. Ignored when base_ref is given.'),
      },
    },
    async (a) => {
      heartbeat(cdb, a.agent_id);
      // Issue #8: base_ref が明示された場合は base_from_remote より base_ref を優先する
      // （follow-up の integration_branch 指定を壊さない）。assignWorktree 側で baseRef が
      // undefined でないときはリモート追従をスキップするため、ここでは両方そのまま伝搬すればよい。
      return ok(
        assignWorktree(cdb, {
          agentId: a.agent_id,
          repoPath: a.repo_path,
          taskId: a.task_id ?? null,
          baseRef: a.base_ref,
          baseFromRemote: a.base_from_remote,
        }),
      );
    },
  );

  server.registerTool(
    'release_worktree',
    {
      description:
        'Release a worktree. Only when git worktree remove (without --force) succeeds does it set the ledger to released and clear dirty. If it cannot be removed due to untracked files or uncommitted changes, returns {ok:true, removed:false, reason:"untracked"|"dirty"} and removes nothing (stash/commit the changes, then call again). The branch is kept by default. With keep_branch=false, the branch is also deleted only when removed=true.',
      inputSchema: {
        agent_id: z.string(),
        worktree_path: z.string(),
        repo_path: z.string(),
        keep_branch: z.boolean().optional(),
      },
    },
    async (a) =>
      ok(
        releaseWorktree(cdb, {
          agentId: a.agent_id,
          worktreePath: a.worktree_path,
          repoPath: a.repo_path,
          keepBranch: a.keep_branch,
        }),
      ),
  );

  server.registerTool(
    'list_worktrees',
    {
      description:
        'List active worktree assignments (filter by agent_id / ticket_id). With stale=true, returns only worktrees that remain despite being tied to a done task (mostly ones that could not be released due to uncommitted changes) (each row adds task_status and ticket_id to the same columns as the non-stale list). These are not re-released automatically, so stash the changes and then call release_worktree.',
      inputSchema: {
        agent_id: z.string().optional(),
        stale: z.boolean().optional().describe('true to return only candidates that failed to release'),
        ticket_id: z.string().optional().describe('narrow to worktrees of tasks under that ticket'),
      },
    },
    async (a) =>
      ok(
        a.stale
          ? listStaleWorktrees(cdb, { agentId: a.agent_id, ticketId: a.ticket_id })
          : listWorktrees(cdb, a.agent_id, a.ticket_id),
      ),
  );

  if (toolsets.has('maintenance')) {
    server.registerTool(
      'reclaim_orphan_worktrees',
      {
        description:
          'List worktrees that remain under .lockage-worktrees/ in the repo\'s parent directory but are not active in the ledger (orphans). ledger_status is released for ones released earlier yet still remaining, and none for ones with no ledger record. With dry_run=false, it tries to remove them via git worktree remove (without --force); ones with untracked files or uncommitted changes left are not removed and return removed:false with reason ("untracked"|"dirty"). Returns { orphans, removed_count }.',
        inputSchema: {
          repo_path: z.string().describe('the target repo root on the filesystem (the main repo)'),
          dry_run: z.boolean().optional().describe('true (default) to list only; false to attempt reclamation'),
        },
      },
      async (a) =>
        ok(
          reclaimOrphanWorktrees(cdb, {
            repoPath: a.repo_path,
            dryRun: a.dry_run,
          }),
        ),
    );
  }

  if (toolsets.has('publisher')) {
    server.registerTool(
      'release_ticket_worktrees',
      {
        description:
          'As post-merge cleanup for a PR, release the worktrees of done tasks under the ticket together (called by lockage-publish\'s reconcile). Also deletes the task branches by default (keep_branch=true to keep them). Worktrees with uncommitted changes are left unreleased. Calling it repeatedly does not double-release. Returns { released, removed_count }.',
        inputSchema: {
          ticket_id: z.string(),
          repo_path: z
            .string()
            .describe('the repo root where the worktree physically lives (used for old assignments with no repo record in the ledger)'),
          keep_branch: z
            .boolean()
            .optional()
            .describe('true to keep the task branches. Default false (deleted since they were merged via the integration branch)'),
        },
      },
      async (a) =>
        ok(
          releaseWorktreesForTicket(cdb, {
            ticketId: a.ticket_id,
            repoPath: a.repo_path,
            keepBranch: a.keep_branch,
          }),
        ),
    );

    server.registerTool(
      'release_ticket_claims',
      {
        description:
          'As post-merge cleanup for a PR, release the remaining file claims tied to done/abandoned tasks under the ticket together (called by lockage-publish\'s reconcile). Claims not tied to a task are excluded. Calling it repeatedly does not double-release. Returns { released_count }.',
        inputSchema: {
          ticket_id: z.string(),
        },
      },
      async (a) =>
        ok(
          releaseClaimsForFinishedTicketTasks(cdb, {
            ticketId: a.ticket_id,
          }),
        ),
    );
  }

  // ── Merge gate (observe/drive) ─────────────────────────────────
  if (toolsets.has('maintenance')) {
    server.registerTool(
      'process_merge_queue',
      {
        description:
          'Process the merge queue in order. Non-conflicting entries are merged to the ticket\'s integration branch or the base branch; entries that would conflict are sent back to needs_review. task_done normally processes this automatically, so use this when you want to drive it by hand.',
        inputSchema: {},
      },
      async () => ok(processMergeQueue(cdb)),
    );

    server.registerTool(
      'list_merge_queue',
      {
        description: 'List the merge queue (filter by state). Use it to check entries sent back to needs_review by task_done.',
        inputSchema: {
          state: z.enum(['queued', 'merging', 'merged', 'needs_review']).optional(),
        },
      },
      async (a) => ok(listMergeQueue(cdb, a.state)),
    );
  }

  // ── publisher observation (read-only) ───────────────────────────
  server.registerTool(
    'publisher_status',
    {
      description:
        'Read PR progress from the board (read-only; does not create PRs). Returns counts and lists (with integration branch names) for tickets awaiting a PR (pending_count, pending_tickets), awaiting a follow-up push to an existing PR (pending_update_count, pending_update_tickets), and awaiting a PR merge (awaiting_merge_count, awaiting_merge_tickets), plus the times of the last PR created and last merge recorded (last_pr_opened_at, last_pr_merged_at). The counts can overlap, so do not add them up. If pending_count or pending_update_count is 1 or more, run lockage-publish --repo-path <repo absolute path>; if awaiting_merge_count is 1 or more, run lockage-publish --repo-path <repo absolute path> --mode reconcile.',
      inputSchema: {},
    },
    async () => ok(computePublisherStatus(cdb)),
  );

  // ── publish advisory lock (prevents a per-ticket read→act race) ──────
  if (toolsets.has('publisher')) {
    server.registerTool(
      'acquire_publish_lock',
      {
        description:
          'lockage-publish takes a lock to prevent other processes from processing the same ticket while it processes it. If acquired, { ok:true, holder }; if another holds it, { ok:false }. A lock whose lease (ttl_sec, default 300 seconds) has expired can be taken over. The lock is per ticket, so it does not block other tickets.',
        inputSchema: {
          ticket_id: z.string(),
          ttl_sec: z.number().int().positive().optional().describe('the lock TTL in seconds. Default 300'),
        },
      },
      // This is a CAS write (INSERT/DELETE), not a read, so wrap the result with ok().
      async (a) => ok(acquirePublishLock(cdb, a.ticket_id, { ttlSec: a.ttl_sec })),
    );

    server.registerTool(
      'release_publish_lock',
      {
        description:
          'Release a lock taken via acquire_publish_lock. Deletes it only when holder matches (does not delete a lock that expired and was taken over by someone else). Returns {ok:true} regardless of whether it was deleted.',
        inputSchema: {
          ticket_id: z.string(),
          holder: z.string(),
        },
      },
      async (a) => {
        releasePublishLock(cdb, a.ticket_id, a.holder);
        return ok({ ok: true });
      },
    );
  }

  // ── 2.7 Waiting (A2A wake) ─────────────────────────────────────
  server.registerTool(
    'wait_for_unblock',
    {
      description:
        'Wait once until one of the following happens: a task you are waiting on becomes ready; an unread board post addressed to you or to everyone; an overlap with another agent; or timeout. Returns what woke you via woke_by. Unread is counted from where you last read, so a post that arrived while you were working or between waits still wakes you; the returned posts are then marked read. Posts addressed to you count from the start even before your first call (e.g. a handoff_task to you before you launched), posts to everyone from your first call. Your own posts and ticket_ready / pr_opened / pr_updated / pr_merged do not wake you (read_board still returns them). Use it instead of repeatedly polling lists.',
      inputSchema: {
        agent_id: z.string(),
        task_id: z.string().optional().describe('the task whose dependency resolution you are waiting for'),
        timeout_sec: z.number().int().optional().describe('default 60'),
      },
    },
    async (a) => {
      heartbeat(cdb, a.agent_id);
      return ok(
        await waitForUnblock(cdb, {
          agentId: a.agent_id,
          taskId: a.task_id,
          timeoutSec: a.timeout_sec,
        }),
      );
    },
  );

  return server;
}

async function main(): Promise<void> {
  const toolsets = parseToolsets(process.env.LOCKAGE_TOOLSETS);
  const cdb = openDb({ path: DB_PATH });
  const server = buildServer(cdb, { toolsets });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio keeps the process alive while connected. On SIGINT/SIGTERM, close the DB and exit.
  const shutdown = () => {
    try {
      cdb.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Startup log to stderr only (stdout is reserved for JSON-RPC, so do not write there).
  // Include the version so you can tell the running version from the log (the npx-launched
  // bundled server resolves whichever version npx has, which need not match a plugin's version — see #3).
  process.stderr.write(
    `[lockage] ready (version=${SERVER_VERSION}, db=${DB_PATH}, toolsets=${['core', ...toolsets].join(',')})\n`,
  );
}

// Start only when run as the entry point (do not start when imported from tests).
// Compare realpath-resolved paths: when launched via a bin symlink (npx / a Node version
// manager's bin), process.argv[1] is the symlink while import.meta.url resolves to the real
// file, so a raw string compare never matches and the server would silently never start.
// (fileURLToPath is imported at the top of the file.)
import { realpathSync } from 'node:fs';
const resolveReal = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
if (
  process.argv[1] &&
  resolveReal(fileURLToPath(import.meta.url)) === resolveReal(process.argv[1])
) {
  const fatal = (e: unknown) => {
    process.stderr.write(`[lockage] fatal: ${(e as { stack?: string })?.stack ?? e}\n`);
    process.exit(1);
  };
  // Dispatch to the hook CLI only when argv[2] is 'hook'/'setup'. No args or an unknown argv[2]
  // (e.g. 'serve') starts the MCP server as before. The dynamic import keeps the hook logic and git
  // execution from loading on a no-arg MCP start (lighter startup, fewer side effects).
  const sub = process.argv[2];
  if (sub === 'hook' || sub === 'setup') {
    import('./hook/dispatch.js')
      .then((m) => m.dispatchCli(process.argv.slice(2)))
      .catch(fatal);
  } else {
    main().catch(fatal);
  }
}

export { fail, ok };
