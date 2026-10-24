/**
 * The ③ publish body (problem B, B-2) — on ticket_ready, publish the integration branch + create a PR.
 *
 * design v1 §2 / §4.4. Upholds the loose coupling "the core does not publish" and talks to the core
 * via the board:
 *   - read: read_board(kind='ticket_ready' | 'pr_opened') / read_ticket / list_tasks(ticket_id)
 *   - write: post_board(kind='pr_opened', ref_ticket_id)  ← the source of truth for idempotency
 *
 * Idempotency (§3 point 5, do not create duplicate PRs) is layered:
 *   1. board diff: skip tickets that already have pr_opened.
 *   2. findPrByHead before openPr: pick up an existing PR and do not create one even if the board lacks it (crash resilience).
 *   3. the pr_opened post happens after the PR is created successfully (after the URL/number is confirmed).
 *
 * publisher assumes the same host and same repo path as the worker (§3 point 9). The integration
 * branch's entity exists only locally on the host that created it, so an integration branch that
 * does not exist locally is skipped without pushing.
 *
 * The per-ticket advisory lock (acquire_publish_lock/release_publish_lock) is a front-stage
 * concurrency mechanism that blocks the read→act race where two processes pick up the same ticket at
 * once; it does not replace the above 3 idempotency layers (lock + the 3 layers together prevent
 * duplicate PRs).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LockageClient } from './client.js';
import { PublishNoDiffError, type PublishAdapter } from './publish-adapter.js';
import { isTerminalTaskStatus } from '../lockage/task-status.js';
// The board is a cumulative log (reconciled rows remain too), so at the default limit=100 (seq
// ascending = the oldest 100) the latest ticket_ready falls out of the window in proportion to
// operation time. The publisher reads the same reference range (all) as the observation tool
// computePublisherStatus, so it does not miss the latest ticket_ready re-emitted by re-arming within
// a 100-item window. Both the observation and execution paths share the same constant
// BOARD_READ_ALL_LIMIT.
import { BOARD_READ_ALL_LIMIT } from '../lockage/board.js';

/** The ticket returned by read_ticket (the minimal fields problem B references). */
interface TicketView {
  id: string;
  title: string;
  body: string | null;
  integration_branch: string | null;
  ticket_ready_at: number | null;
}

/** The task returned by list_tasks (the minimal fields used in the PR body list). */
interface TaskView {
  id: string;
  title: string;
  ticket_id: string | null;
}

/** The task used in reconcile's unfinished-task guard (the minimal fields that look at status). */
interface TaskView2 {
  id: string;
  status: string;
}

/** board_messages (the return of read_board). */
interface BoardMsg {
  seq: number;
  kind: string;
  ref_ticket_id: string | null;
  body: string;
}

/** The processing result of one ticket (for logs/tests). */
export type PublishOutcome =
  | { ticketId: string; result: 'published'; prNumber: number; url: string }
  | { ticketId: string; result: 'already_opened' | 'existing_pr'; prNumber?: number; url?: string }
  // Fix option A: when ticket_ready is re-emitted for a ticket that already has pr_opened (= B was
  // added by re-arming), update the PR by follow-up pushing the existing PR's integration branch
  // (does not call openPr).
  | { ticketId: string; result: 'updated'; branch: string }
  // 'locked': another process holds the per-ticket advisory lock, so this run skipped processing.
  | { ticketId: string; result: 'skipped'; reason: 'no_branch' | 'branch_not_local' | 'no_diff' | 'locked' }
  | { ticketId: string; result: 'failed'; error: string };

export interface PublishArgs {
  /** Absolute path to the local repo where the integration branch exists. */
  repoPath: string;
  /** The PR base branch. If omitted, the caller (CLI) resolves it via resolveBaseBranch and passes it. */
  base: string;
  /** The publisher's agent_id (the author of pr_opened). */
  agentId: string;
  /** Process only this ticket (manual/test). Omit to process all unprocessed ticket_ready. */
  onlyTicket?: string;
  /** Whether the integration branch exists locally (§3 point 9). For test substitution. Default = git show-ref. */
  localBranchExists?: (repoPath: string, branch: string) => boolean;
}

