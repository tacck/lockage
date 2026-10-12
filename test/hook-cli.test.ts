/**
 * Integration test for the hook CLI (src/hook/clients.ts / dispatch.ts / setup-kiro.ts) and for not
 * breaking the no-argument MCP startup.
 *
 * The CLI starts dist/index.js as a child process, feeds stdin JSON, and verifies the exit code / stdout
 * (dispatch.ts involves stdin/stdout/exit code, so verify it with a child-process launch separately from
 * the pure-logic unit tests in test/hook-logic.test.ts. design.md §8/§10 testability).
 *
 * Temporary git repositories are built with the same shape of helper as FEAT-001's test/hook-logic.test.ts,
 * and LOCKAGE_GUARD_STATE_DIR is diverted to a temporary location. The no-argument MCP regression spawns
 * and waits for ready then kills, passing a temporary LOCKAGE_DB in env to not touch the real home ledger.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '..', 'dist', 'index.js'); // hit the built dist

/** Fix the git environment so it does not depend on the user's global config. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8' });
}

/** Create a temporary git repository (base/app). base is realpathSync-resolved. */
function makeRepo(): { base: string; repo: string; cleanup: () => void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lockage-cli-test-')));
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

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Start the CLI as a child process. Feed input (a JSON string) to stdin and return the result. */
function runCli(args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): RunResult {
  const r = spawnSync('node', [ENTRY, ...args], {
    input: opts.input ?? '',
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Build env that diverts the guard state dir to a temporary location. */
function guardEnv(base: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { LOCKAGE_GUARD_STATE_DIR: join(base, 'guard-state'), ...extra };
}

// --- (a) kiro guard ----------------------------------------------------------

test('kiro guard: a main-tree edit is exit 2', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const r = runCli(['hook', 'guard', '--client', 'kiro'], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'fs_write',
        tool_input: { file_path: join(repo, 'a.txt') },
        cwd: repo,
      }),
      env: guardEnv(base),
    });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('main working tree'));
  } finally {
    cleanup();
  }
});

test('kiro guard: an edit inside the worktree is exit 0', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const wt = addLockageWorktree(base, repo);
    const r = runCli(['hook', 'guard', '--client', 'kiro'], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'fs_write',
        tool_input: { file_path: join(wt, 'a.txt') },
        cwd: repo,
      }),
      env: guardEnv(base),
    });
    assert.equal(r.status, 0);
  } finally {
    cleanup();
  }
});

test('kiro guard: a non-operating repository is exit 0', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const r = runCli(['hook', 'guard', '--client', 'kiro'], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'fs_write',
        tool_input: { file_path: join(repo, 'a.txt') },
        cwd: repo,
      }),
      env: guardEnv(base),
    });
    assert.equal(r.status, 0);
  } finally {
    cleanup();
  }
});

test('kiro guard: when the path cannot be obtained, exit 0 + stderr warning', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const r = runCli(['hook', 'guard', '--client', 'kiro'], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'fs_write',
        tool_input: {},
        cwd: repo,
      }),
      env: guardEnv(base),
    });
    assert.equal(r.status, 0);
    assert.ok(r.stderr.includes('Could not extract the edit target path'));
  } finally {
    cleanup();
  }
});

test('kiro guard: LOCKAGE_GUARD_DISABLE=1 is exit 0', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const r = runCli(['hook', 'guard', '--client', 'kiro'], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'fs_write',
        tool_input: { file_path: join(repo, 'a.txt') },
        cwd: repo,
      }),
      env: guardEnv(base, { LOCKAGE_GUARD_DISABLE: '1' }),
    });
    assert.equal(r.status, 0);
  } finally {
    cleanup();
  }
});

test('kiro guard: PostToolUse is exit 0 (defensive contract)', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const r = runCli(['hook', 'guard', '--client', 'kiro'], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'fs_write',
        tool_input: { file_path: join(repo, 'a.txt') },
        cwd: repo,
      }),
      env: guardEnv(base),
    });
    assert.equal(r.status, 0);
  } finally {
    cleanup();
  }
});

// --- (b) kiro session --------------------------------------------------------

test('kiro session: emits text starting with the Kiro Power heading to stdout', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const r = runCli(['hook', 'session', '--client', 'kiro', '--agents-md', '/A.md'], {
      input: JSON.stringify({ cwd: repo }),
      env: guardEnv(base),
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.startsWith('## lockage coordinated development (lockage Kiro Power)\n'));
    assert.ok(r.stdout.includes('operating under lockage'));
  } finally {
    cleanup();
  }
});

