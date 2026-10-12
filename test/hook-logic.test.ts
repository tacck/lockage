/**
 * Unit tests for the hook pure logic (src/hook/repo.ts / context.ts / guard.ts).
 *
 * Equivalently reproduces the behavior verified by the port source Python tests (equivalent to
 * test/claude-plugin/test_hooks.py's RepoStateTest / GuardTest / SessionStartTest). Build temporary git
 * repositories with execFileSync('git', ...) (operating under lockage = has a lockage/ branch / not
 * operating / worktree / outside git) and divert LOCKAGE_GUARD_STATE_DIR to a temporary location.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inUse, mainTreeRoot, repoState } from '../src/hook/repo.ts';
import { DEFAULT_HEADER, buildContext } from '../src/hook/context.ts';
import { decide, record } from '../src/hook/guard.ts';

/** Fix the git environment so it does not depend on the user's global config. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8' });
}

/**
 * Create a temporary git repository (base/app). Returns cleanup.
 * base is realpathSync-resolved (absorbs macOS's /var → /private/var difference).
 */
function makeRepo(): { base: string; repo: string; cleanup: () => void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lockage-hook-test-')));
  const repo = join(base, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  return { base, repo, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Cut a lockage worktree (= make it operating). Returns the worktree path. */
function addLockageWorktree(base: string, repo: string, branch = 'lockage/claude-1/task'): string {
  const path = join(base, '.lockage-worktrees', 'app-claude-1-task');
  git(repo, 'worktree', 'add', '-q', '-b', branch, path);
  return path;
}

// --- RepoState ---

test('a repository not using lockage is not operating', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const st = repoState(join(repo, 'a.txt'));
    assert.ok(st);
    assert.equal(st.mainRoot, repo);
    assert.equal(inUse(st), false);
    assert.equal(st.isLinked, false);
  } finally {
    cleanup();
  }
});

test('inside a lockage worktree it points to the main repo and is linked', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const wt = addLockageWorktree(base, repo);
    const st = repoState(join(wt, 'a.txt'));
    assert.ok(st);
    assert.equal(st.mainRoot, repo);
    assert.equal(st.toplevel, wt);
    assert.equal(st.isLinked, true);
    assert.equal(inUse(st), true);
  } finally {
    cleanup();
  }
});

test('even after releasing the worktree, it stays operating if the lockage branch remains', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const wt = addLockageWorktree(base, repo);
    git(repo, 'worktree', 'remove', wt);
    const st = repoState(repo);
    assert.ok(st);
    assert.equal(inUse(st), true);
  } finally {
    cleanup();
  }
});

test('the main repo\'s .lockage directory is also a trace', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    mkdirSync(join(repo, '.lockage'));
    const st = repoState(repo);
    assert.ok(st);
    assert.equal(inUse(st), true);
  } finally {
    cleanup();
  }
});

test('the home directory\'s .lockage directory is not treated as a trace', () => {
  const { base, repo, cleanup } = makeRepo();
  const savedHome = process.env.HOME;
  try {
    mkdirSync(join(repo, '.lockage'));
    // homedir() reads HOME, so treat repo as home to confirm "do not count .lockage directly under home"
    process.env.HOME = repo;
    const st = repoState(repo);
    assert.ok(st);
    assert.equal(inUse(st), false);
  } finally {
    process.env.HOME = savedHome;
    cleanup();
  }
});

test('it can decide even for a write to a directory that does not exist yet', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const st = repoState(join(repo, 'new', 'dir', 'a.txt'));
    assert.ok(st);
    assert.equal(st.mainRoot, repo);
  } finally {
    cleanup();
  }
});

test('it does not decide outside a git repository', () => {
  const { base, cleanup } = makeRepo();
  try {
    assert.equal(repoState(base), null);
  } finally {
    cleanup();
  }
});