/** Whether the branch (refs/heads/<branch>) exists locally. */
function defaultLocalBranchExists(repoPath: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Build the PR body (§3 point 7; Phase 1 omits Closes = recommended scope D-B2). */
export function renderPrBody(ticket: TicketView, tasks: TaskView[]): string {
  const lines: string[] = [];
  if (ticket.body && ticket.body.trim()) lines.push(ticket.body.trim(), '');
  lines.push('## Tasks included in this PR');
  if (tasks.length === 0) {
    lines.push('- (none)');
  } else {
    for (const t of tasks) lines.push(`- ${t.title} (${t.id})`);
  }
  lines.push('', '---', `integration branch: ${ticket.integration_branch ?? '(unknown)'}`, `lockage ticket: ${ticket.id}`);
  return lines.join('\n') + '\n';
}

/** Write the PR body to a temp file and return {path, dir} (the caller rm's dir). */
function writeBodyTmp(body: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(process.env.KIROCREW_SCRATCH ?? tmpdir(), 'lockage-prbody-'));
  const path = join(dir, 'body.md');
  writeFileSync(path, body, 'utf8');
  return { path, dir };
}

/**
 * Publish unprocessed ticket_ready (the implementation of the §4.4 pseudocode).
 * With board's pr_opened as the source of truth, skip tickets that already have a PR.
 * @returns the processing result of each ticket (for logs/tests).
 */