test('kiro session: outside git it is no output exit 0', () => {
  const { base, cleanup } = makeRepo();
  try {
    const r = runCli(['hook', 'session', '--client', 'kiro', '--agents-md', '/A.md'], {
      input: JSON.stringify({ cwd: base }),
      env: guardEnv(base),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    cleanup();
  }
});

test('kiro session: self-diagnostic — a warning line if lockage-guard.json is not installed', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const r = runCli(['hook', 'session', '--client', 'kiro', '--agents-md', '/A.md'], {
      input: JSON.stringify({ cwd: repo }),
      env: guardEnv(base),
    });
    assert.ok(r.stdout.includes('The guard hook is not installed. Run npx -y lockage setup kiro'));
  } finally {
    cleanup();
  }
});

test('kiro session: self-diagnostic — no warning if lockage-guard.json is already installed', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    mkdirSync(join(repo, '.kiro', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.kiro', 'hooks', 'lockage-guard.json'), '{}');
    const r = runCli(['hook', 'session', '--client', 'kiro', '--agents-md', '/A.md'], {
      input: JSON.stringify({ cwd: repo }),
      env: guardEnv(base),
    });
    assert.ok(!r.stdout.includes('The guard hook is not installed'));
  } finally {
    cleanup();
  }
});

// --- (c) claude guard --------------------------------------------------------

test('claude guard: a main-tree edit is ask JSON', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const r = runCli(['hook', 'guard', '--client', 'claude'], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_input: { file_path: join(repo, 'a.txt') },
        cwd: repo,
        session_id: 's1',
      }),
      env: guardEnv(base),
    });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.length > 0);
  } finally {
    cleanup();
  }
});

test('claude guard: after a PostToolUse record it does not ask again in the same session and repository', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const env = guardEnv(base);
    const payload = (path: string, event: string) =>
      JSON.stringify({
        hook_event_name: event,
        tool_input: { file_path: path },
        cwd: repo,
        session_id: 's1',
      });
    // first an ask appears
    assert.notEqual(
      runCli(['hook', 'guard', '--client', 'claude'], {
        input: payload(join(repo, 'a.txt'), 'PreToolUse'),
        env,
      }).stdout,
      '',
    );
    // record via PostToolUse
    runCli(['hook', 'guard', '--client', 'claude'], {
      input: payload(join(repo, 'a.txt'), 'PostToolUse'),
      env,
    });
    // thereafter it does not ask in the same session and repository (no output)
    assert.equal(
      runCli(['hook', 'guard', '--client', 'claude'], {
        input: payload(join(repo, 'b.txt'), 'PreToolUse'),
        env,
      }).stdout,
      '',
    );
  } finally {
    cleanup();
  }
});

test('claude guard: a different session asks again', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const env = guardEnv(base);
    runCli(['hook', 'guard', '--client', 'claude'], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_input: { file_path: join(repo, 'a.txt') },
        cwd: repo,
        session_id: 's1',
      }),
      env,
    });
    const r = runCli(['hook', 'guard', '--client', 'claude'], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_input: { file_path: join(repo, 'a.txt') },
        cwd: repo,
        session_id: 's2',
      }),
      env,
    });
    assert.notEqual(r.stdout, '');
  } finally {
    cleanup();
  }
});

test('claude guard: LOCKAGE_GUARD_DISABLE=1 is no output and does not record even on PostToolUse', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const sd = join(base, 'guard-state');
    // even flowing a PostToolUse while disabled does not record
    const rPost = runCli(['hook', 'guard', '--client', 'claude'], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_input: { file_path: join(repo, 'a.txt') },
        cwd: repo,
        session_id: 's1',
      }),
      env: { LOCKAGE_GUARD_STATE_DIR: sd, LOCKAGE_GUARD_DISABLE: '1' },
    });
    assert.equal(rPost.stdout, '');
    // removing the disable makes an ask appear again (proof it was not recorded)
    const r = runCli(['hook', 'guard', '--client', 'claude'], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_input: { file_path: join(repo, 'a.txt') },
        cwd: repo,
        session_id: 's1',
      }),
      env: { LOCKAGE_GUARD_STATE_DIR: sd },
    });
    assert.notEqual(r.stdout, '');
  } finally {
    cleanup();
  }
});

// --- (d) claude session ------------------------------------------------------

test('claude session: SessionStart is additionalContext JSON', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const r = runCli(['hook', 'session', '--client', 'claude', '--agents-md', '/A.md'], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: repo }),
      env: guardEnv(base),
    });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(out.hookSpecificOutput.additionalContext.startsWith('## lockage coordinated development (lockage plugin)\n'));
  } finally {
    cleanup();
  }
});

