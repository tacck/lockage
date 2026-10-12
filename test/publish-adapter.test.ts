import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GithubPublishAdapter,
  GitlabPublishAdapter,
  detectProvider,
  makePublishAdapter,
  PublishNoDiffError,
  type PublishAdapter,
} from '../src/launcher/publish-adapter.ts';

/**
 * Verification of the publish adapter (3) B-1.
 *
 * The real `gh` has billing/permission/network side effects, so do not launch it; write a **fake gh
 * executable** (a shell script) and inject it via `ghCmd`. The fake branches on the arguments to simulate
 * gh's JSON output. push / deleteRemoteBranch are git (not a forge CLI), so stand up a local **bare origin**
 * and verify with real git.
 */

const SCRATCH = process.env.KIROCREW_SCRATCH ?? tmpdir();

/** Stand up a work repo for the worktree and a bare repo that becomes its origin. */
function initRepoWithBareOrigin(root: string): { repo: string; bare: string } {
  const bare = join(root, 'origin.git');
  const repo = join(root, 'work');
  execSync(`git init -q --bare "${bare}"`, { stdio: 'pipe' });
  mkdirSync(repo, { recursive: true });
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe' });
  sh('git init -q');
  sh('git config user.email pub@test.local');
  sh('git config user.name pub');
  sh('git commit -q --allow-empty -m init');
  sh('git branch -M main');
  sh(`git remote add origin "${bare}"`);
  sh('git push -q -u origin main');
  return { repo, bare };
}

/**
 * Write a fake gh executable. $1='pr', branching on $2:
 *  - pr create ... → print a fixed PR URL on one line
 *  - pr list --head <b> ... → print GH_FAKE_LIST (a JSON array) (if unset, [])
 *  - pr view <n> --json state → {"state": GH_FAKE_STATE} (default OPEN)
 * Swap the response per test via environment variables.
 */
