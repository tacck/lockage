/**
 * Repository and lockage state decisions shared by the hooks.
 *
 * Each client's adapter (claude / antigravity / kiro) calls this pure logic and only handles the
 * input/output fitting (the adapters themselves are in clients.ts).
 *
 * Since a hook does not stop the work even if it fails, git uses a swallowing wrapper (git() below)
 * that returns null for non-zero exit, timeout, or being outside git. The git in src/lockage/git.ts
 * is throw-based and serves a different purpose, so it is not reused here.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// Per-git-call limit. We call git at most 3 times per repository (twice in repoState, once in
// inUse), so keep the total under the hook timeout (10 seconds).
const GIT_TIMEOUT_MS = 2000;

/**
 * Repository state.
 * in_use calls git, so it is split into the inUse(state) function to keep the policy of calling it
 * only when needed.
 */
export interface RepoState {
  // Root of the main repository (the main working tree). The value to pass as lockage's repo_path.
  // It cannot be derived from inside a worktree of a --separate-git-dir or bare layout, so it is null then
  mainRoot: string | null;
  // Root of the working tree containing the path used for the decision
  toplevel: string;
  // Whether toplevel is a working tree created by git worktree add
  isLinked: boolean;
  // Output of git worktree list --porcelain. Used for the inUse decision
  worktreeList: string;
}

/**
 * Since a hook does not stop the work even if it fails, leave a clue on stderr when it silently
 * becomes a no-op. Emits `[lockage-plugin] ...`.
 */
export function log(msg: string): void {
  process.stderr.write(`[lockage-plugin] ${msg}\n`);
}

/**
 * The hook-only swallowing git wrapper. Runs `git -C <cwd> <args...>` and returns null for all of
 * non-zero exit, timeout, and being outside git.
 *
 * execFileSync throws on both non-zero exit and timeout, so catch with try/catch.
 * Log to stderr only on timeout (error.code === 'ETIMEDOUT' or error.killed).
 */
function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { code?: string; killed?: boolean };
    if (err.code === 'ETIMEDOUT' || err.killed) {
      log(`git ${args[0]} did not finish within ${GIT_TIMEOUT_MS / 1000} seconds: ${cwd}`);
    }
    return null;
  }
}

/**
 * Walk up to the nearest existing parent directory.
 * A file newly created via Write may not even have its parent directory yet. Returns null if it reaches the root.
 */
function nearestExistingDir(path: string): string | null {
  let d = isDir(path) ? path : dirname(path);
  while (d && !isDir(d)) {
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  return d || null;
}

/** Whether path is an existing directory (statSync throws on a nonexistent path, so swallow it). */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * realpathSync may throw on a nonexistent path. We want to return a nonexistent path as-is, so if it
 * throws, return the original path.
 */
function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Return the main working tree. null if it cannot be derived.
 *
 * The head of the worktree list points to the main working tree. However, in a --separate-git-dir
 * layout git itself does not remember the main working tree, and the .git entity (gitdir) appears at
 * the head. A bare repo has no working tree.
 *
 * The "bare check" is done by exact-match membership against the line list. It is not a substring,
 * so a worktree path containing the string bare is not misjudged.
 */
function mainWorktree(worktreeList: string, toplevel: string, isLinked: boolean): string | null {
  // Split the first block (up to the first blank line) into lines.
  const firstBlock = worktreeList.split('\n\n', 1)[0];
  const first = firstBlock.length === 0 ? [] : firstBlock.split('\n');
  if (first.length > 0 && first[0].startsWith('worktree ') && !first.includes('bare')) {
    const candidate = first[0].slice('worktree '.length);
    if (existsSync(join(candidate, '.git'))) {
      return candidate;
    }
  }
  // If we are inside the main working tree, that is the main repo
  return isLinked ? null : toplevel;
}

/**
 * Whether there is evidence that lockage has been used in this repository.
 * It calls git, so call it only when needed (the guard does not look for edits inside a worktree).
 */
function lockageInUse(toplevel: string, mainRoot: string | null, worktreeList: string): boolean {
  // Among the traces, look first at the one that survives worktree release (reconcile).
  // release_worktree does not delete branches by default, so branches under lockage/ remain the longest
  const refs = git(toplevel, 'for-each-ref', '--count=1', '--format=x', 'refs/heads/lockage/');
  if (refs) return true;
  // assign_worktree digs a worktree under <repo parent>/.lockage-worktrees/
  if (worktreeList.includes('/.lockage-worktrees/')) return true;
  // Treat a .lockage/ directly under the main working tree as a supplementary trace.
  // The .lockage/ in the home directory is where lockage's ledger DB lives, so do not count it.
  if (mainRoot === null || realpathSafe(mainRoot) === realpathSafe(homedir())) {
    return false;
  }
  return isDir(join(mainRoot, '.lockage'));
}

/**
 * Return whether the state has lockage operation traces.
 * It calls git, so it is factored into a function to preserve the optimization where the caller
 * (mainTreeRoot) looks at isLinked first and does not call it when unnecessary.
 */
export function inUse(state: RepoState): boolean {
  return lockageInUse(state.toplevel, state.mainRoot, state.worktreeList);
}

/**
 * Derive the state of the repository containing path. null if it cannot be determined, e.g. outside a git repository.
 */
export function repoState(path: string): RepoState | null {
  const d = nearestExistingDir(resolve(path));
  if (d === null) return null;
  const out = git(
    d,
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-dir',
    '--git-common-dir',
  );
  if (out === null) return null; // outside a git repository
  if (out.startsWith('--')) {
    // git before 2.31 does not know --path-format and, instead of erroring, prints it as-is and
    // succeeds. The subsequent lines shift by one and return wrong paths, so give up the decision here
    log(`git rev-parse did not interpret --path-format (possibly git before 2.31): ${d}`);
    return null;
  }
  const lines = out.split('\n').filter((_, i, arr) => i < arr.length - 1 || arr[i].length > 0);
  if (lines.length < 3) return null; // no working tree, e.g. inside a bare repository
  const [toplevel, gitDir, commonDir] = lines;

  // Do not use commonDir's parent directory: in submodule, --separate-git-dir, or bare + worktree
  // layouts it does not point to the main repo
  const isLinked = realpathSafe(gitDir) !== realpathSafe(commonDir);
  const worktreeList = git(toplevel, 'worktree', 'list', '--porcelain') ?? '';
  const mainRoot = mainWorktree(worktreeList, toplevel, isLinked);

  return { mainRoot, toplevel, isLinked, worktreeList };
}

/**
 * If path is inside the main working tree of a repository operating under lockage, return that main repo's path.
 */
export function mainTreeRoot(path: string, cwd?: string): string | null {
  const abs = isAbsolute(path) ? path : join(cwd ?? process.cwd(), path);
  const st = repoState(abs);
  // Look at isLinked first. For edits inside a worktree (the most common path) this skips the inUse git call
  if (st === null || st.isLinked || !inUse(st)) {
    return null;
  }
  return st.mainRoot;
}
