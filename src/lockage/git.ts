import { execFileSync } from 'node:child_process';

/**
 * A thin wrapper that runs a git command repo-scoped (`git -C <repo>`).
 * Because of the multi-repo assumption (§3: tasks.repo is required), worktree assignment, the merge
 * gate, and the 3-way precheck all run in this `git -C <repo>` scope.
 *
 * @returns the trimmed stdout string.
 * @throws  execFileSync throws on a non-zero exit (caught by the caller).
 *
 * HIGH-2 mitigation: expand maxBuffer from the default (1MB) to 64MB. For many-file changes,
 * `diff --name-only` / `merge-tree --write-tree` / `show --name-only` throwing ENOBUFS past 1MB
 * would (a) permanently stall the merge gate if via threeWayPrecheck, and (b) make gitConflictFiles'
 * catch misparse the truncated stdout. With a sufficient buffer, this throw does not occur for
 * realistic inputs.
 */
export function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/**
 * An internal helper that runs a git command repo-scoped and returns stdout raw without trimming.
 *
 * Normally the trimming `git()` is enough, but when the output itself is meaningful — as with
 * `git status --porcelain -z` (NUL-separated, a fixed-width 2-char status + space at the head, with
 * a trailing NUL) — trimming would strip the leading space of a "worktree-only change ( M path)"
 * line or the trailing NUL and shift parsing. Use this function only on paths that handle raw -z output.
 *
 * @returns the raw, untrimmed stdout string.
 * @throws  execFileSync throws on a non-zero exit (caught by the caller).
 */
function gitRaw(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Resolve the repo's main branch name (§4.6).
 * Rather than hardcoding `main`, allow `dev`/`stg`/`master` etc. per repo.
 *
 * Phase 1 default policy: explicit value > the first of `dev`/`stg`/`main`/`master` that exists in
 * the repo > `main`.
 * (Leaves room to replace with a repo_config table in Phase 2, but for now it is inferred from
 * existing branches.)
 */
export function resolveBaseBranch(repoPath: string, explicit?: string): string {
  if (explicit) return explicit;
  for (const cand of ['dev', 'stg', 'main', 'master']) {
    try {
      git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${cand}`]);
      return cand;
    } catch {
      /* to the next candidate */
    }
  }
  // Fallback when none of the candidates exist. The head of the search order is `dev`, but returning
  // a nonexistent `dev` would make subsequent git operations fail for sure, so keep `main` as the
  // conventional name most likely to exist.
  return 'main';
}

/**
 * A best-effort helper that resolves a ref (branch name/tag/commit, etc.) to an existing commit SHA.
 *
 * Using `git rev-parse --verify <ref>^{commit}`, it verifies that "the ref exists and reaches a
 * commit" while folding to a 40-char SHA. Used to record the fork-point SHA at worktree assignment
 * (to later compute the diff from base `git diff --name-only <base_sha>...HEAD`).
 *
 * Like the existing resolveBaseBranch, a best-effort policy that swallows failures: when it cannot
 * resolve (ref absent, empty repo, before the initial commit, etc.), it returns null instead of
 * throwing. The caller is designed to save base_sha as NULL when null, and the diff side falls back
 * to status only when base_sha is absent.
 */
export function resolveRefSha(repoPath: string, ref: string): string | null {
  try {
    return git(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

/**
 * best-effort ヘルパー: リポジトリに設定された remote 名を 1 つ決める（Issue #8）。
 *
 * `git remote` の出力から remote 名の一覧を取り、'origin' があれば 'origin' を優先して返す。
 * 'origin' が無ければ最初に列挙された remote 名を返す。remote が 1 つも無い場合（ローカルのみの
 * リポジトリ、Issue #8 の「リモートが無い環境」）は null を返す。
 *
 * 既存ヘルパー（resolveBaseBranch / resolveRefSha）と同じく best-effort で失敗を握りつぶす方針に
 * 揃える。git が失敗した場合（リポジトリでない等）も例外を投げず null を返す。
 */
export function resolveRemoteName(repoPath: string): string | null {
  let out: string;
  try {
    out = git(repoPath, ['remote']);
  } catch {
    return null;
  }
  const remotes = out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (remotes.length === 0) return null;
  if (remotes.includes('origin')) return 'origin';
  return remotes[0];
}

/**
 * best-effort ヘルパー: base ブランチをリモートから fetch する（Issue #8）。
 *
 * `git fetch <remote> <baseBranch>` を実行する。この形の fetch は FETCH_HEAD とリモート追跡 ref
 * `refs/remotes/<remote>/<baseBranch>` を更新するだけで、ローカルの `refs/heads/<baseBranch>` や
 * 作業ツリー・チェックアウト状態には一切触れない（本流を checkout しない運用を壊さない）。
 *
 * 成功時は true、失敗時（リモート不通・ブランチ不在・ネットワーク無し等）は false を返す。
 * best-effort 方針に従い例外は投げない。
 */
export function fetchBase(repoPath: string, remote: string, baseBranch: string): boolean {
  try {
    // refspec を明示せずブランチ名だけを渡すことで、ローカルの同名ブランチは更新せず、
    // FETCH_HEAD とリモート追跡 ref のみを更新する安全な fetch になる。
    git(repoPath, ['fetch', remote, baseBranch]);
    return true;
  } catch {
    return false;
  }
}

/**
 * best-effort ヘルパー: リモート追跡 ref が存在するか確認し、その ref 名を返す（Issue #8）。
 *
 * `refs/remotes/<remote>/<baseBranch>` を `git show-ref --verify --quiet` で確認し、存在すれば
 * `<remote>/<baseBranch>`（例 'origin/dev'）を返す。存在しなければ null。git 失敗時も null を返す。
 * best-effort 方針に従い例外は投げない。
 */
export function remoteTrackingRef(repoPath: string, remote: string, baseBranch: string): string | null {
  try {
    git(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${baseBranch}`]);
    return `${remote}/${baseBranch}`;
  } catch {
    return null;
  }
}