test('mainWorktree does not misjudge even if the worktree path contains the string bare', () => {
  // the bare check is a full-line match (Python's "bare" not in first). Even with bare in the path name, treat it as a worktree
  const { base, repo, cleanup } = makeRepo();
  try {
    const wt = join(base, '.lockage-worktrees', 'bare-app');
    git(repo, 'worktree', 'add', '-q', '-b', 'lockage/a/bare', wt);
    const st = repoState(join(wt, 'a.txt'));
    assert.ok(st);
    assert.equal(st.mainRoot, repo); // on a bare misjudgment mainRoot would be null
    assert.equal(st.isLinked, true);
  } finally {
    cleanup();
  }
});

// --- buildContext ---

const CTX_OPTS = { agentsMd: '/plugins/AGENTS.md', readTool: 'Read' };

test('when operating, buildContext states the canonical location and the do-not-touch-the-main-tree principle', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const st = repoState(repo);
    assert.ok(st);
    const ctx = buildContext(st, CTX_OPTS);
    assert.ok(ctx.startsWith(DEFAULT_HEADER));
    assert.ok(ctx.includes(repo));
    assert.ok(ctx.includes('AGENTS.md'));
    assert.ok(ctx.includes('do not edit the main working tree directly'));
  } finally {
    cleanup();
  }
});

test('when not operating, buildContext states only the entry point', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const st = repoState(repo);
    assert.ok(st);
    const ctx = buildContext(st, CTX_OPTS);
    assert.ok(ctx.startsWith(DEFAULT_HEADER));
    assert.ok(ctx.includes('this repository does not use lockage yet'));
    assert.ok(!ctx.includes('do not edit the main working tree directly'));
  } finally {
    cleanup();
  }
});

test('DEFAULT_HEADER matches the port source word for word', () => {
  assert.equal(DEFAULT_HEADER, '## lockage coordinated development (lockage plugin)\n');
});

test('buildContext\'s operating text matches the port source word for word', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const st = repoState(repo);
    assert.ok(st);
    const ctx = buildContext(st, { agentsMd: '/A.md', readTool: 'Read' });
    const expected =
      '## lockage coordinated development (lockage plugin)\n' +
      `- value to pass as repo_path: ${repo}\n` +
      '- pass the same absolute path as repo_path to open_ticket\'s repos, create_task\'s repo, and lockage-publish\'s --repo-path as well\n' +
      `- current working tree: ${repo} (main working tree)\n` +
      '- this repository is operating under lockage. Before starting work that changes files, or work ' +
      'that handles lockage tickets/tasks, read the canonical coordination rules /A.md with Read and follow the lockage-workflow skill\'s steps.\n' +
      '- do all editing only inside the worktree returned by assign_worktree, and do not edit the main working tree directly' +
      ' (the only exception is "when the user instructs you not to use lockage" at the top of AGENTS.md).\n' +
      '- if the repository\'s AGENTS.md has a lockage section, treat it as that repository\'s specific rules and prefer it over the bundled canonical rules.\n';
    assert.equal(ctx, expected);
  } finally {
    cleanup();
  }
});

test('buildContext\'s not-operating text matches the port source word for word', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const st = repoState(repo);
    assert.ok(st);
    const ctx = buildContext(st, { agentsMd: '/A.md', readTool: 'Read' });
    const expected =
      '## lockage coordinated development (lockage plugin)\n' +
      `- value to pass as repo_path: ${repo}\n` +
      '- pass the same absolute path as repo_path to open_ticket\'s repos, create_task\'s repo, and lockage-publish\'s --repo-path as well\n' +
      `- current working tree: ${repo} (main working tree)\n` +
      '- this repository does not use lockage yet. If the user instructs you to proceed with lockage, ' +
      'read the canonical coordination rules /A.md with Read and follow the lockage-workflow skill\'s steps.\n';
    assert.equal(ctx, expected);
  } finally {
    cleanup();
  }
});

test('buildContext follows the header override', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const st = repoState(repo);
    assert.ok(st);
    const kiroHeader = '## lockage coordinated development (lockage Kiro Power)\n';
    const ctx = buildContext(st, { agentsMd: '/A.md', readTool: 'Read', header: kiroHeader });
    assert.ok(ctx.startsWith(kiroHeader));
  } finally {
    cleanup();
  }
});

