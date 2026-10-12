/**
 * The ③ publish adapter (problem B, B-1) — abstracts integration-branch push and PR/MR operations
 * in a provider-independent way.
 *
 * design v1 §3 point 4 / §4.1. In line with NFR-11 (assumes GitHub/GitLab), it cuts a thin
 * abstraction in the same style as ToolAdapter. To uphold "the core does not publish"
 * (requirements-v1 §4.2), the publish/PR operations live here (the launcher), not in the core.
 *
 * - push / branch deletion are `git -C <repo>` scoped (reusing git() from src/lockage/git.ts).
 * - PR operations are delegated to the existing login of the forge CLI (gh / glab) (lockage does not
 *   handle tokens).
 * - Safety policy (lessons): push writes the branch name as a literal. No shell variable expansion
 *   or heredoc fusion. execFileSync passes argv directly, so it does not go through a shell and does
 *   not take a git-publish-floor shape.
 */
import { execFileSync } from 'node:child_process';
import { git } from '../lockage/git.js';

/** The PR/MR state (the forge-independent normalized form). */
export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

/** The minimal PR info returned by findPrByHead / openPr. */
export interface PrRef {
  number: number;
  state: PrState;
  url: string;
}

/**
 * Indicates that openPr could not create a PR because there is "no diff from base".
 * The caller (publishReadyTickets) folds this into a per-ticket skip (does not crash the loop).
 */
export class PublishNoDiffError extends Error {
  constructor(
    readonly head: string,
    readonly base: string,
  ) {
    super(`no commits between ${base} and ${head} (nothing to open a PR for)`);
    this.name = 'PublishNoDiffError';
  }
}

/** Extract the message string from an exception (execFileSync carries stdout/stderr). */
function errText(e: unknown): string {
  const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const parts = [err?.stderr?.toString(), err?.stdout?.toString(), err?.message];
  return parts.filter(Boolean).join('\n');
}

/**
 * Provider-independent publish operations. github=gh / gitlab=glab are handled through the same
 * interface. design v1 §3 point 4.
 */
export interface PublishAdapter {
  readonly id: 'github' | 'gitlab';

  /** Push the integration branch to the remote (a feature-branch push = not protected). */
  pushBranch(repo: string, branch: string): Promise<void>;

  /** Create a PR/MR and return the number and URL. The body goes via a tmp file (--body-file). */
  openPr(args: {
    repo: string;
    base: string;
    head: string;
    title: string;
    bodyFile: string;
  }): Promise<PrRef>;

  /**
   * ★ The key to idempotency (design v1 §3 point 5-2). Find an existing PR tied to the head branch.
   * Prevents double creation even if there is no pr_opened on the board (crash resilience). null if none.
   */
  findPrByHead(repo: string, branch: string): Promise<PrRef | null>;

  /** Look up the current state from the PR number (merge detection = the cleanup trigger). */
  prState(repo: string, number: number): Promise<PrState>;

  /** Delete the remote integration branch (post-merge cleanup). */
  deleteRemoteBranch(repo: string, branch: string): Promise<void>;
}

/** Normalize the raw gh/glab state string into a PrState. */
function normalizeState(raw: string): PrState {
  const s = raw.trim().toUpperCase();
  if (s === 'MERGED') return 'MERGED';
  if (s === 'CLOSED') return 'CLOSED';
  // OPEN / '' / unknown are treated as OPEN (safe side, since cleanup triggers only on MERGED).
  return 'OPEN';
}

/**
 * The GitHub implementation (Phase 1's first provider). Delegated to the gh CLI's existing login.
 * push / deletion use git(); PR operations use gh.
 */
export class GithubPublishAdapter implements PublishAdapter {
  readonly id = 'github' as const;

  /** Allow the gh executable to be swapped in tests/environments (default 'gh'). */
  constructor(private readonly ghCmd: string = 'gh') { }