/**
 * best-effort ヘルパー: ローカル ref がリモート追跡 ref からいくつ遅れているかを数える（Issue #8 提案 2）。
 *
 * `git rev-list --count <localRef>..<remoteTrackingRef>` を実行し、remoteTrackingRef にあって
 * localRef に無いコミット数（＝ローカルがリモートから遅れている件数）を返す。
 * ref 解決不能・git 失敗・数値変換不能のときは null を返す。best-effort 方針に従い例外は投げない。
 */
export function countBehind(repoPath: string, localRef: string, remoteTrackingRef: string): number | null {
  try {
    const out = git(repoPath, ['rev-list', '--count', `${localRef}..${remoteTrackingRef}`]);
    const n = Number.parseInt(out.trim(), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

/**
 * A best-effort helper that lists a worktree's working-tree changed files (Issue #52 proposal 2).
 *
 * Runs `git status --porcelain -z` against worktreePath (same style as classifyRemoveFailure = take
 * git status against the worktree path) and extracts the changed file paths from each entry.
 *
 * Reasons for using `-z` (NUL-separated):
 *   - Each entry is terminated with NUL (\0) and the path is not quoted (normal `--porcelain` quotes
 *     and escapes paths containing spaces etc. with `"..."`, but -z emits them raw).
 *   - We do not trim the output, so there is no column shift from the leading space left in a
 *     "worktree-only change ( M path)" or the leading space of the 2nd+ entries (status can be
 *     stripped at a fixed width).
 * This way it does not break even with paths containing spaces or multiple ` M` (worktree-only) changes.
 *
 * The format of each porcelain v1 -z entry:
 *   - `XY <path>\0` (X=index state, Y=worktree state; the 3rd char is always a space, the path from
 *     the 4th char). Untracked is `?? <path>\0`.
 *   - A rename/copy (R/C) comes as 2 entries: `XY <new>\0<old>\0` (new first, old second). Take the
 *     new side, which is the current path, and skip the immediately following old entry (a raw path with no status).
 *
 * Like the other safe helpers, a best-effort that swallows failures: when git fails (not a repo,
 * etc.) it returns an empty array (dirty auto-compute is an auxiliary feature, so if it cannot be
 * obtained, err toward emitting nothing).
 */
export function workingTreeChangedFiles(worktreePath: string): string[] {
  let raw: string;
  try {
    raw = gitRaw(worktreePath, ['status', '--porcelain', '-z']);
  } catch {
    return [];
  }
  // Split on NUL. The trailing NUL appends an empty last element, so skip empty elements.
  const entries = raw.split('\0');
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length === 0) continue;
    // `XY <path>`: the first 2 chars are the XY status, the 3rd char is the separating space, the path from the 4th char.
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path.length > 0) out.push(path);
    // For a rename/copy (R/C), the old side follows as the next entry with no status. Skip it.
    if (status[0] === 'R' || status[0] === 'C') i++;
  }
  return out;
}

/**
 * A best-effort helper that lists committed diff files from the fork-point SHA (Issue #52 proposal 3).
 *
 * When baseSha is non-NULL, runs `git diff --name-only <baseSha>...HEAD` (3-dot = diff from the merge
 * base) against worktreePath and returns the changed file names. This also lets "changes committed in
 * the worktree but not yet in the working tree" be included in dirty (union with workingTreeChangedFiles).
 *
 * When baseSha is absent (an old row saved as NULL because FEAT-002 could not resolve it, an empty
 * repo, etc.) it returns an empty array and falls back to the working-tree state only. Like the other
 * safe helpers, it also returns an empty array on git failure.
 */
export function committedChangedFiles(
  worktreePath: string,
  baseSha: string | null | undefined,
): string[] {
  if (!baseSha) return [];
  let out: string;
  try {
    out = git(worktreePath, ['diff', '--name-only', `${baseSha}...HEAD`]);
  } catch {
    return [];
  }
  return out.split('\n').filter((l) => l.length > 0);
}

/**
 * Sanitization when embedding agent_id / ticket_id etc. into a worktree path or branch name.
 * Folds characters problematic for the FS/ref such as slashes and whitespace into '-'.
 */
export function safeSlug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Shortening of ulid/agent_id/ticket_id (for deterministic branch names).
 *
 * A ULID is 26 chars = the first 10 are a millisecond timestamp and the remaining 16 are a random
 * part. Using only the head would make the slugs of "2 IDs generated in the same millisecond"
 * collide, so distinct things fall into the same deterministic name (worktree path / ticket
 * integration branch name). To avoid this, add a few chars from the trailing random part to the head
 * (which keeps chronological sort order) to ensure uniqueness. Inputs of 16 chars or fewer (agent_id,
 * etc.) are not a collision source, so fold them as-is. Worktree assignment and the ticket
 * integration branch name share the same function, and the root fix (head 8 + tail 6) applies to both.
 */
export function short(s: string): string {
  const slug = safeSlug(s);
  if (slug.length <= 16) return slug.slice(0, 10);
  // Head 8 (time-derived, sortable) + tail 6 (random part, unique). A hyphen also keeps it readable.
  return `${slug.slice(0, 8)}-${slug.slice(-6)}`;
}
