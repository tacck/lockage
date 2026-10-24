import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(PROJECT_ROOT, 'dist', 'launcher', 'publish-cli.js');
const SERVER_ENTRY = join(PROJECT_ROOT, 'dist', 'index.js');
const SCRATCH = process.env.KIROCREW_SCRATCH ?? tmpdir();

/**
 * Verification of the lockage-publish CLI (B-4).
 *
 * The publish/reconcile logic itself is verified by publish.test.ts with a real Lockage + fake adapter.
 * Here we verify the CLI layer (argument parsing, help, mode dispatch, exit code, JSON output) in a
 * subprocess. Running it with no ticket_ready on the board makes publish/reconcile a no-op and does not
 * call the real gh (if read_board is empty the adapter is not touched), so it does not depend on gh
 * authentication/side effects.
 */

function initRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  execSync('git init -q -b main', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email cli@test.local', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name cli', { cwd: repo, stdio: 'pipe' });
  writeFileSync(join(repo, 'README.md'), '# cli\n');
  execSync('git add README.md', { cwd: repo, stdio: 'pipe' });
  execSync('git commit -q -m init', { cwd: repo, stdio: 'pipe' });
  // add an origin so provider detection becomes github (push is not done = not called since it is a no-op)
  execSync('git remote add origin git@github.com:acme/repo.git', { cwd: repo, stdio: 'pipe' });
  return repo;
}

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('lockage-publish --help prints usage and exits 0', async () => {
  const { code, stderr } = await runCli(['--help'], {});
  assert.equal(code, 0);
  assert.match(stderr, /lockage-publish/);
  assert.match(stderr, /--repo-path/);
  assert.match(stderr, /--mode/);
});

test('lockage-publish: no --repo-path is usage + exit 2', async () => {
  const { code, stderr } = await runCli(['--mode', 'publish'], {});
  assert.equal(code, 2);
  assert.match(stderr, /--repo-path/);
});

test('lockage-publish: an invalid --mode is usage + exit 2', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-cli-badmode-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const repo = initRepo(workdir);
  const { code } = await runCli(['--repo-path', repo, '--mode', 'nonsense'], {});
  assert.equal(code, 2);
});

test('lockage-publish --mode publish: an empty board is published:[] and exit 0 (no gh needed)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-cli-publish-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const repo = initRepo(workdir);
  const dbPath = join(workdir, 'lockage.sqlite');

  const { code, stdout } = await runCli(
    ['--repo-path', repo, '--mode', 'publish', '--server-entry', SERVER_ENTRY, '--db', dbPath],
    { LOCKAGE_DB: dbPath },
  );
  assert.equal(code, 0, `stdout=${stdout}`);
  const out = JSON.parse(stdout.trim());
  assert.equal(out.mode, 'publish');
  assert.equal(out.provider, 'github');
  assert.deepEqual(out.published, []);
  assert.equal(out.reconciled, undefined, 'publish mode does not run reconcile');
});

test('lockage-publish --mode both: an empty board is published:[] reconciled:[] and exit 0', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-cli-both-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const repo = initRepo(workdir);
  const dbPath = join(workdir, 'lockage.sqlite');

  const { code, stdout } = await runCli(
    ['--repo-path', repo, '--mode', 'both', '--server-entry', SERVER_ENTRY, '--db', dbPath],
    { LOCKAGE_DB: dbPath },
  );
  assert.equal(code, 0, `stdout=${stdout}`);
  const out = JSON.parse(stdout.trim());
  assert.deepEqual(out.published, []);
  assert.deepEqual(out.reconciled, []);
});

// ── Issue #32: base 未解決時の挙動 ──────────────────────────────────────────────

/** base を解決できない repo（dev/stg/main/master が無く remote も無い）を作る。 */
function initRepoNoBase(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  execSync('git init -q -b trunk', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email cli@test.local', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name cli', { cwd: repo, stdio: 'pipe' });
  writeFileSync(join(repo, 'README.md'), '# cli\n');
  execSync('git add README.md', { cwd: repo, stdio: 'pipe' });
  execSync('git commit -q -m init', { cwd: repo, stdio: 'pipe' });
  // provider 検出用に origin だけ付ける（push しない＝リモート追跡 ref は作られない）。
  execSync('git remote add origin git@github.com:acme/repo.git', { cwd: repo, stdio: 'pipe' });
  return repo;
}

test('lockage-publish --mode publish: base unresolved exits non-zero with a clear message (no main fallback)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-cli-nobase-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const repo = initRepoNoBase(workdir);
  const dbPath = join(workdir, 'lockage.sqlite');

  const { code, stderr } = await runCli(
    ['--repo-path', repo, '--mode', 'publish', '--server-entry', SERVER_ENTRY, '--db', dbPath],
    { LOCKAGE_DB: dbPath },
  );
  assert.notEqual(code, 0, 'exits non-zero when base cannot be resolved');
  assert.match(stderr, /base/, 'stderr explains the base resolution failure');
});

test('lockage-publish --mode publish: explicit --base works even when base cannot be inferred (exit 0)', async (t) => {
  const workdir = mkdtempSync(join(SCRATCH, 'lockage-cli-explicitbase-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const repo = initRepoNoBase(workdir);
  const dbPath = join(workdir, 'lockage.sqlite');

  // --base を明示すれば resolveBaseBranch を呼ばず、空ボードなので no-op publish で exit 0。
  const { code, stdout } = await runCli(
    ['--repo-path', repo, '--mode', 'publish', '--base', 'trunk', '--server-entry', SERVER_ENTRY, '--db', dbPath],
    { LOCKAGE_DB: dbPath },
  );
  assert.equal(code, 0, `stdout=${stdout} (explicit --base should not fail)`);
  const out = JSON.parse(stdout.trim());
  assert.deepEqual(out.published, []);
});
