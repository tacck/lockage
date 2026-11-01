/**
 * The body of `lockage setup kiro`. Generates lockage-guard.json and lockage-session.json in the
 * target repository's .kiro/hooks/ with version-pinned npx-form commands (`npx -y lockage@<version>`;
 * folding in a manual copy + absolute-path substitution). The commands are pinned to this package's
 * own version rather than the bare `lockage` so an installed hook keeps invoking the version it was
 * generated with (supply-chain hardening).
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

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { repoState } from './repo.js';
import { readPackageVersion } from '../version.js';

// The npx form of the generated hook commands is pinned to this package's own version
// (lockage@<version>) rather than the bare `lockage` (which would resolve to whatever npm
// has cached / latest). Pinning guards against a supply-chain surprise where a newer
// published version silently changes behavior under a long-lived installed hook. The value
// is read from package.json at runtime, so a release that bumps the version automatically
// emits hooks pinned to the matching version.
const version = readPackageVersion();

/** Options for setup kiro. */
export interface SetupKiroOptions {
  // The target repository root. Default is process.cwd().
  repo?: string;
  // Overwrite existing files without confirmation.
  force?: boolean;
  // 協調ルール(AGENTS.md)のパスを明示指定する。指定時は自動探索より優先する。
  agentsMd?: string;
  // Power のインストール先を探すホームディレクトリ(テスト用。既定は os.homedir())。
  homeDir?: string;
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
  const command = `npx -y lockage@${version} hook guard --client kiro`;
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
function sessionDef(agentsMd: string): KiroHookDef {
  return {
    version: 'v1',
    hooks: [
      {
        name: 'lockage-session',
        trigger: 'SessionStart',
        action: {
          type: 'command',
          command: `npx -y lockage@${version} hook session --client kiro --agents-md "${agentsMd}"`,
        },
      },
    ],
  };
}

/** POWER.md の front matter から `name` の値を取り出す(無ければ null)。 */
function readPowerName(powerMdPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(powerMdPath, { encoding: 'utf8' });
  } catch {
    return null;
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm === null) return null;
  const m = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm[1]);
  return m === null ? null : m[1];
}

/**
 * ~/.kiro/powers/installed/ 配下から、POWER.md の front matter が `name: "lockage"` のフォルダを探し、
 * その steering/AGENTS.md の絶対パスを返す。フォルダ名は決め打ちしない(導入元のフォルダ名になるため)。
 * 見つからなければ null。
 */
export function findPowerAgentsMd(home: string): string | null {
  const installed = join(home, '.kiro', 'powers', 'installed');
  let entries: string[];
  try {
    entries = readdirSync(installed).sort();
  } catch {
    return null;
  }
  for (const dir of entries) {
    if (readPowerName(join(installed, dir, 'POWER.md')) !== 'lockage') continue;
    const candidate = join(installed, dir, 'steering', 'AGENTS.md');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * hook に埋める AGENTS.md のパスを決める。優先順位: --agents-md 明示 > 導入先 .kiro/steering/AGENTS.md
 * > Power のインストール先。どれも無ければ導入先の既定パスを返し、警告を付ける。
 */
function resolveAgentsMd(base: string, opts: SetupKiroOptions): { path: string; warning: string | null } {
  if (opts.agentsMd !== undefined && opts.agentsMd !== '') {
    const path = resolve(opts.agentsMd);
    return {
      path,
      warning: existsSync(path) ? null : `warning: --agents-md で指定したファイルが存在しません: ${path}`,
    };
  }
  const local = join(base, '.kiro', 'steering', 'AGENTS.md');
  if (existsSync(local)) return { path: local, warning: null };
  const fromPower = findPowerAgentsMd(opts.homeDir ?? homedir());
  if (fromPower !== null) return { path: fromPower, warning: null };
  return {
    path: local,
    warning:
      `warning: AGENTS.md が見つかりません(${local} と ~/.kiro/powers/installed/*/ の name: "lockage" の Power を探しました)。` +
      ' 既定のパスを埋めましたが存在しません。--agents-md <path> で明示するか、Power を導入してから再実行してください',
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

  const agentsMd = resolveAgentsMd(base, opts);
  const targets: Array<{ path: string; content: string }> = [
    { path: join(hooksDir, 'lockage-guard.json'), content: serialize(guardDef()) },
    { path: join(hooksDir, 'lockage-session.json'), content: serialize(sessionDef(agentsMd.path)) },
  ];

  const lines: string[] = [];
  if (agentsMd.warning !== null) lines.push(agentsMd.warning);
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