function writeFakeGh(dir: string): string {
  const path = join(dir, 'fake-gh.sh');
  const script = `#!/usr/bin/env bash
# $1=pr $2=create|list|view
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  if [ -n "\${GH_FAKE_CREATE_FAIL:-}" ]; then
    echo "\${GH_FAKE_CREATE_FAIL}" >&2
    exit 1
  fi
  echo "\${GH_FAKE_CREATE_URL:-https://github.com/acme/repo/pull/42}"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo "\${GH_FAKE_LIST:-[]}"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo "{\\"state\\": \\"\${GH_FAKE_STATE:-OPEN}\\"}"
  exit 0
fi
echo "unexpected fake gh args: $*" >&2
exit 2
`;
  writeFileSync(path, script, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

// ── provider detection / factory (pure logic needing no external process) ──────────────────

test('detectProvider: an explicit value has top priority, otherwise decide from the origin URL', (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-detect-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const repo = join(workdir, 'r');
  mkdirSync(repo, { recursive: true });
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe' });
  sh('git init -q');
  sh('git remote add origin https://gitlab.com/acme/repo.git');

  // the explicit value has top priority (returns github even if the URL is gitlab)
  assert.equal(detectProvider(repo, 'github'), 'github');
  // without a value, gitlab from the URL
  assert.equal(detectProvider(repo), 'gitlab');

  // re-pointing origin to github gives github
  sh('git remote set-url origin git@github.com:acme/repo.git');
  assert.equal(detectProvider(repo), 'github');
});

test('detectProvider: if the origin is unknown, default to github', (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-detect2-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const repo = join(workdir, 'r');
  mkdirSync(repo, { recursive: true });
  execSync('git init -q', { cwd: repo, stdio: 'pipe' });
  assert.equal(detectProvider(repo), 'github');
});

test('makePublishAdapter: switches between github/gitlab by provider', () => {
  assert.equal(makePublishAdapter('github').id, 'github');
  assert.equal(makePublishAdapter('gitlab').id, 'gitlab');
});

// ── GitlabPublishAdapter stub: calling it fails explicitly ──────────────────────────

test('GitlabPublishAdapter: unimplemented in Phase 1, every method errors explicitly', async () => {
  const gl: PublishAdapter = new GitlabPublishAdapter();
  assert.equal(gl.id, 'gitlab');
  await assert.rejects(() => gl.pushBranch('/r', 'b'), /not implemented/i);
  await assert.rejects(() => gl.openPr({ repo: '/r', base: 'main', head: 'b', title: 't', bodyFile: '/f' }), /not implemented/i);
  await assert.rejects(() => gl.findPrByHead('/r', 'b'), /not implemented/i);
  await assert.rejects(() => gl.prState('/r', 1), /not implemented/i);
  await assert.rejects(() => gl.deleteRemoteBranch('/r', 'b'), /not implemented/i);
});

// ── GithubPublishAdapter: fake gh + real git (bare origin) ───────────────────

test('pushBranch: pushes the integration branch to origin by its literal name', (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-push-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const { repo, bare } = initRepoWithBareOrigin(workdir);
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe' });
  const branch = 'lockage/ticket/01ABC-XYZ';
  sh(`git branch "${branch}"`);

  const gh = new GithubPublishAdapter(writeFakeGh(workdir));
  return gh.pushBranch(repo, branch).then(() => {
    // the ref for that branch is created in the bare origin
    const refs = execSync(`git -C "${bare}" branch --list "${branch}"`, { encoding: 'utf8' });
    assert.match(refs, /lockage\/ticket\/01ABC-XYZ/, 'the integration branch is pushed to origin');
  });
});

test('deleteRemoteBranch: deletes a pushed branch from origin', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-del-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const { repo, bare } = initRepoWithBareOrigin(workdir);
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe' });
  const branch = 'lockage/ticket/todelete';
  sh(`git branch "${branch}"`);

  const gh = new GithubPublishAdapter(writeFakeGh(workdir));
  await gh.pushBranch(repo, branch);
  let refs = execSync(`git -C "${bare}" branch --list "${branch}"`, { encoding: 'utf8' });
  assert.match(refs, /todelete/, 'pushed (premise)');

  await gh.deleteRemoteBranch(repo, branch);
  refs = execSync(`git -C "${bare}" branch --list "${branch}"`, { encoding: 'utf8' });
  assert.equal(refs.trim(), '', 'deleted from origin');
});

test('findPrByHead: if an existing PR exists, return its number/state/URL normalized', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-find-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const { repo } = initRepoWithBareOrigin(workdir);
  const fakeGh = writeFakeGh(workdir);
  const gh = new GithubPublishAdapter(fakeGh);

  // the fake gh pr list returns 1 (MERGED mixed in = normalize even lowercase)
  process.env.GH_FAKE_LIST = JSON.stringify([{ number: 7, state: 'merged', url: 'https://github.com/acme/repo/pull/7' }]);
  try {
    const pr = await gh.findPrByHead(repo, 'lockage/ticket/x');
    assert.deepEqual(pr, { number: 7, state: 'MERGED', url: 'https://github.com/acme/repo/pull/7' });
  } finally {
    delete process.env.GH_FAKE_LIST;
  }
});

test('findPrByHead: null if no existing PR', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-find0-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const { repo } = initRepoWithBareOrigin(workdir);
  const gh = new GithubPublishAdapter(writeFakeGh(workdir)); // GH_FAKE_LIST unset = []
  const pr = await gh.findPrByHead(repo, 'lockage/ticket/none');
  assert.equal(pr, null);
});

test('openPr: after creating a PR, confirm the number/state via findPrByHead and return', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-open-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const { repo } = initRepoWithBareOrigin(workdir);
  const bodyFile = join(workdir, 'body.md');
  writeFileSync(bodyFile, 'PR body', 'utf8');
  const gh = new GithubPublishAdapter(writeFakeGh(workdir));

  // simulate findPrByHead right after creation returning the new PR
  process.env.GH_FAKE_LIST = JSON.stringify([{ number: 42, state: 'OPEN', url: 'https://github.com/acme/repo/pull/42' }]);
  try {
    const pr = await gh.openPr({ repo, base: 'main', head: 'lockage/ticket/x', title: 't', bodyFile });
    assert.equal(pr.number, 42);
    assert.equal(pr.state, 'OPEN');
    assert.match(pr.url, /pull\/42/);
  } finally {
    delete process.env.GH_FAKE_LIST;
  }
});