test('claude session: outside git it is no output', () => {
  const { base, cleanup } = makeRepo();
  try {
    const r = runCli(['hook', 'session', '--client', 'claude', '--agents-md', '/A.md'], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: base }),
      env: guardEnv(base),
    });
    assert.equal(r.stdout, '');
  } finally {
    cleanup();
  }
});

test('claude session: SubagentStart returns only for lockage-worker and hookEventName=SubagentStart', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    // returns nothing for anything other than lockage-worker
    const other = runCli(['hook', 'session', '--client', 'claude', '--agents-md', '/A.md'], {
      input: JSON.stringify({ hook_event_name: 'SubagentStart', agent_type: 'Explore', cwd: repo }),
      env: guardEnv(base),
    });
    assert.equal(other.stdout, '');
    // returns for lockage-worker, and hookEventName echoes the input event name
    const worker = runCli(['hook', 'session', '--client', 'claude', '--agents-md', '/A.md'], {
      input: JSON.stringify({
        hook_event_name: 'SubagentStart',
        agent_type: 'lockage-worker',
        cwd: repo,
      }),
      env: guardEnv(base),
    });
    const out = JSON.parse(worker.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert.ok(out.hookSpecificOutput.additionalContext.includes('canonical coordination rules: /A.md'));
    assert.ok(out.hookSpecificOutput.additionalContext.includes(`repository of the launch location: ${repo}`));
  } finally {
    cleanup();
  }
});

// --- (e) antigravity guard ---------------------------------------------------

test('antigravity guard: pre on the main tree is force_ask', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const r = runCli(['hook', 'guard', '--client', 'antigravity', '--event', 'pre'], {
      input: JSON.stringify({
        toolCall: { args: { TargetFile: join(repo, 'a.txt') } },
        workspacePaths: [repo],
        conversationId: 'c1',
      }),
      env: guardEnv(base),
    });
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'force_ask');
    assert.ok(out.reason.length > 0);
  } finally {
    cleanup();
  }
});

test('antigravity guard: pre on a non-target is {decision:ask}', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const r = runCli(['hook', 'guard', '--client', 'antigravity', '--event', 'pre'], {
      input: JSON.stringify({
        toolCall: { args: { TargetFile: join(repo, 'a.txt') } },
        workspacePaths: [repo],
        conversationId: 'c1',
      }),
      env: guardEnv(base),
    });
    assert.deepEqual(JSON.parse(r.stdout), { decision: 'ask' });
  } finally {
    cleanup();
  }
});

test('antigravity guard: post with no error is record + {}, then pre is ask', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const env = guardEnv(base);
    const payload = JSON.stringify({
      toolCall: { args: { TargetFile: join(repo, 'a.txt') } },
      workspacePaths: [repo],
      conversationId: 'c1',
    });
    const post = runCli(['hook', 'guard', '--client', 'antigravity', '--event', 'post'], {
      input: payload,
      env,
    });
    assert.deepEqual(JSON.parse(post.stdout), {});
    // recorded, so subsequent pre is let through (ask)
    const pre = runCli(['hook', 'guard', '--client', 'antigravity', '--event', 'pre'], {
      input: payload,
      env,
    });
    assert.deepEqual(JSON.parse(pre.stdout), { decision: 'ask' });
  } finally {
    cleanup();
  }
});

test('antigravity guard: post with an error does not record and is {}', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const env = guardEnv(base);
    const base_payload = {
      toolCall: { args: { TargetFile: join(repo, 'a.txt') } },
      workspacePaths: [repo],
      conversationId: 'c1',
    };
    const post = runCli(['hook', 'guard', '--client', 'antigravity', '--event', 'post'], {
      input: JSON.stringify({ ...base_payload, error: 'user denied permission' }),
      env,
    });
    assert.deepEqual(JSON.parse(post.stdout), {});
    // not recorded, so pre stays force_ask
    const pre = runCli(['hook', 'guard', '--client', 'antigravity', '--event', 'pre'], {
      input: JSON.stringify(base_payload),
      env,
    });
    assert.equal(JSON.parse(pre.stdout).decision, 'force_ask');
  } finally {
    cleanup();
  }
});

