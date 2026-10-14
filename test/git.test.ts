import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveBaseBranch,
  resolveRemoteName,
  fetchBase,
  remoteTrackingRef,
  countBehind,
} from '../src/lockage/git.js';

const SCRATCH = process.env.KIROCREW_SCRATCH ?? tmpdir();

let root: string;
let repoPath: string;

/** A thin helper that runs git in repo scope. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** Prepare a temporary repo with an initial commit on the given branch name. */
function initRepo(initialBranch: string): void {
  git(repoPath, ['init', '-q', '-b', initialBranch]);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'test']);
  writeFileSync(join(repoPath, 'README.md'), '# test\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', 'init']);
}

/** Create a new branch from the current commit (does not switch the checkout back). */
function createBranch(name: string): void {
  git(repoPath, ['branch', name]);
}

beforeEach(() => {
  root = mkdtempSync(join(SCRATCH, 'lockage-git-'));
  repoPath = join(root, 'repo');
  mkdirSync(repoPath);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('an explicit value has top priority and returns before any existing branch', () => {
  initRepo('main');
  // explicit returns as-is without an existence check (respect the caller's explicit choice).
  assert.equal(resolveBaseBranch(repoPath, 'feature-x'), 'feature-x');
});

test('if dev/stg/main/master all exist, the first one dev wins', () => {
  initRepo('main');
  createBranch('dev');
  createBranch('stg');
  createBranch('master');
  assert.equal(resolveBaseBranch(repoPath), 'dev');
});

test('if there is no dev but there is stg, pick up stg', () => {
  initRepo('main');
  createBranch('stg');
  createBranch('master');
  assert.equal(resolveBaseBranch(repoPath), 'stg');
});

test('if there is no dev/stg, pick up main per the search order', () => {
  initRepo('main');
  createBranch('master');
  assert.equal(resolveBaseBranch(repoPath), 'main');
});

test('if there is no main but only master, pick up master', () => {
  initRepo('master');
  assert.equal(resolveBaseBranch(repoPath), 'master');
});

test('if none of the candidates exist, fall back to main', () => {
  initRepo('trunk');
  assert.equal(resolveBaseBranch(repoPath), 'main');
});

// ── Issue #8: remote 追従ヘルパー ──────────────────────────────────────────────
// 外部ネットワークを使わず、ローカルの bare リポジトリを remote として add し push することで
// git fetch とリモート追跡 ref をネットワーク無しに再現する。

/**
 * ローカルの bare リポジトリを remote として用意し、`dev` ブランチを 1 コミット進めて push する。
 * その後ローカルの `dev` をわざと push 前の状態に戻す（＝ローカルが origin から 1 件遅れた状態）。
 * @returns bare リポジトリのパス。
 */
function setupLaggingRemote(): string {
  // dev ブランチを作って初期状態をコミット済みにする（initRepo で init 済み）。
  git(repoPath, ['branch', 'dev']);
  git(repoPath, ['checkout', '-q', 'dev']);

  // bare リポジトリを remote として用意（file ベース＝ネットワーク不要）。
  const bare = join(root, 'remote.git');
  mkdirSync(bare);
  git(bare, ['init', '-q', '--bare', '-b', 'dev']);
  git(repoPath, ['remote', 'add', 'origin', bare]);

  // ローカル dev に 1 コミット足して push（これが origin/dev の進んだ状態になる）。
  writeFileSync(join(repoPath, 'remote-only.txt'), 'from remote\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', 'advance dev on remote']);
  git(repoPath, ['push', '-q', 'origin', 'dev']);

  // ローカルの dev を 1 つ戻して「ローカルが origin/dev から 1 件遅れている」状態を作る。
  git(repoPath, ['reset', '-q', '--hard', 'HEAD~1']);
  return bare;
}

test('resolveRemoteName: returns null when there is no remote', () => {
  initRepo('main');
  assert.equal(resolveRemoteName(repoPath), null);
});

test('resolveRemoteName: prefers origin when it exists', () => {
  initRepo('main');
  const bare = join(root, 'o.git');
  mkdirSync(bare);
  git(bare, ['init', '-q', '--bare']);
  const bare2 = join(root, 'u.git');
  mkdirSync(bare2);
  git(bare2, ['init', '-q', '--bare']);
  git(repoPath, ['remote', 'add', 'upstream', bare2]);
  git(repoPath, ['remote', 'add', 'origin', bare]);
  assert.equal(resolveRemoteName(repoPath), 'origin');
});

test('resolveRemoteName: returns the first remote when there is no origin', () => {
  initRepo('main');
  const bare = join(root, 'u.git');
  mkdirSync(bare);
  git(bare, ['init', '-q', '--bare']);
  git(repoPath, ['remote', 'add', 'upstream', bare]);
  assert.equal(resolveRemoteName(repoPath), 'upstream');
});

test('remoteTrackingRef: null for an untracked branch, "<remote>/<base>" after fetch', () => {
  initRepo('main');
  setupLaggingRemote();
  // 存在しないブランチの追跡 ref は無い。
  assert.equal(remoteTrackingRef(repoPath, 'origin', 'nonexistent'), null);
  // fetch するとリモート追跡 ref が参照できる。
  assert.equal(fetchBase(repoPath, 'origin', 'dev'), true);
  assert.equal(remoteTrackingRef(repoPath, 'origin', 'dev'), 'origin/dev');
});

test('fetchBase: returns false for a nonexistent remote (best-effort, no throw)', () => {
  initRepo('main');
  assert.equal(fetchBase(repoPath, 'nope', 'dev'), false);
});

test('countBehind: returns how many commits the local base lags behind the remote tracking ref', () => {
  initRepo('main');
  setupLaggingRemote();
  fetchBase(repoPath, 'origin', 'dev');
  // ローカル dev は origin/dev から 1 件遅れている。
  assert.equal(countBehind(repoPath, 'dev', 'origin/dev'), 1);
});

test('countBehind: returns null when a ref cannot be resolved (best-effort)', () => {
  initRepo('main');
  assert.equal(countBehind(repoPath, 'dev', 'origin/dev'), null);
});

test('fetchBase: does NOT move the local base branch (only FETCH_HEAD / tracking ref)', () => {
  initRepo('main');
  setupLaggingRemote();
  const before = git(repoPath, ['rev-parse', 'dev']);
  fetchBase(repoPath, 'origin', 'dev');
  const after = git(repoPath, ['rev-parse', 'dev']);
  // ローカル dev は fetch 後も動かない（本流を checkout しない運用を壊さない）。
  assert.equal(before, after, 'local dev stays put after fetch');
  // 一方 origin/dev は dev より進んでいる。
  assert.notEqual(git(repoPath, ['rev-parse', 'origin/dev']), after);
});