export async function publishReadyTickets(
  client: LockageClient,
  adapter: PublishAdapter,
  args: PublishArgs,
): Promise<PublishOutcome[]> {
  const localExists = args.localBranchExists ?? defaultLocalBranchExists;

  // Read all board entries (the same reference range as computePublisherStatus). A limited limit would miss the latest ticket_ready.
  const ready = (await client.callTool('read_board', {
    kind: 'ticket_ready',
    limit: BOARD_READ_ALL_LIMIT,
  })) as {
    messages: BoardMsg[];
  };
  const opened = (await client.callTool('read_board', {
    kind: 'pr_opened',
    limit: BOARD_READ_ALL_LIMIT,
  })) as {
    messages: BoardMsg[];
  };
  // Trace of a successful follow-up push (pr_updated). Used as max(pr_opened, pr_updated) in the ticket_ready seq comparison.
  const updated = (await client.callTool('read_board', {
    kind: 'pr_updated',
    limit: BOARD_READ_ALL_LIMIT,
  })) as {
    messages: BoardMsg[];
  };
  // The set of tickets already pr_merged (after a merge there is no integration branch and a follow-up push is impossible). Not entered into the update path.
  const merged = (await client.callTool('read_board', {
    kind: 'pr_merged',
    limit: BOARD_READ_ALL_LIMIT,
  })) as {
    messages: BoardMsg[];
  };
  const openedTicketIds = new Set(
    opened.messages.map((m) => m.ref_ticket_id).filter((x): x is string => !!x),
  );
  const mergedTicketIds = new Set(
    merged.messages.map((m) => m.ref_ticket_id).filter((x): x is string => !!x),
  );
  // Fix option A + this fix: keep the "latest pr_opened seq", "latest pr_updated seq", and "latest
  // ticket_ready seq" per ticket. If ticket_ready is after max(pr_opened, pr_updated) (larger seq),
  // it is a new ready re-emitted by re-arming that has not yet been follow-up pushed, so update the
  // existing PR with a follow-up push. Otherwise (= a mere re-run / already follow-up pushed), skip
  // with already_opened as before. By leaving pr_updated on a successful follow-up push, the
  // decision matches computePublisherStatus's pending_update and the same push is not redone each time.
  const latestOpenedSeq = latestSeqByTicket(opened.messages);
  const latestUpdatedSeq = latestSeqByTicket(updated.messages);
  const latestReadySeq = latestSeqByTicket(ready.messages);
  // The seq last reflected into the PR = max(latest pr_opened, latest pr_updated).
  const latestPrSeq = (id: string): number =>
    Math.max(latestOpenedSeq.get(id) ?? 0, latestUpdatedSeq.get(id) ?? 0);

  const outcomes: PublishOutcome[] = [];
  // Process each ticket only once even if multiple ticket_ready arrive for it (problem A is idempotent, but a double safeguard).
  const handled = new Set<string>();

  for (const msg of ready.messages) {
    const ticketId = msg.ref_ticket_id;
    if (!ticketId) continue; // §3 point 10/D-B7: do not parse the body; reference only ref_ticket_id
    if (args.onlyTicket && ticketId !== args.onlyTicket) continue;
    if (handled.has(ticketId)) continue;
    handled.add(ticketId);

    // Acquire the per-ticket advisory lock. If another process is processing the same ticket (holding
    // the lock), fold this ticket into skipped(reason:'locked') to avoid the read→act race and move
    // to the next ticket (other tickets are not blocked, so the batch continues). The existing 3
    // idempotency layers are preserved behind this front-stage lock.
    const lock = (await client.callTool('acquire_publish_lock', { ticket_id: ticketId })) as
      | { ok: true; holder: string }
      | { ok: false };
    if (!lock.ok) {
      outcomes.push({ ticketId, result: 'skipped', reason: 'locked' });
      continue;
    }

    // Catch per ticket: so that one ticket's publish failure (gh error, etc.) does not crash the whole batch.
    try {
      // C (TOCTOU fix): the openedTicketIds set is a one-time snapshot taken at the top of this
      // function, before any per-ticket lock was acquired. Two concurrent publisher processes can
      // both snapshot "pr_opened is empty" and both decide to create a new PR, so the lock alone
      // does not prevent duplicate PRs when the lock windows do not overlap (A acquires → releases →
      // B acquires). To close that read→act race, re-read pr_opened *while holding the lock* and
      // refresh both openedTicketIds and this ticket's latestOpenedSeq. read_board is a live SQL read
      // of the shared file DB, so a pr_opened committed by another process (via post_board) is
      // observed here deterministically.
      // Only pr_opened is re-read: it is the sole idempotency source for duplicate-publish
      // prevention, AND — by also refreshing latestOpenedSeq from the same re-read — it is enough to
      // make the lost-race loser converge cleanly to already_opened. pr_updated/pr_merged/ticket_ready
      // drive the re-arm follow-up path and are a separate axis from concurrent duplicate publish, so
      // they are not re-read (no new board kind is introduced; the opened-seq is simply picked up from
      // the pr_opened messages already fetched here).
      // Why also refresh the seq: the openedTicketIds branch below computes
      // reEmitted = latestReadySeq > max(latestOpenedSeq, latestUpdatedSeq). If only the set were
      // refreshed, the loser's stale latestOpenedSeq === 0 would make reEmitted true, so it would do a
      // real pushBranch + post pr_updated — no duplicate PR, but a spurious follow-up push and a
      // pr_updated board entry that does not correspond to any real re-arm (it pollutes the board as a
      // source of truth, e.g. computePublisherStatus's pending_update). Refreshing latestOpenedSeq to
      // the committed pr_opened seq makes reEmitted false, so the loser ends in already_opened without
      // the spurious push. In a single process nothing posts pr_opened during the lock window, so this
      // re-read returns the top snapshot unchanged (no-op). The existing findPrByHead check before
      // openPr is still kept as another defense layer.
      if (!openedTicketIds.has(ticketId)) {
        const reopened = (await client.callTool('read_board', {
          kind: 'pr_opened',
          limit: BOARD_READ_ALL_LIMIT,
        })) as { messages: BoardMsg[] };
        let reopenedSeq = 0;
        for (const m of reopened.messages) {
          if (m.ref_ticket_id === ticketId && m.seq > reopenedSeq) reopenedSeq = m.seq;
        }
        if (reopenedSeq > 0) {
          openedTicketIds.add(ticketId);
          // Fold the committed pr_opened seq into latestOpenedSeq so latestPrSeq(ticketId) reflects
          // it and reEmitted below evaluates false → the loser converges to already_opened (no
          // spurious follow-up push / pr_updated).
          if ((latestOpenedSeq.get(ticketId) ?? 0) < reopenedSeq) {
            latestOpenedSeq.set(ticketId, reopenedSeq);
          }
        }
      }

      // Fix option A: a ticket that already has pr_opened. When ticket_ready is re-emitted (= B was
      // added by re-arming), ticket_ready itself is a skip, but instead of "creating a new PR" we
      // "update the existing PR with a follow-up push of the integration branch". Since pr_opened
      // does not disappear even when ticket_ready is re-emitted, updating the PR by push is the
      // correct behavior (this chain = re-arm → re-emit → update existing PR is the core of the F2
      // fix). No force push: the integration branch is only derived from base and appended to, so a
      // normal push auto-updates the PR to follow. If the branch is missing / not local, fold into
      // already_opened as before.
      if (openedTicketIds.has(ticketId)) {
        // Already pr_merged = after merge. There is no integration branch and a follow-up push is
        // impossible, so do not enter the update path (previously it fell into already_opened via a
        // NULL integration_branch; here we make the intent explicit).
        if (mergedTicketIds.has(ticketId)) {
          outcomes.push({ ticketId, result: 'already_opened' }); // point 5-1: already merged (no follow-up push needed)
          continue;
        }
        // ticket_ready comes after max(pr_opened, pr_updated) (larger seq) = a new ready re-emitted
        // by re-arming that has not yet been follow-up pushed. Otherwise (a mere re-run / already
        // follow-up pushed) skip with already_opened as before (idempotent).
        const reEmitted = (latestReadySeq.get(ticketId) ?? 0) > latestPrSeq(ticketId);
        if (!reEmitted) {
          outcomes.push({ ticketId, result: 'already_opened' }); // point 5-1: already has a PR (no re-emit / already follow-up pushed)
          continue;
        }
        const res = (await client.callTool('read_ticket', { ticket_id: ticketId })) as {
          ticket: TicketView | null;
        };
        const branch = res.ticket?.integration_branch ?? null;
        if (!branch) {
          // The integration branch cannot be fetched (already NULL-reset, etc.) = a follow-up push is impossible. Already has a PR, so idempotent skip.
          outcomes.push({ ticketId, result: 'already_opened' }); // point 5-1: already has a PR (nothing to push)
          continue;
        }
        // §3 point 9: if the integration branch does not exist locally, a push is impossible. If we
        // decided it should be updated but silently fold into already_opened, the B we want to follow
        // is not reflected silently (silent skip). Align with the branch_not_local handling at new PR
        // creation and surface it with a distinguishable outcome.
        if (!localExists(args.repoPath, branch)) {
          outcomes.push({ ticketId, result: 'skipped', reason: 'branch_not_local' });
          continue;
        }
        await adapter.pushBranch(args.repoPath, branch); // update the existing PR with a follow-up push
        // Leave a trace of the successful follow-up push on the board. This makes max(pr_opened,
        // pr_updated)'s seq exceed ticket_ready, drops this ticket from computePublisherStatus's
        // pending_update, and avoids redoing the same push afterward. If the push fails we do not
        // reach here (we go to catch), so pr_updated is not left and it is re-evaluated as still
        // awaiting an update.
        await client.callTool('post_board', {
          agent_id: args.agentId,
          kind: 'pr_updated',
          ref_ticket_id: ticketId,
          body: `Updated the existing PR with a follow-up push (integration branch ${branch})`,
        });
        outcomes.push({ ticketId, result: 'updated', branch });
        continue;
      }

      const res = (await client.callTool('read_ticket', { ticket_id: ticketId })) as {
        ticket: TicketView | null;
      };
      const ticket = res.ticket;
      const branch = ticket?.integration_branch ?? null;
      if (!ticket || !branch) {
        outcomes.push({ ticketId, result: 'skipped', reason: 'no_branch' });
        continue;
      }

      // §3 point 9: an integration branch created on another host with no local entity cannot be pushed → skip
      if (!localExists(args.repoPath, branch)) {
        outcomes.push({ ticketId, result: 'skipped', reason: 'branch_not_local' });
        continue;
      }

      // point 5-2: detect an existing PR before openPr (do not create a duplicate even if the board lacks pr_opened)
      const existing = await adapter.findPrByHead(args.repoPath, branch);
      if (existing) {
        await client.callTool('post_board', {
          agent_id: args.agentId,
          kind: 'pr_opened',
          ref_ticket_id: ticketId,
          body: `PR #${existing.number} ${existing.url}`,
        });
        outcomes.push({ ticketId, result: 'existing_pr', prNumber: existing.number, url: existing.url });
        continue;
      }

      // push → create PR → post pr_opened after creation succeeds (point 5-3)
      await adapter.pushBranch(args.repoPath, branch);
      const tasksRes = (await client.callTool('list_tasks', { ticket_id: ticketId })) as
        | TaskView[]
        | { tasks: TaskView[] };
      const tasks = Array.isArray(tasksRes) ? tasksRes : tasksRes.tasks;
      const { path: bodyFile, dir: bodyDir } = writeBodyTmp(renderPrBody(ticket, tasks ?? []));
      let pr: { number: number; url: string };
      try {
        pr = await adapter.openPr({
          repo: args.repoPath,
          base: args.base,
          head: branch,
          title: ticket.title,
          bodyFile,
        });
      } finally {
        rmSync(bodyDir, { recursive: true, force: true });
      }
      await client.callTool('post_board', {
        agent_id: args.agentId,
        kind: 'pr_opened',
        ref_ticket_id: ticketId,
        body: `PR #${pr.number} ${pr.url}`,
      });
      outcomes.push({ ticketId, result: 'published', prNumber: pr.number, url: pr.url });
    } catch (e) {
      // No diff from base (empty aggregation / already merged) folds into skip (not an anomaly).
      if (e instanceof PublishNoDiffError) {
        outcomes.push({ ticketId, result: 'skipped', reason: 'no_diff' });
        continue;
      }
      // Anything else is recorded as a per-ticket failure and we continue to the next ticket (do not stop the batch).
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[publish] failed to publish ticket ${ticketId}: ${error}`);
      outcomes.push({ ticketId, result: 'failed', error });
    } finally {
      // Always release the lock (all of published/updated/existing_pr/already_opened/skipped/failed).
      // Delete only on holder match, so a lock stolen by another process on TTL expiry is not deleted by mistake.
      await client.callTool('release_publish_lock', { ticket_id: ticketId, holder: lock.holder });
    }
  }

  return outcomes;
}

/**
 * The post-merge close result of a ticket (reconcile's MERGED path).
 *   - 'closed'        : an open/in_progress ticket was flipped to closed.
 *   - 'already_closed': already closed (= do nothing).
 *   - 'not_found'     : close_ticket_on_merge could not fetch the ticket (rare, since read_ticket just ran).
 *
 * close is done via a dedicated path that does not bump the version (close_ticket_on_merge /
 * closeTicketOnMerge), so a version-CAS conflict cannot occur structurally (there is no conflict result).
 */
export type TicketCloseResult = 'closed' | 'already_closed' | 'not_found';

/** The per-ticket result of reconcileMergedPrs (for logs/tests). */
export type ReconcileOutcome =
  | {
    ticketId: string;
    prNumber: number;
    result: 'merged';
    branchDeleted: boolean;
    cleared: boolean;
    /** The result of closing the ticket after merge (fix: do not leave merged work open). */
    ticketClosed: TicketCloseResult;
    /** #32: number of done-task worktrees under the ticket that were released (successful removes). */
    worktreesReleased: number;
    /** Issue #45: number of claims tied to done / abandoned tasks under the ticket that were released. */
    claimsReleased: number;
  }
  | { ticketId: string; prNumber: number; result: 'still_open' }
  // Fix option A (B-loss guard): the PR is MERGED but an unfinished task remains under the ticket. A
  // B added later by re-arming is mid-way through being stacked onto the integration branch, so
  // deleting the branch would lose B. Skip deletion/NULL-reset/pr_merged and re-evaluate on the next run.
  | { ticketId: string; prNumber: number; result: 'skipped_unmerged_tasks' }
  | { ticketId: string; prNumber: number; result: 'failed'; error: string }
  // 'locked': another process holds the per-ticket advisory lock, so this run skipped the post-processing.
  // Issue #31:
  //   'other_repo'    : pr_opened 本文の owner/repo が --repo-path の identity と一致しない（別リポジトリの同番号 PR）、
  //                     または identity が照合不能（本文 URL から取れない / --repo-path の identity が取れない）＝安全側で skip。
  //   'head_mismatch' : PR は MERGED だが headRefName がチケットの統合ブランチと一致しない、または head 不明＝安全側で skip（二重防御）。
  | { ticketId: string; prNumber?: number; result: 'skipped'; reason: 'no_pr_number' | 'locked' | 'other_repo' | 'head_mismatch' };

/**
 * Fix option A: collect the latest seq per ticket from a group of board messages.
 * Used to compare ticket_ready / pr_opened seqs to decide "a ready re-emitted after PR creation".
 */
function latestSeqByTicket(messages: BoardMsg[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const msg of messages) {
    if (!msg.ref_ticket_id) continue;
    const prev = m.get(msg.ref_ticket_id) ?? 0;
    if (msg.seq > prev) m.set(msg.ref_ticket_id, msg.seq);
  }
  return m;
}

/** Extract the PR number from a `PR #<n> <url>`-format pr_opened body. null on failure. */
function parsePrNumber(body: string): number | null {
  const m = body.match(/^PR #(\d+)\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Issue #31 主防御: pr_opened 本文の PR URL から owner/repo を抽出する。
 * 本文は `PR #<n> https://github.com/<owner>/<repo>/pull/<n>` の形（publishReadyTickets が投稿）。
 * この owner/repo を --repo-path の identity（gh repo view --json nameWithOwner）と照合し、
 * 台帳を共有する別リポジトリの同番号 PR を reconcile 対象から除外する。
 * 抽出できなければ null（照合不能＝呼び出し側で安全側に倒す）。
 */
function parsePrRepoIdentity(body: string): string | null {
  // https://github.com/<owner>/<repo>/pull/<n> から <owner>/<repo> を取る。
  // host 配下の最初の 2 セグメントを owner/repo とみなす（.git 等は URL には付かない）。
  const m = body.match(/https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * Merge-detection cleanup (problem B, B-3, design v1 §3 point 6).
 * For tickets that are "pr_opened ∧ not pr_merged", check prState and, only for MERGED ones:
 *   ① delete the remote integration branch (deleteRemoteBranch)
 *   ② delete the local integration branch (git branch -D, best effort)
 *   ③ reset tickets.integration_branch to NULL (clear_integration_branch, with the expected_branch guard)
 *   ④' update tickets.status to closed (close_ticket_on_merge; a dedicated path that does not bump
 *      the version flips status one-way to closed = no version conflict. Does not leave merged work
 *      in list_tickets(status:"open"). Does nothing if already closed)
 *   ④ post pr_merged(ref_ticket_id) to the board ← this ticket is not re-processed afterward (the source of truth for idempotency)
 * The skipped_unmerged_tasks path (unfinished tasks remain) does not do ③④'④ (= the ticket is not closed).
 * It does not merge itself (that is a human/CI). No immediacy is needed = reclaim in bulk on the next run.
 */
export async function reconcileMergedPrs(
  client: LockageClient,
  adapter: PublishAdapter,
  args: {
    repoPath: string;
    agentId: string;
    onlyTicket?: string;
    /** Local branch deletion function (for test substitution). Default = git branch -D. */
    deleteLocalBranch?: (repoPath: string, branch: string) => boolean;
  },
): Promise<ReconcileOutcome[]> {
  const delLocal = args.deleteLocalBranch ?? defaultDeleteLocalBranch;

  // Read all board entries (the same reference range as computePublisherStatus). A limited limit would miss the latest pr_opened/pr_merged.
  const opened = (await client.callTool('read_board', {
    kind: 'pr_opened',
    limit: BOARD_READ_ALL_LIMIT,
  })) as {
    messages: BoardMsg[];
  };
  const merged = (await client.callTool('read_board', {
    kind: 'pr_merged',
    limit: BOARD_READ_ALL_LIMIT,
  })) as {
    messages: BoardMsg[];
  };
  const mergedTicketIds = new Set(
    merged.messages.map((m) => m.ref_ticket_id).filter((x): x is string => !!x),
  );

  // Issue #31 主防御: --repo-path が指す owner/repo（nameWithOwner）をループ外で一度だけ取得してキャッシュする。
  // best-effort（認証・ネットワーク失敗時は null）。null のときは「照合不能＝取り違えを防げない」ので、
  // 各チケットを other_repo として skip する（楽観的に処理を続けると別リポジトリの PR を誤処理する穴が残るため）。
  let repoIdentity: string | null = null;
  try {
    repoIdentity = await adapter.repoIdentity(args.repoPath);
  } catch (e) {
    console.error(
      `[reconcile] failed to resolve the repo identity for ${args.repoPath} (treat as unknown): ${errText(e)}`,
    );
    repoIdentity = null;
  }

  const outcomes: ReconcileOutcome[] = [];
  const handled = new Set<string>();

  for (const msg of opened.messages) {
    const ticketId = msg.ref_ticket_id;
    if (!ticketId) continue;
    if (args.onlyTicket && ticketId !== args.onlyTicket) continue;
    if (mergedTicketIds.has(ticketId)) continue; // already cleaned up (pr_merged present)
    if (handled.has(ticketId)) continue;
    handled.add(ticketId);

    // The same per-ticket advisory lock as publishReadyTickets. If another process is processing the
    // same ticket, avoid the read→act race and move to the next with skipped(reason:'locked') (other tickets are not blocked).
    const lock = (await client.callTool('acquire_publish_lock', { ticket_id: ticketId })) as
      | { ok: true; holder: string }
      | { ok: false };
    if (!lock.ok) {
      outcomes.push({ ticketId, result: 'skipped', reason: 'locked' });
      continue;
    }

    const prNumber = parsePrNumber(msg.body);
    if (prNumber == null) {
      outcomes.push({ ticketId, result: 'skipped', reason: 'no_pr_number' });
      // Release the lock before moving to the next ticket (always return a lock we acquired, even for no_pr_number).
      await client.callTool('release_publish_lock', { ticket_id: ticketId, holder: lock.holder });
      continue;
    }

    // Issue #31 主防御（リポジトリ照合）: pr_opened 本文 URL の owner/repo と --repo-path の identity を比較する。
    // 不一致なら「台帳を共有する別リポジトリの同番号 PR」なので、prState を問い合わせる前に other_repo で skip する
    // （誤って別リポジトリの PR を MERGED 判定して pr_merged 書き込み・closed 化・worktree/claim 解放まで走るのを防ぐ）。
    // 照合不能（本文 URL から owner/repo が取れない、または --repo-path の identity が取れない）ときも、
    // 取り違えを防げないので安全側で other_repo として skip する（従来どおり処理を続けると穴が残るため）。
    const bodyIdentity = parsePrRepoIdentity(msg.body);
    if (repoIdentity == null || bodyIdentity == null || bodyIdentity !== repoIdentity) {
      outcomes.push({ ticketId, prNumber, result: 'skipped', reason: 'other_repo' });
      await client.callTool('release_publish_lock', { ticket_id: ticketId, holder: lock.holder });
      continue;
    }

    try {
      // Issue #31 二重防御（head 照合）: state と head ブランチ名を同時に取得する。
      const prView = await adapter.prView(args.repoPath, prNumber);
      const state = prView.state;
      if (state !== 'MERGED') {
        outcomes.push({ ticketId, prNumber, result: 'still_open' });
        continue;
      }

      // The integration branch name and the current status/version are fetched from the ticket (they are not in the pr_opened body).
      // Issue #31: head 照合のため MERGED 判定直後（タスクガードの前）に read_ticket を前倒しで取得する。
      const res = (await client.callTool('read_ticket', { ticket_id: ticketId })) as {
        ticket: TicketView | null;
      };
      const branch = res.ticket?.integration_branch ?? null;

      // Issue #31 二重防御: PR の headRefName がチケットの統合ブランチ（lockage/ticket/<short-id>）と一致するかを確認する。
      // 一致しない、または headRefName が取得できず不明なときは、後処理（pr_merged 書き込み・closed 化・ブランチ削除・
      // worktree/claim 解放）を一切行わず head_mismatch で skip する（安全側に倒す）。
      // 現状 branch は統合ブランチ NULL リセット後なら null になりうるが、その場合も照合不能として skip する。
      if (branch == null || prView.headRefName == null || prView.headRefName !== branch) {
        outcomes.push({ ticketId, prNumber, result: 'skipped', reason: 'head_mismatch' });
        continue;
      }

      // Fix option A (B-loss guard): even if the PR is MERGED, protect the integration branch if an
      // unfinished task remains under the ticket. If A's PR is merged while a B added later by
      // re-arming is still mid-way being stacked onto the integration branch, deleting the branch /
      // NULL-resetting integration_branch would wipe out B entirely (data loss). Use "whether an
      // unfinished task exists" as the criterion (whether or not re-arming has reset ticket_ready_at
      // to NULL, protecting the branch as long as an unfinished task exists is the safe side). If one
      // remains, do no deletion/NULL-reset/pr_merged at all; skip and re-evaluate on the next run.
      const tasksRes = (await client.callTool('list_tasks', { ticket_id: ticketId })) as
        | TaskView2[]
        | { tasks: TaskView2[] };
      const tasks = Array.isArray(tasksRes) ? tasksRes : (tasksRes.tasks ?? []);
      // Issue #7: abandoned は終端状態（これ以上作業しない）なので未完了に数えない。
      // 終端状態（'done','abandoned'）でないタスクが残っている場合のみ B-loss ガードで skip する。
      // 判定は task-status.ts の共通ヘルパーを使う（TaskView2.status は string 型）。
      if (tasks.some((t) => !isTerminalTaskStatus(t.status))) {
        outcomes.push({ ticketId, prNumber, result: 'skipped_unmerged_tasks' });
        continue;
      }

      // Issue #31: branch（統合ブランチ名）は head 照合のため既に上で read_ticket から取得済み。
      // ここに到達した時点で branch は non-null（head_mismatch ガードで null は弾いている）。
      let branchDeleted = false;
      if (branch) {
        // ① remote deletion (may fail if GitHub's auto-delete already removed it = swallow and log)
        try {
          await adapter.deleteRemoteBranch(args.repoPath, branch);
        } catch (e) {
          console.error(
            `[reconcile] failed to delete the remote branch (may already be deleted) ${branch}: ${errText(e)}`,
          );
        }
        // ② local deletion (best effort)
        branchDeleted = delLocal(args.repoPath, branch);
      }

      // ③ reset integration_branch to NULL (the expected_branch guard avoids wrongly deleting a re-aggregated new branch)
      let cleared = false;
      if (branch) {
        const cr = (await client.callTool('clear_integration_branch', {
          ticket_id: ticketId,
          expected_branch: branch,
        })) as { ok: boolean; cleared?: boolean };
        cleared = !!cr.cleared;
      }

      // ④' set the ticket to closed (do not leave merged work in list_tickets(status:"open")).
      //    A dedicated path that does not bump the version (close_ticket_on_merge) flips status
      //    one-way to closed. A version conflict cannot occur structurally (no conflict retry needed).
      //    Does nothing if already closed. The skipped_unmerged_tasks path does not reach here (= in that case it is not closed).
      const ticketClosed = await closeTicketAfterMerge(client, ticketId);

      // ④ record pr_merged (this ticket is dropped from reconcile targets afterward = idempotent)
      await client.callTool('post_board', {
        agent_id: args.agentId,
        kind: 'pr_merged',
        ref_ticket_id: ticketId,
        body: `PR #${prNumber} merged`,
      });

      // ⑤ #32 option 1: this is after passing the skipped_unmerged_tasks guard (= all tasks done, PR
      //    merged), so all the work is in the default branch. Release the done-task worktrees under
      //    the ticket (keep_branch defaults to false, so task branches are tidied too). A worktree
      //    with uncommitted changes is not released and stays active per FEAT-002/#33 (does not become orphaned).
      //    Call it loosely coupled via client.callTool rather than importing the core directly (§design separation).
      //    A worktree-release failure is swallowed best-effort and does not crash the whole per-ticket
      //    post-processing (pr_merged is already posted, so it is idempotent; even if re-processed,
      //    release_ticket_worktrees is idempotent on the presence of active rows = no double release).
      let worktreesReleased = 0;
      try {
        const rel = (await client.callTool('release_ticket_worktrees', {
          ticket_id: ticketId,
          repo_path: args.repoPath,
        })) as { removed_count?: number };
        worktreesReleased = rel.removed_count ?? 0;
      } catch (e) {
        console.error(
          `[reconcile] failed to release worktrees for ticket ${ticketId} (post-processing continues): ${errText(e)}`,
        );
      }

      // ⑥ Issue #45: with the same idea as worktrees, also reclaim active claims tied to done /
      //    abandoned tasks under the ticket (the claim version of the #32 worktree pattern). Tidy up
      //    here tasks that ended without going through task_done / release_task, or leftovers from
      //    before item 1 was introduced. Like worktree release, it is a loosely coupled call via
      //    client.callTool, and failures are swallowed best-effort so the whole post-processing does
      //    not crash (idempotent on the presence of active rows = no double release).
      let claimsReleased = 0;
      try {
        const relClaims = (await client.callTool('release_ticket_claims', {
          ticket_id: ticketId,
        })) as { released_count?: number };
        claimsReleased = relClaims.released_count ?? 0;
      } catch (e) {
        console.error(
          `[reconcile] failed to release claims for ticket ${ticketId} (post-processing continues): ${errText(e)}`,
        );
      }

      outcomes.push({
        ticketId,
        prNumber,
        result: 'merged',
        branchDeleted,
        cleared,
        ticketClosed,
        worktreesReleased,
        claimsReleased,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[reconcile] failed to post-process ticket ${ticketId}: ${error}`);
      outcomes.push({ ticketId, prNumber, result: 'failed', error });
    } finally {
      // Always release the lock (all of merged/still_open/skipped_unmerged_tasks/failed).
      await client.callTool('release_publish_lock', { ticket_id: ticketId, holder: lock.holder });
    }
  }

  return outcomes;
}

/**
 * Set the ticket to closed after merge (called only from reconcile's MERGED path).
 *
 * close is done via the dedicated path close_ticket_on_merge (the core's closeTicketOnMerge) that
 * does not bump the version. With the same idea as clearIntegrationBranch (D-B1), it aligns
 * reconcile's cleanup (integration_branch release / status close) symmetrically as "system
 * operations that do not bump the version". As a result:
 *   - A local CAS that flips status one-way to closed (WHERE status != 'closed'), so a version
 *     conflict cannot occur structurally (= no conflict retry). It also does not steal the version
 *     of a human/other agent's concurrent edit (body, etc.).
 *   - Does nothing if already closed (changes==0) → 'already_closed'.
 *   - A missing ticket is 'not_found' (rarely reached since reconcile just ran read_ticket).
 *
 * The source of truth for idempotency remains the pr_merged posted by the caller reconcile. Since
 * pr_merged is posted regardless of whether close succeeds, this ticket is dropped from reconcile
 * targets on the next run, and no double close/cleanup happens.
 */
export async function closeTicketAfterMerge(
  client: LockageClient,
  ticketId: string,
): Promise<TicketCloseResult> {
  const res = (await client.callTool('close_ticket_on_merge', { ticket_id: ticketId })) as
    | { ok: true; closed: boolean }
    | { ok: false; reason: 'not_found' };
  if (!res.ok) return 'not_found';
  return res.closed ? 'closed' : 'already_closed';
}

/** Delete the local integration branch (git branch -D). true if deleted, false if not. */
function defaultDeleteLocalBranch(repoPath: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'branch', '-D', branch], { stdio: 'ignore' });
    return true;
  } catch {
    return false; // already gone / another branch checked out, etc. Not essential to post-processing, so swallow
  }
}

/** Extract a short message from an exception (includes execFileSync's stderr/stdout). */
function errText(e: unknown): string {
  const err = e as { stderr?: Buffer | string; message?: string };
  return (err?.stderr?.toString() || err?.message || String(e)).trim();
}