// --- guard decide / record ---

/** Cut a temporary state dir. */
function stateDir(base: string): string {
  return join(base, 'guard-state');
}

function payload(repo: string, path: string, sessionId?: string) {
  return { tool_input: { file_path: path }, cwd: repo, session_id: sessionId ?? null };
}

test('a write to the main working tree of an operating repository is confirmed', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    assert.notEqual(decide(payload(repo, join(repo, 'a.txt')), stateDir(base)), null);
  } finally {
    cleanup();
  }
});

test('a non-operating repository is let through', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    assert.equal(decide(payload(repo, join(repo, 'a.txt')), stateDir(base)), null);
  } finally {
    cleanup();
  }
});

test('a write inside the worktree is let through', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const wt = addLockageWorktree(base, repo);
    assert.equal(decide(payload(repo, join(wt, 'a.txt')), stateDir(base)), null);
  } finally {
    cleanup();
  }
});

test('a relative path is also resolved from the working directory and confirmed', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    // cwd=repo so a.txt resolves directly under the main working tree
    assert.notEqual(decide(payload(repo, 'a.txt'), stateDir(base)), null);
  } finally {
    cleanup();
  }
});

test('input with no file path is let through', () => {
  const { base, cleanup } = makeRepo();
  try {
    assert.equal(decide({ tool_input: {} }, stateDir(base)), null);
  } finally {
    cleanup();
  }
});

test('after an allowed edit, it does not confirm again in the same session and same repository', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const sd = stateDir(base);
    assert.notEqual(decide(payload(repo, join(repo, 'a.txt'), 's1'), sd), null);
    record(payload(repo, join(repo, 'a.txt'), 's1'), sd);
    assert.equal(decide(payload(repo, join(repo, 'b.txt'), 's1'), sd), null);
  } finally {
    cleanup();
  }
});

test('after a deny, it confirms again', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const sd = stateDir(base);
    const path = join(repo, 'a.txt');
    // on a deny, record is not called. the confirmation keeps appearing every time
    assert.notEqual(decide(payload(repo, path, 's1'), sd), null);
    assert.notEqual(decide(payload(repo, path, 's1'), sd), null);
  } finally {
    cleanup();
  }
});

test('a different session confirms again', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const sd = stateDir(base);
    const path = join(repo, 'a.txt');
    record(payload(repo, path, 's1'), sd);
    assert.notEqual(decide(payload(repo, path, 's2'), sd), null);
  } finally {
    cleanup();
  }
});

test('if the session cannot be identified, it confirms even after an edit', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const sd = stateDir(base);
    const path = join(repo, 'a.txt');
    record(payload(repo, path), sd); // no session_id → not recorded
    assert.notEqual(decide(payload(repo, path), sd), null);
  } finally {
    cleanup();
  }
});

test('an edit inside the worktree is not recorded', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const wt = addLockageWorktree(base, repo);
    const sd = stateDir(base);
    record(payload(repo, join(wt, 'a.txt'), 's1'), sd); // inside worktree → mainTreeTarget is null, not recorded
    assert.notEqual(decide(payload(repo, join(repo, 'a.txt'), 's1'), sd), null);
  } finally {
    cleanup();
  }
});

test('do not use a world-writable state directory; confirm every time', (t) => {
  if (typeof process.getuid !== 'function') {
    t.skip('not applicable on an environment without getuid since the state dir is not used');
    return;
  }
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const sd = stateDir(base);
    const path = join(repo, 'a.txt');
    // even if another user created a 0o777 directory first on a shared /tmp and placed a mark, the guard must not come off
    mkdirSync(sd, { recursive: true, mode: 0o777 });
    record(payload(repo, path, 's1'), sd);
    assert.notEqual(decide(payload(repo, path, 's1'), sd), null);
  } finally {
    cleanup();
  }
});
