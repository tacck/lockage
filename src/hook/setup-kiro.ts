/**
 * The body of `lockage setup kiro`. Generates lockage-guard.json and lockage-session.json in the
 * target repository's .kiro/hooks/ with npx-form commands (folding in a manual copy + absolute-path
 * substitution).
 *
 * design.md §5 is authoritative. The install base is mainRoot ?? toplevel (the main repository root)
 * from running --repo (default cwd) through repoState. If repoState is null (outside git), it is
 * directly under --repo's real path. Even when run inside a worktree, the correct place for the hook
 * is the main repository, so it is generated in .kiro/hooks/ directly under the main root.
 *
 * The outer schema of the generated JSON is identical to the bundled templates plugins/kiro/hooks/*.json
 * (version/name/trigger/matcher/action). Kiro reads the hook via this outer shape, so dropping the
 * structure makes it silently a no-op.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { repoState } from './repo.js';

/** Options for setup kiro. */
export interface SetupKiroOptions {
  // The target repository root. Default is process.cwd().
  repo?: string;
  // Overwrite existing files without confirmation.
  force?: boolean;
}

/** The per-file processing result. */
type FileResult = 'created' | 'updated' | 'unchanged' | 'skipped-needs-force';

/** The result of setup kiro (dispatch.ts maps it to an exit code). */
export interface SetupKiroResult {
  // Exit code (only created/updated/unchanged → 0; non-zero if there is at least one skipped-needs-force).
  exitCode: number;
  // Lines to write to stdout (one path+result per line).
  lines: string[];
}

/** The type of the generated hook definition (Kiro's outer schema). */
interface KiroHookDef {
  version: string;
  hooks: Array<{
    name: string;
    trigger: string;
    matcher?: string;
    action: { type: 'command'; command: string };
  }>;
}

/** Build the contents of lockage-guard.json (2 PreToolUse matchers; no --agents-md). */
function guardDef(): KiroHookDef {
  const command = 'npx -y lockage hook guard --client kiro';
  return {
    version: 'v1',
    hooks: [
      {
        name: 'lockage-guard-fs-write',
        trigger: 'PreToolUse',
        matcher: 'fs_write',
        action: { type: 'command', command },
      },
      {
        name: 'lockage-guard-str-replace',
        trigger: 'PreToolUse',
        matcher: 'str_replace',
        action: { type: 'command', command },
      },
    ],
  };
}

/** Build the contents of lockage-session.json (1 SessionStart hook; embed base's steering path in --agents-md). */
function sessionDef(base: string): KiroHookDef {
  const agentsMd = join(base, '.kiro', 'steering', 'AGENTS.md');
  return {
    version: 'v1',
    hooks: [
      {
        name: 'lockage-session',
        trigger: 'SessionStart',
        action: {
          type: 'command',
          command: `npx -y lockage hook session --client kiro --agents-md "${agentsMd}"`,
        },
      },
    ],
  };
}

/** Turn the JSON into formatted text with a trailing newline (use the same formatting for existing-file comparison and writing). */
function serialize(def: KiroHookDef): string {
  return JSON.stringify(def, null, 2) + '\n';
}

/** Generate/compare one file. Returns the result (created/updated/unchanged/skipped-needs-force). */
function writeHookFile(path: string, content: string, force: boolean): FileResult {
  if (existsSync(path)) {
    const existing = readFileSync(path, { encoding: 'utf8' });
    if (existing === content) return 'unchanged';
    if (!force) return 'skipped-needs-force';
    writeFileSync(path, content);
    return 'updated';
  }
  writeFileSync(path, content);
  return 'created';
}

/**
 * Derive the install base directory. mainRoot ?? toplevel from running --repo (default cwd) through
 * repoState; if repoState is null, directly under --repo's real path (§5). Throws if --repo is a
 * nonexistent directory.
 */
function resolveBase(repo: string): string {
  const abs = resolve(repo);
  // A --repo pointing to a nonexistent directory is fatal (stderr + non-zero)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`--repo is not an existing directory: ${abs}`);
  }
  const st = repoState(abs);
  if (st === null) return abs; // can also be placed in a directory outside git
  return st.mainRoot ?? st.toplevel;
}

/**
 * The body of setup kiro. Creates .kiro/hooks/ and generates lockage-guard.json / lockage-session.json.
 * A mkdir/write failure or a --repo pointing to a nonexistent directory throws (the outermost shell
 * in dispatch.ts turns it into stderr + non-zero).
 */
export function setupKiro(opts: SetupKiroOptions): SetupKiroResult {
  const base = resolveBase(opts.repo ?? process.cwd());
  const force = opts.force ?? false;
  const hooksDir = join(base, '.kiro', 'hooks');
  mkdirSync(hooksDir, { recursive: true });

  const targets: Array<{ path: string; content: string }> = [
    { path: join(hooksDir, 'lockage-guard.json'), content: serialize(guardDef()) },
    { path: join(hooksDir, 'lockage-session.json'), content: serialize(sessionDef(base)) },
  ];

  const lines: string[] = [];
  let needsForce = false;
  for (const { path, content } of targets) {
    const result = writeHookFile(path, content, force);
    if (result === 'skipped-needs-force') {
      needsForce = true;
      lines.push(`${path}: skipped-needs-force (differs from the existing file; overwrite with --force)`);
    } else {
      lines.push(`${path}: ${result}`);
    }
  }

  return { exitCode: needsForce ? 1 : 0, lines };
}