test('antigravity guard: LOCKAGE_GUARD_DISABLE=1 is pre={decision:ask}/post={} and does not record', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const sd = join(base, 'guard-state');
    const payload = JSON.stringify({
      toolCall: { args: { TargetFile: join(repo, 'a.txt') } },
      workspacePaths: [repo],
      conversationId: 'c1',
    });
    const pre = runCli(['hook', 'guard', '--client', 'antigravity', '--event', 'pre'], {
      input: payload,
      env: { LOCKAGE_GUARD_STATE_DIR: sd, LOCKAGE_GUARD_DISABLE: '1' },
    });
    assert.deepEqual(JSON.parse(pre.stdout), { decision: 'ask' });
    const post = runCli(['hook', 'guard', '--client', 'antigravity', '--event', 'post'], {
      input: payload,
      env: { LOCKAGE_GUARD_STATE_DIR: sd, LOCKAGE_GUARD_DISABLE: '1' },
    });
    assert.deepEqual(JSON.parse(post.stdout), {});
    // not recorded while disabled, so pre after enabling is force_ask
    const preAfter = runCli(['hook', 'guard', '--client', 'antigravity', '--event', 'pre'], {
      input: payload,
      env: { LOCKAGE_GUARD_STATE_DIR: sd },
    });
    assert.equal(JSON.parse(preAfter.stdout).decision, 'force_ask');
  } finally {
    cleanup();
  }
});

test('antigravity guard: a missing --event is usage + non-zero', () => {
  const r = runCli(['hook', 'guard', '--client', 'antigravity'], { input: '{}' });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes('--event'));
});

// --- (f) antigravity session -------------------------------------------------

test('antigravity session: the first invocation of a conversation is injectSteps', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const r = runCli(['hook', 'session', '--client', 'antigravity', '--agents-md', '/A.md'], {
      input: JSON.stringify({ invocationNum: 0, workspacePaths: [repo] }),
      env: guardEnv(base),
    });
    const out = JSON.parse(r.stdout);
    assert.ok(Array.isArray(out.injectSteps));
    assert.ok(out.injectSteps[0].ephemeralMessage.startsWith('## lockage coordinated development (lockage plugin)\n'));
    assert.ok(out.injectSteps[0].ephemeralMessage.includes('view_file'));
  } finally {
    cleanup();
  }
});

test('antigravity session: invocationNum!==0 is {}', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const r = runCli(['hook', 'session', '--client', 'antigravity', '--agents-md', '/A.md'], {
      input: JSON.stringify({ invocationNum: 1, workspacePaths: [repo] }),
      env: guardEnv(base),
    });
    assert.deepEqual(JSON.parse(r.stdout), {});
  } finally {
    cleanup();
  }
});

test('antigravity session: already present in the transcript is {}', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    addLockageWorktree(base, repo);
    const transcript = join(base, 'transcript.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({ type: 'EPHEMERAL_MESSAGE', content: '## lockage coordinated development (lockage plugin)\nx' }) +
      '\n',
    );
    const r = runCli(['hook', 'session', '--client', 'antigravity', '--agents-md', '/A.md'], {
      input: JSON.stringify({ invocationNum: 0, transcriptPath: transcript, workspacePaths: [repo] }),
      env: guardEnv(base),
    });
    assert.deepEqual(JSON.parse(r.stdout), {});
  } finally {
    cleanup();
  }
});

// --- (g) common ----------------------------------------------------------------

test('even unparseable JSON stdin does not crash and returns the default response (antigravity pre)', () => {
  const r = runCli(['hook', 'guard', '--client', 'antigravity', '--event', 'pre'], {
    input: 'not json',
  });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { decision: 'ask' });
});

test('a missing --client is usage + non-zero', () => {
  const r = runCli(['hook', 'guard'], { input: '{}' });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes('--client'));
});

test('an unknown hook subcommand is usage + non-zero', () => {
  const r = runCli(['hook', 'foo', '--client', 'claude'], { input: '{}' });
  assert.notEqual(r.status, 0);
});

// --- setup kiro --------------------------------------------------------------

