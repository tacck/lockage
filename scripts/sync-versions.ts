/**
 * Pin every server-launching `npx -y lockage` invocation in the bundled static plugin files to
 * package.json's version (`lockage@<version>`), and keep them pinned mechanically.
 *
 * Why: an unpinned `npx -y lockage` resolves to whatever version npm has cached / the latest
 * published, so a long-lived installed MCP/hook config could silently start running a different
 * version (supply-chain surprise). Pinning to the exact version this repo publishes closes that
 * gap, and because lockage bumps its version at npm-publish time, the pin must move in lockstep.
 * This script is the mechanical lockstep: it rewrites the pinned token from package.json's version.
 *
 * Model: scripts/sync-plugins.ts — exported pure functions, a `--check` CLI mode that lists
 * problems and process.exit(1) (fail-closed), a no-arg rewrite mode, and a main guard
 * `if (process.argv[1] === fileURLToPath(import.meta.url))`. test/plugins.test.ts runs the same
 * checks as --check.
 *
 * Scope of the rewrite: ONLY the `lockage` package token immediately after `-y` is touched (the
 * one in MCP args arrays `["-y","lockage@X.Y.Z"]` and in hook command strings
 * `npx -y lockage@X.Y.Z ...`). The `--agents-md "<...>"` placeholder and every other arg are left
 * untouched. Idempotent: a correctly-pinned token is left alone, a wrong/missing pin is corrected.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The static files that launch lockage via `npx -y lockage` and therefore carry a pinned token. */
export const PINNED_FILES: string[] = [
  'plugins/claude/.mcp.json',
  'plugins/antigravity/mcp_config.json',
  'plugins/kiro/mcp.json',
  'plugins/claude/hooks/hooks.json',
  'plugins/antigravity/hooks.json',
  'plugins/kiro/hooks/lockage-guard.json',
  'plugins/kiro/hooks/lockage-session.json',
];

/**
 * Match only the `lockage` package token that immediately follows `-y`, in both shapes:
 *   - hook command string:  `npx -y lockage@0.9.4 hook ...`  (space-separated)
 *   - MCP args array:        `"-y", "lockage@0.9.4"`         (JSON array elements)
 * The optional `@X.Y.Z` is captured so an unpinned bare `lockage` also matches. The `-y` is kept as
 * a leading anchor (not consumed by the replacement) so nothing else named `lockage` elsewhere (e.g.
 * a description) is touched.
 */
const PIN_RE = /(-y"?\s*,?\s*"?)lockage(@[^\s"]+)?/g;

/** Read package.json's version from the repo root. */
export function packageVersion(root = ROOT): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('package.json has no usable "version"');
  }
  return pkg.version;
}

/** The token every pinned occurrence must read, for the given version. */
function expectedToken(version: string): string {
  return `lockage@${version}`;
}

/** Rewrite the pinned token(s) in a file's text to `lockage@<version>`. Pure: text in, text out. */
export function pinText(text: string, version: string): string {
  return text.replace(PIN_RE, (_m, anchor: string) => `${anchor}lockage@${version}`);
}

/**
 * Return the files whose pinned token does not already match the version (including a file that
 * would change under pinText). A correctly-pinned file is not reported.
 */
export function outOfSync(version = packageVersion(), root = ROOT): string[] {
  return PINNED_FILES.filter((rel) => {
    const path = join(root, rel);
    if (!existsSync(path)) return true;
    const text = readFileSync(path, 'utf8');
    return pinText(text, version) !== text;
  });
}

/** Rewrite every out-of-sync file in place. Returns the relative paths that changed. */
export function sync(version = packageVersion(), root = ROOT): string[] {
  const changed: string[] = [];
  for (const rel of outOfSync(version, root)) {
    const path = join(root, rel);
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, pinText(text, version));
    changed.push(`updated: ${rel}`);
  }
  return changed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = packageVersion();
  if (process.argv.includes('--check')) {
    const problems = outOfSync(version).map(
      (rel) => `${rel} is not pinned to ${expectedToken(version)}`,
    );
    for (const p of problems) console.error(p);
    if (problems.length > 0) {
      console.error('Run `npm run sync:versions` to pin the `npx -y lockage` invocations to package.json\'s version');
      process.exit(1);
    }
  } else {
    for (const line of sync(version)) console.log(line);
  }
}