  /** Run gh repo-scoped (resolving owner/repo from the CWD's origin remote). */
  private gh(repoPath: string, args: string[]): string {
    return execFileSync(this.ghCmd, args, {
      cwd: repoPath, // gh resolves owner/repo from the CWD's git remote
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  }

  async pushBranch(repo: string, branch: string): Promise<void> {
    // Branch name written as a literal. execFileSync passes argv directly, so it does not go through
    // shell expansion. On an existing-PR update (fix option A) this push makes the PR auto-follow too
    // (the integration branch is derived from base and only appended to, so it is a fast-forward and
    // does not need force).
    git(repo, ['push', 'origin', branch]);
  }

  async openPr(args: {
    repo: string;
    base: string;
    head: string;
    title: string;
    bodyFile: string;
  }): Promise<PrRef> {
    // On success, gh pr create returns the created PR's URL on a single stdout line.
    // On failure it exits non-zero and throws. Normalize the 2 cases hit in practice so the caller
    // can fold them:
    //   (a) a PR with the same head is already open (a race with findPrByHead) → return the existing PR (= idempotent)
    //   (b) no diff from base (empty aggregation / already merged) → throw PublishNoDiffError
    let url: string;
    try {
      url = this.gh(args.repo, [
        'pr',
        'create',
        '--base',
        args.base,
        '--head',
        args.head,
        '--title',
        args.title,
        '--body-file',
        args.bodyFile,
      ]);
    } catch (e) {
      const msg = errText(e);
      // (a) already exists: re-fetch and return the existing PR (do not create a duplicate)
      if (/already exists/i.test(msg)) {
        const existing = await this.findPrByHead(args.repo, args.head);
        if (existing) return existing;
      }
      // (b) no diff: distinguish with a dedicated error so it can be cleaned up / skipped
      if (/No commits between|No commits/i.test(msg)) {
        throw new PublishNoDiffError(args.head, args.base);
      }
      throw e; // anything else is unexpected; the caller (per-ticket try/catch) catches it per ticket
    }
    // Right after creation, re-fetch by head to confirm the number/state (absorbs forge differences where the number is not available from the URL alone).
    const created = await this.findPrByHead(args.repo, args.head);
    if (created) return created;
    // Fallback: pick up the number at the end of the URL (even if findPrByHead is empty, creation did succeed).
    const m = url.match(/\/(\d+)(?:[/?#].*)?$/);
    const number = m ? Number(m[1]) : 0;
    if (number === 0) {
      // Not getting a number is a sign of an anomaly (the URL is valid but findPrByHead is also empty). Warn instead of swallowing.
      console.error(`[publish] openPr: could not identify the PR number (head=${args.head}, url=${url})`);
    }
    return { number, state: 'OPEN', url };
  }

  async findPrByHead(repo: string, branch: string): Promise<PrRef | null> {
    // gh pr list --head <branch> --json number,state,url --state all --limit 1
    // --state all also picks up MERGED/CLOSED (idempotent = do not re-create even if already merged).
    // Note: --head matches the head *ref name*. In Phase 1 it is safe because it is the own
    //       repository and the integration branch name is ULID-derived and unique, but there is room
    //       for false positives with PRs from a fork or environments with same-named branches
    //       (if Phase 2 handles forks, the head owner must also be checked).
    const raw = this.gh(repo, [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'number,state,url',
      '--limit',
      '1',
    ]);
    if (!raw) return null;
    let arr: Array<{ number: number; state: string; url: string }>;
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const pr = arr[0];
    return { number: pr.number, state: normalizeState(pr.state), url: pr.url };
  }

  async prState(repo: string, number: number): Promise<PrState> {
    const raw = this.gh(repo, ['pr', 'view', String(number), '--json', 'state']);
    try {
      const obj = JSON.parse(raw) as { state?: string };
      return normalizeState(obj.state ?? '');
    } catch {
      return 'OPEN';
    }
  }

  async deleteRemoteBranch(repo: string, branch: string): Promise<void> {
    git(repo, ['push', 'origin', '--delete', branch]);
  }
}

/**
 * GitLab stub (not implemented in Phase 1; glab implementation in #4).
 * design v1 §3 point 4 / D-B4. Satisfies only the interface and fails explicitly if called.
 */
export class GitlabPublishAdapter implements PublishAdapter {
  readonly id = 'gitlab' as const;

  private notImplemented(): never {
    throw new Error(
      'GitlabPublishAdapter is not implemented yet (Phase1=github only, see design D-B4 / issue #4)',
    );
  }

  async pushBranch(): Promise<void> {
    this.notImplemented();
  }
  async openPr(): Promise<PrRef> {
    this.notImplemented();
  }
  async findPrByHead(): Promise<PrRef | null> {
    this.notImplemented();
  }
  async prState(): Promise<PrState> {
    this.notImplemented();
  }
  async deleteRemoteBranch(): Promise<void> {
    this.notImplemented();
  }
}

/**
 * Determine the provider from the origin remote's URL (design v1 §3 point 4).
 * An explicit value takes precedence. github.com→github / gitlab→gitlab.
 */
export function detectProvider(repoPath: string, explicit?: 'github' | 'gitlab'): 'github' | 'gitlab' {
  if (explicit) return explicit;
  let url = '';
  try {
    url = git(repoPath, ['remote', 'get-url', 'origin']);
  } catch {
    return 'github'; // when the remote is unknown, default to github (Phase 1's first provider)
  }
  // Decide on the host part only (so a github repo whose path contains 'gitlab' is not misfired).
  // Supported forms: git@gitlab.com:org/repo.git / https://gitlab.example.com/org/repo(.git) / ssh://git@gitlab…/…
  const host = extractHost(url);
  if (/gitlab/i.test(host)) return 'gitlab';
  return 'github';
}

/** Extract the host part from a remote URL (scp-like / https / ssh). Empty string on failure. */
function extractHost(url: string): string {
  // scp-like: git@host:org/repo.git
  const scp = url.match(/^[^/@]+@([^:/]+):/);
  if (scp) return scp[1];
  // URL-like: scheme://[user@]host[:port]/...
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^:/]+)/i);
  if (m) return m[1];
  return '';
}

/** Create a PublishAdapter from the provider. */
export function makePublishAdapter(
  provider: 'github' | 'gitlab',
  opts?: { ghCmd?: string },
): PublishAdapter {
  if (provider === 'gitlab') return new GitlabPublishAdapter();
  return new GithubPublishAdapter(opts?.ghCmd);
}
