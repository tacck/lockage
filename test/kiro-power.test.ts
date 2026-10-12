import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb } from '../src/db/index.ts';
import { buildServer, OPTIONAL_TOOLSETS } from '../src/index.ts';

/**
 * A guard that keeps Kiro Power (plugins/kiro/) from diverging from the server implementation (#77). Kiro
 * Power was built separately during the tool cleanup (#65-#70) and was nearly committed with old names left
 * in the bundled copies and POWER.md. That the bundled copies (AGENTS.md, skills, shared scripts) match the
 * canonical ones is verified in test/plugins.test.ts.
 *
 * In phase 2 the hook decision logic was ported to Node and the hook entry point was unified to
 * `npx -y lockage hook <sub> --client kiro`. So here the hook definition JSON is verified statically
 * (whether command is the npx form, the outer schema, matcher). Verification that runs the decision logic
 * on a real machine (the main-tree edit guard, the SessionStart injected text, self-diagnostic) is handled
 * by test/hook-cli.test.ts, which hits the CLI directly.
 *
 * NOTE: POWER.md is English-only (System A has no Japanese counterpart), so the regex literals below match
 * the English wording.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const POWER = join(ROOT, 'plugins', 'kiro');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

type KiroHook = { name: string; trigger: string; matcher?: string; action: { type: string; command: string } };

/** Read the hooks/ template (the version/hooks outer schema). */
function hookDef(file: string): { version: string; hooks: KiroHook[] } {
  return JSON.parse(read(join(POWER, 'hooks', file))) as { version: string; hooks: KiroHook[] };
}

/** The tool names exposed by a server launched without specifying a toolset (what an agent sees). */
async function coreToolNames(): Promise<string[]> {
  const cdb = openDb({ path: ':memory:', hostId: 'test-host' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'kiro-power-test', version: '0.0.0' });
  await Promise.all([buildServer(cdb).connect(serverT), client.connect(clientT)]);
  const { tools } = await client.listTools();
  cdb.close();
  return tools.map((x) => x.name).sort();
}

test('Kiro Power: POWER.md\'s tool table matches the core tools exposed by default', async () => {
  const core = await coreToolNames();

  const power = read(join(POWER, 'POWER.md'));
  const listed = [...power.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(listed, core);

  // the counts hand-written in the body also match the sizes of the implementation sets
  const count = (re: RegExp): number => {
    const m = power.match(re);
    assert.ok(m, `POWER.md has no description matching ${re}`);
    return Number(m[1]);
  };
  assert.equal(count(/`core` tools \((\d+)\)/), core.length);
  assert.equal(count(/`publisher` set \([^)]*?(\d+) others?\)/), OPTIONAL_TOOLSETS.publisher.length);
  assert.equal(count(/`maintenance` set \([^)]*?(\d+) others?\)/), OPTIONAL_TOOLSETS.maintenance.length);
});

test('Kiro Power: no retired/renamed old tool names or arguments remain', () => {
  // tools removed in #66/#67/#69. for ones renamed to ticket in #70, listing the names misses compound
  // words like ref_issue_id or pending_update_issues, so below we search for "snake_case identifiers that
  // have issue as a word".
  const removed = [
    'release_files',
    'register_context',
    'search_context',
    'list_open_tasks',
    'list_blocked_tasks',
    'list_stale_worktrees',
  ];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '__pycache__') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(POWER);
  for (const file of files) {
    const text = read(file);
    const where = file.slice(ROOT.length);
    for (const name of removed) {
      assert.ok(
        !new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text),
        `${where} still has the removed tool ${name}`,
      );
    }
    // only look at identifiers containing `_`, so the integration branch name lockage/issue/<short id> and "GitHub Issue" are out of scope.
    const renamed = [...text.matchAll(/[A-Za-z0-9_]+/g)]
      .map((m) => m[0])
      .filter((w) => w.includes('_') && w.split('_').some((part) => part === 'issue' || part === 'issues'));
    assert.deepEqual(renamed, [], `${where} still has a pre-rename name`);
    assert.ok(!/--issue(?![A-Za-z0-9_-])/.test(text), `${where} still has the pre-rename --issue`);
  }
});

test('Kiro Power: the guard hook template is an npx-form command with no placeholder', () => {
  // the hook launches with `npx -y lockage hook guard --client kiro` (the Node port retired run.sh/direct python calls).
  // keep the outer schema (version:'v1', each hook's name/trigger/matcher/action.type) in a form Kiro can read.
  const def = hookDef('lockage-guard.json');
  assert.equal(def.version, 'v1');
  const names = def.hooks.map((h) => h.name).sort();
  assert.deepEqual(names, ['lockage-guard-fs-write', 'lockage-guard-str-replace']);
  const matchers = def.hooks.map((h) => h.matcher).sort();
  assert.deepEqual(matchers, ['fs_write', 'str_replace']);
  for (const h of def.hooks) {
    assert.equal(h.trigger, 'PreToolUse');
    assert.equal(h.action.type, 'command');
    assert.equal(h.action.command, 'npx -y lockage hook guard --client kiro');
    // guard does not use AGENTS.md, so it has neither a placeholder nor --agents-md
    assert.ok(!h.action.command.includes('<ABSOLUTE'), h.action.command);
    assert.ok(!h.action.command.includes('--agents-md'), h.action.command);
    assert.ok(!h.action.command.includes('run.sh'), h.action.command);
  }
});

test('Kiro Power: the session hook template is the npx form with only the --agents-md placeholder', () => {
  // the bundled template (an alternate path for hand replacement) cannot pre-fill the absolute path, so it places <ABSOLUTE_PATH_TO_STEERING_AGENTS_MD>.
  // on the main path (lockage setup kiro) the absolute path is filled in (confirmed by the setup test in test/hook-cli.test.ts).
  const def = hookDef('lockage-session.json');
  assert.equal(def.version, 'v1');
  const [session, ...rest] = def.hooks;
  assert.equal(rest.length, 0, 'there is 1 session hook');
  assert.equal(session.name, 'lockage-session');
  assert.equal(session.trigger, 'SessionStart');
  assert.equal(session.matcher, undefined, 'session has no matcher');
  assert.equal(session.action.type, 'command');
  assert.equal(
    session.action.command,
    'npx -y lockage hook session --client kiro --agents-md "<ABSOLUTE_PATH_TO_STEERING_AGENTS_MD>"',
  );
  // no old <ABSOLUTE_PATH_TO_POWER> or run.sh reference remains
  assert.ok(!session.action.command.includes('<ABSOLUTE_PATH_TO_POWER>'), session.action.command);
  assert.ok(!session.action.command.includes('run.sh'), session.action.command);
});

test('Kiro Power: the bundled mcp.json is the npx form with no placeholder', () => {
  // launch the npm-published artifact via npx. no clone/build needed, no placeholder replacement needed, usable as-is.
  const raw = read(join(POWER, 'mcp.json'));
  const lockage = JSON.parse(raw).mcpServers.lockage;
  assert.equal(lockage.command, 'npx');
  assert.deepEqual(lockage.args, ['-y', 'lockage']);
  assert.equal(lockage.disabled, false);
  // no absolute-path etc. placeholder remains (being usable as-is with no replacement is the requirement)
  assert.ok(!raw.includes('<ABSOLUTE'), raw);
  assert.ok(!raw.includes('dist/index.js'), raw);
});
