import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, copies, leftovers, manifestStale, outOfSync, sync } from '../scripts/sync-plugins.ts';
import { outOfSync as versionsOutOfSync, packageVersion } from '../scripts/sync-versions.ts';
import { setupKiro } from '../src/hook/setup-kiro.ts';

/**
 * A guard that keeps each plugin under plugins/ in sync with the canonical files in plugins/shared/ and
 * self-contained. Each client copies only the plugin's directory at install time, so even if it references
 * something outside it works locally and only breaks where it is installed.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

test('plugins: the bundled copies are the same as the canonical files in plugins/shared/', () => {
  assert.ok(copies().length > 0);
  const stale = outOfSync().map(({ from, to }) => `${to}(canonical: ${from})`);
  assert.deepEqual(stale, [], 'sync with npm run sync:plugins (fix the plugins/shared/ canonical, not the copy)');
});

test('plugins: no copy excluded from distribution remains, and the distributed manifest is up to date', () => {
  // debris is an old version of the canonical content, so if it remains and gets loaded no one notices
  assert.deepEqual(leftovers(), [], 'delete with npm run sync:plugins');
  assert.equal(manifestStale(), false, 'rebuild plugins/.sync-manifest with npm run sync:plugins');
});

test('sync-plugins: deletes debris excluded from distribution, fixes diverged copies, and rebuilds the distributed manifest', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'lockage-sync-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  for (const dir of ['plugins']) cpSync(join(ROOT, dir), join(root, dir), { recursive: true });

  // prepare a file distributed before but not now, a diverged copy, a line pointing outside the repo, and CRLF newlines
  writeFileSync(join(root, 'plugins/kiro/old-copy.md'), 'old\n');
  writeFileSync(join(base, 'outside.txt'), 'keep\n');
  const manifest = readFileSync(join(root, MANIFEST), 'utf8');
  writeFileSync(join(root, MANIFEST), `${manifest}plugins/kiro/old-copy.md\n../outside.txt\n`.replaceAll('\n', '\r\n'));
  const [first] = copies();
  writeFileSync(join(root, first.to), 'edited by hand\n');

  assert.deepEqual(leftovers(root), ['plugins/kiro/old-copy.md']);
  assert.deepEqual(outOfSync(root), [first]);
  assert.equal(manifestStale(root), true);

  sync(root);
  assert.ok(!existsSync(join(root, 'plugins/kiro/old-copy.md')), 'deletes debris');
  assert.ok(existsSync(join(base, 'outside.txt')), 'does not delete outside the repo');
  assert.deepEqual(outOfSync(root), []);
  assert.deepEqual(leftovers(root), []);
  assert.equal(manifestStale(root), false);
});

test('sync-plugins: a distributed manifest checked out with CRLF is also considered up to date if it is', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'lockage-sync-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  cpSync(join(ROOT, 'plugins'), join(base, 'plugins'), { recursive: true });
  const manifest = readFileSync(join(base, MANIFEST), 'utf8');
  writeFileSync(join(base, MANIFEST), manifest.replaceAll('\n', '\r\n'));
  assert.equal(manifestStale(base), false);
  assert.deepEqual(leftovers(base), []);
});

test('plugins: the Claude Code plugin bundles the lockage MCP server, launched from the npm-published artifact', () => {
  // The plugin is copied into the cache at install, so it cannot point at a local build (dist/) by absolute path.
  // env is left out so the server inherits LOCKAGE_DB from Claude Code's environment and all agents share the same ledger.
  const { mcpServers } = JSON.parse(read('plugins/claude/.mcp.json'));
  assert.deepEqual(Object.keys(mcpServers), ['lockage']);
  // The npx invocation is pinned to package.json's version (supply-chain hardening); build it from
  // package.json so the assertion never hardcodes a literal and moves in lockstep with the release.
  assert.deepEqual(mcpServers.lockage, { command: 'npx', args: ['-y', 'lockage@' + packageVersion()] });
  assert.equal(
    'mcpServers' in JSON.parse(read('plugins/claude/.claude-plugin/plugin.json')),
    false,
    'define the MCP server only in .mcp.json, not also in plugin.json',
  );
});

test('plugins: the Antigravity plugin bundles the lockage MCP server, launched from the npm-published artifact', () => {
  // The plugin is copied into ~/.gemini/config/plugins/lockage/ at install, so it cannot point at a local build (dist/) by absolute path.
  // env is left out so the server inherits LOCKAGE_DB from Antigravity's environment and all agents share the same ledger.
  const { mcpServers } = JSON.parse(read('plugins/antigravity/mcp_config.json'));
  assert.deepEqual(Object.keys(mcpServers), ['lockage']);
  // The npx invocation is pinned to package.json's version (supply-chain hardening); build it from
  // package.json so the assertion never hardcodes a literal and moves in lockstep with the release.
  assert.deepEqual(mcpServers.lockage, { command: 'npx', args: ['-y', 'lockage@' + packageVersion()] });
  assert.equal(
    'mcpServers' in JSON.parse(read('plugins/antigravity/plugin.json')),
    false,
    'define the MCP server only in mcp_config.json, not also in plugin.json',
  );
});

test('plugins: align the version of the Claude Code and Antigravity plugins with the npm package', () => {
  // The plugins launch the npm package via a version-pinned npx (lockage@<version>), so the plugin
  // version, package.json, and the pin must all name the same contents or a user's report is ambiguous.
  const version = (path: string): string => JSON.parse(read(path)).version;
  const plugin = version('plugins/claude/.claude-plugin/plugin.json');
  assert.equal(version('plugins/antigravity/plugin.json'), plugin);
  assert.equal(version('package.json'), plugin, 'bump package.json together with the plugins');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, plugin, 'update package-lock.json too (npm install)');
  assert.equal(lock.packages[''].version, plugin, 'update package-lock.json too (npm install)');
});

test('plugins: every bundled `npx -y lockage` is pinned to package.json\'s version (fail-closed gate)', () => {
  // Supply-chain hardening: an unpinned `npx -y lockage` resolves to whatever npm has cached / the
  // latest published, so a long-lived installed MCP/hook config could silently start running a
  // different version. Every server-launching occurrence in the 7 static files (3 MCP + 4 hook defs)
  // must read `lockage@<package.json version>`. We reuse scripts/sync-versions.ts's outOfSync (the same
  // detector the `npm run sync:versions -- --check` gate uses) so this test and the sync script cannot
  // drift — mirroring how the plugins copy tests reuse outOfSync/leftovers from sync-plugins.ts above.
  const stale = versionsOutOfSync();
  assert.deepEqual(
    stale,
    [],
    `pin with npm run sync:versions (expected lockage@${packageVersion()} in every bundled npx invocation)`,
  );
});

test('setup kiro: the generated hook commands embed lockage@<package.json version>', (t) => {
  // The main install path (lockage setup kiro) generates the hooks at runtime; assert the version it
  // embeds comes from package.json (never a hardcoded literal). Run the generator against a temp dir
  // like test/hook-cli.test.ts does — do NOT launch `npx -y lockage` (it would resolve to the worktree's dist/).
  const base = mkdtempSync(join(tmpdir(), 'lockage-setup-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const result = setupKiro({ repo: base });
  assert.equal(result.exitCode, 0);

  const hooksDir = join(base, '.kiro', 'hooks');
  const guard = JSON.parse(readFileSync(join(hooksDir, 'lockage-guard.json'), 'utf8'));
  const session = JSON.parse(readFileSync(join(hooksDir, 'lockage-session.json'), 'utf8'));

  const expected = `lockage@${packageVersion()}`;
  for (const h of guard.hooks) {
    assert.ok(h.action.command.includes(expected), h.action.command);
  }
  assert.ok(session.hooks[0].action.command.includes(expected), session.hooks[0].action.command);
});