test('setup kiro: generates lockage-guard.json / lockage-session.json in npx form', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const r = runCli(['setup', 'kiro', '--repo', repo]);
    assert.equal(r.status, 0);
    const hooksDir = join(repo, '.kiro', 'hooks');
    const guard = JSON.parse(readFileSync(join(hooksDir, 'lockage-guard.json'), 'utf8'));
    const session = JSON.parse(readFileSync(join(hooksDir, 'lockage-session.json'), 'utf8'));

    assert.equal(guard.version, 'v1');
    assert.equal(session.version, 'v1');

    // guard: 2 hooks of PreToolUse, matcher fs_write/str_replace, type command
    assert.equal(guard.hooks.length, 2);
    const matchers = guard.hooks.map((h: { matcher: string }) => h.matcher).sort();
    assert.deepEqual(matchers, ['fs_write', 'str_replace']);
    for (const h of guard.hooks) {
      assert.equal(h.trigger, 'PreToolUse');
      assert.equal(h.action.type, 'command');
      assert.ok(h.action.command.startsWith('npx -y lockage hook guard --client kiro'));
      assert.ok(!h.action.command.includes('--agents-md'));
    }
    const guardNames = guard.hooks.map((h: { name: string }) => h.name).sort();
    assert.deepEqual(guardNames, ['lockage-guard-fs-write', 'lockage-guard-str-replace']);

    // session: 1 hook of SessionStart, no matcher, name=lockage-session
    assert.equal(session.hooks.length, 1);
    assert.equal(session.hooks[0].name, 'lockage-session');
    assert.equal(session.hooks[0].trigger, 'SessionStart');
    assert.equal(session.hooks[0].matcher, undefined);
    assert.equal(session.hooks[0].action.type, 'command');
    assert.ok(session.hooks[0].action.command.startsWith('npx -y lockage hook session --client kiro'));

    // no placeholder remains (the absolute path is filled in)
    const bothCommands = JSON.stringify(guard) + JSON.stringify(session);
    assert.ok(!bothCommands.includes('<ABSOLUTE'));
    assert.ok(session.hooks[0].action.command.includes(join(repo, '.kiro', 'steering', 'AGENTS.md')));
  } finally {
    cleanup();
  }
});

test('setup kiro: the second time is unchanged (idempotent)', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    runCli(['setup', 'kiro', '--repo', repo]);
    const r = runCli(['setup', 'kiro', '--repo', repo]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('unchanged'));
  } finally {
    cleanup();
  }
});

test('setup kiro: with a diff and no --force the file is unchanged and non-zero, --force overwrites', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const hooksDir = join(repo, '.kiro', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const guardPath = join(hooksDir, 'lockage-guard.json');
    writeFileSync(guardPath, '{"custom":true}\n');

    const noForce = runCli(['setup', 'kiro', '--repo', repo]);
    assert.notEqual(noForce.status, 0);
    assert.ok(noForce.stdout.includes('skipped-needs-force'));
    // the file is unchanged
    assert.equal(readFileSync(guardPath, 'utf8'), '{"custom":true}\n');

    const force = runCli(['setup', 'kiro', '--repo', repo, '--force']);
    assert.equal(force.status, 0);
    const guard = JSON.parse(readFileSync(guardPath, 'utf8'));
    assert.equal(guard.version, 'v1');
  } finally {
    cleanup();
  }
});

test('setup kiro: a non-existent --repo exits non-zero', () => {
  const r = runCli(['setup', 'kiro', '--repo', join(tmpdir(), 'lockage-no-such-dir-xyz-123')]);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.length > 0);
});

test('setup kiro: running inside a worktree still places it in the main root\'s .kiro/hooks', () => {
  const { base, repo, cleanup } = makeRepo();
  try {
    const wt = addLockageWorktree(base, repo);
    const r = runCli(['setup', 'kiro', '--repo', wt]);
    assert.equal(r.status, 0);
    assert.ok(existsSync(join(repo, '.kiro', 'hooks', 'lockage-guard.json')));
    assert.ok(!existsSync(join(wt, '.kiro', 'hooks', 'lockage-guard.json')));
  } finally {
    cleanup();
  }
});

// --- no-argument MCP regression ----------------------------------------------

/** Start `node dist/index.js [args]` and wait until '[lockage] ready' appears on stderr, then kill. */
function expectMcpReady(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const dbDir = mkdtempSync(join(tmpdir(), 'lockage-mcp-test-'));
    const dbPath = join(dbDir, 'lockage.sqlite');
    const child = spawn('node', [ENTRY, ...args], {
      env: { ...process.env, LOCKAGE_DB: dbPath },
    });
    let stderr = '';
    const done = (err?: Error) => {
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      rmSync(dbDir, { recursive: true, force: true });
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      done(new Error(`'[lockage] ready' did not appear within the time limit. stderr=${stderr}`));
    }, 10000);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.includes('[lockage] ready')) done();
    });
    child.on('error', (e) => done(e));
    child.on('exit', (code) => {
      if (!stderr.includes('[lockage] ready')) {
        done(new Error(`exited before ready (code=${code}). stderr=${stderr}`));
      }
    });
  });
}

test('no-argument node dist/index.js starts the MCP server', async () => {
  await expectMcpReady([]);
});

test('an unknown argv[2] (serve) also falls back to MCP startup', async () => {
  await expectMcpReady(['serve']);
});