test('openPr: even if findPrByHead is empty, pick up the number at the end of the create URL as a fallback', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-openfb-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const { repo } = initRepoWithBareOrigin(workdir);
  const bodyFile = join(workdir, 'body.md');
  writeFileSync(bodyFile, 'PR body', 'utf8');
  const gh = new GithubPublishAdapter(writeFakeGh(workdir));

  // GH_FAKE_LIST unset (=[]), create is the default URL (.../pull/42)
  const pr = await gh.openPr({ repo, base: 'main', head: 'lockage/ticket/x', title: 't', bodyFile });
  assert.equal(pr.number, 42, 'pick up the number at the end of the URL as a fallback');
  assert.equal(pr.state, 'OPEN');
});

test('prState: normalize and return the state from gh pr view', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-state-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const { repo } = initRepoWithBareOrigin(workdir);
  const gh = new GithubPublishAdapter(writeFakeGh(workdir));

  process.env.GH_FAKE_STATE = 'MERGED';
  try {
    assert.equal(await gh.prState(repo, 42), 'MERGED');
  } finally {
    delete process.env.GH_FAKE_STATE;
  }
  process.env.GH_FAKE_STATE = 'CLOSED';
  try {
    assert.equal(await gh.prState(repo, 42), 'CLOSED');
  } finally {
    delete process.env.GH_FAKE_STATE;
  }
  // default (unset) is OPEN
  assert.equal(await gh.prState(repo, 42), 'OPEN');
});

// ── verification of the review fixes (M-1 / L-3) ──────────────────────────────────────

test('openPr: if gh pr create fails with already exists, re-fetch and return the existing PR (M-1)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-exists-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const { repo } = initRepoWithBareOrigin(workdir);
  const bodyFile = join(workdir, 'body.md');
  writeFileSync(bodyFile, 'PR body', 'utf8');
  const gh = new GithubPublishAdapter(writeFakeGh(workdir));

  process.env.GH_FAKE_CREATE_FAIL = 'a pull request for branch "x" into branch "main" already exists';
  process.env.GH_FAKE_LIST = JSON.stringify([{ number: 5, state: 'OPEN', url: 'https://github.com/acme/repo/pull/5' }]);
  try {
    const pr = await gh.openPr({ repo, base: 'main', head: 'lockage/ticket/x', title: 't', bodyFile });
    assert.equal(pr.number, 5, 'already exists → return the existing PR #5 via findPrByHead (no double creation)');
    assert.equal(pr.state, 'OPEN');
  } finally {
    delete process.env.GH_FAKE_CREATE_FAIL;
    delete process.env.GH_FAKE_LIST;
  }
});

test('openPr: if gh pr create fails with No commits, throw PublishNoDiffError (M-1)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-nodiff-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const { repo } = initRepoWithBareOrigin(workdir);
  const bodyFile = join(workdir, 'body.md');
  writeFileSync(bodyFile, 'PR body', 'utf8');
  const gh = new GithubPublishAdapter(writeFakeGh(workdir));

  process.env.GH_FAKE_CREATE_FAIL = 'pull request create failed: No commits between main and lockage/ticket/x';
  try {
    await assert.rejects(
      () => gh.openPr({ repo, base: 'main', head: 'lockage/ticket/x', title: 't', bodyFile }),
      (e: unknown) => e instanceof PublishNoDiffError,
      'no diff is distinguished with PublishNoDiffError',
    );
  } finally {
    delete process.env.GH_FAKE_CREATE_FAIL;
  }
});

test('detectProvider: decide by the host part and do not misfire on a github URL whose path contains gitlab (L-3)', (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-pub-host-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const repo = join(workdir, 'r');
  mkdirSync(repo, { recursive: true });
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, stdio: 'pipe' });
  sh('git init -q');

  // the path contains 'gitlab' but the host is github.com → github
  sh('git remote add origin https://github.com/acme/my-gitlab-mirror.git');
  assert.equal(detectProvider(repo), 'github', 'does not misfire on gitlab in the path');

  // scp-style gitlab host → gitlab
  sh('git remote set-url origin git@gitlab.example.com:acme/repo.git');
  assert.equal(detectProvider(repo), 'gitlab');

  // self-hosted gitlab (https, with a port) → gitlab
  sh('git remote set-url origin https://gitlab.corp.local:8443/acme/repo.git');
  assert.equal(detectProvider(repo), 'gitlab');
});
