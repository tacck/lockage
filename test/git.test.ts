import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBaseBranch } from '../src/lockage/git.js';

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
