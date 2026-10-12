/**
 * CLI dispatcher for `lockage hook <guard|session>` / `lockage setup kiro`.
 *
 * The entry section of src/index.ts dynamically imports and calls here only when argv[2]==='hook'
 * || 'setup'. With no args or an unknown argv[2], index.ts starts the MCP server (main) as before,
 * so we never reach here.
 *
 * design.md §1/§3 is authoritative. CLI forms:
 *   lockage hook guard   --client <claude|antigravity|kiro> [--event pre|post] [--agents-md <path>]
 *   lockage hook session --client <claude|antigravity|kiro> [--agents-md <path>]
 *   lockage setup kiro   [--repo <path>] [--force]
 *
 * The per-client exit-code/stdout control (claude/antigravity return a passing response + exit 0 on
 * exception; kiro guard is fail-closed exit 2 on exception; kiro session is exit 0 on exception) is
 * branched by this outermost shell according to --client and the subcommand type (the layer that
 * owns the invariant "only kiro guard is fail-closed").
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  antigravityGuard,
  antigravitySession,
  claudeGuard,
  claudeSession,
  KIRO_EXIT_ALLOW,
  KIRO_EXIT_DENY,
  kiroGuard,
  kiroSession,
} from './clients.js';
import { log } from './repo.js';
import { setupKiro } from './setup-kiro.js';

type Client = 'claude' | 'antigravity' | 'kiro';

const USAGE =
  `lockage hook <guard|session> --client <claude|antigravity|kiro> [--event pre|post] [--agents-md <path>]\n` +
  `lockage setup kiro [--repo <path>] [--force]\n\n` +
  `hook:\n` +
  `  guard    Guard for editing the main working tree. Pass the hook payload JSON on stdin.\n` +
  `  session  Context injection at session start. Pass the hook payload JSON on stdin.\n` +
  `  --client   claude | antigravity | kiro (required)\n` +
  `  --event    pre | post (required for antigravity guard; claude/kiro use the input's hook_event_name)\n` +
  `  --agents-md  path to the canonical coordination rules (AGENTS.md) (only placed in the text)\n\n` +
  `setup kiro:\n` +
  `  --repo <path>  the target repository root (default cwd)\n` +
  `  --force        overwrite an existing hook definition without confirmation\n`;

/** Write usage to stderr and exit non-zero (does not fall back to MCP). */
function usageError(msg: string): never {
  process.stderr.write(`lockage: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

/** Read all of stdin (called only by hook guard/session). Empty becomes an empty string. */
function readStdin(): string {
  try {
    return readFileSync(0, { encoding: 'utf8' });
  } catch {
    // When there is no stdin / it cannot be read, treat it as an empty payload (clients.ts handles empty safely)
    return '';
  }
}

/** Validate the --client value. */
function requireClient(value: string | undefined): Client {
  if (value === 'claude' || value === 'antigravity' || value === 'kiro') return value;
  usageError(`--client must be one of claude|antigravity|kiro (received: ${value ?? '(none)'})`);
}

/**
 * CLI entry point. argv is process.argv.slice(2) (first element is 'hook' or 'setup').
 */
export async function dispatchCli(argv: string[]): Promise<void> {
  const [group, sub, ...rest] = argv;
  if (group === 'hook') {
    return dispatchHook(sub, rest);
  }
  if (group === 'setup') {
    return dispatchSetup(sub, rest);
  }
  // The entry section of index.ts calls here only for hook/setup, so we normally never reach here
  usageError(`unknown subcommand: ${group ?? '(none)'}`);
}

/** Handle `lockage hook <guard|session> ...`. */
function dispatchHook(sub: string | undefined, rest: string[]): void {
  if (sub !== 'guard' && sub !== 'session') {
    usageError(`the hook subcommand must be guard|session (received: ${sub ?? '(none)'})`);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      client: { type: 'string' },
      event: { type: 'string' },
      'agents-md': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const client = requireClient(values.client);
  const agentsMd = values['agents-md'] ?? '';

  if (sub === 'guard') {
    dispatchGuard(client, values.event, agentsMd);
    return;
  }
  dispatchSession(client, agentsMd);
}

/** Handle the guard subcommand per client. The outermost shell controls exit code and stdout. */
function dispatchGuard(client: Client, event: string | undefined, _agentsMd: string): void {
  // Disable switch. Returns a path-dependent "pass" response and does not even read stdin (design.md §3)
  const disabled = process.env.LOCKAGE_GUARD_DISABLE === '1';

  if (client === 'claude') {
    try {
      if (disabled) return; // no output, no record, exit immediately
      const out = claudeGuard(readStdin());
      if (out !== null) process.stdout.write(JSON.stringify(out));
    } catch (e) {
      // When it cannot decide, pass (do not stop the edit itself due to a hook defect). No output + exit 0
      log(`guard(claude) failed, so passed without deciding: ${String(e)}`);
    }
    return;
  }

  if (client === 'antigravity') {
    if (event !== 'pre' && event !== 'post') {
      usageError('antigravity guard requires --event pre|post');
    }
    try {
      if (disabled) {
        // pre→{decision:'ask'}, post→{} (mode-dependent, no record, does not read stdin)
        process.stdout.write(JSON.stringify(event === 'pre' ? { decision: 'ask' } : {}));
        return;
      }
      const out = antigravityGuard(readStdin(), event);
      process.stdout.write(JSON.stringify(out));
    } catch (e) {
      // When it cannot decide, leave it to the usual permission check (pre=ask / post={}) + exit 0
      log(`guard(antigravity) failed, so passed without deciding: ${String(e)}`);
      process.stdout.write(JSON.stringify(event === 'pre' ? { decision: 'ask' } : {}));
    }
    return;
  }

  // kiro: decide via exit code (fail-closed). Does not read stdin if disabled either
  try {
    if (disabled) {
      process.exit(KIRO_EXIT_ALLOW);
    }
    process.exit(kiroGuard(readStdin()));
  } catch (e) {
    // On exception, fail safe and deny (exit 2)
    log(`guard(kiro) failed, so failed safe and denied: ${String(e)}`);
    process.exit(KIRO_EXIT_DENY);
  }
}

/** Handle the session subcommand per client. On exception, all inject nothing + exit 0. */
function dispatchSession(client: Client, agentsMd: string): void {
  if (client === 'claude') {
    try {
      const out = claudeSession(readStdin(), agentsMd);
      if (out !== null) process.stdout.write(JSON.stringify(out));
    } catch (e) {
      log(`session(claude) failed, so injected nothing: ${String(e)}`);
    }
    return;
  }
  if (client === 'antigravity') {
    try {
      const out = antigravitySession(readStdin(), agentsMd);
      process.stdout.write(JSON.stringify(out));
    } catch (e) {
      // Do not hinder the model invocation (emit {})
      log(`session(antigravity) failed, so injected nothing: ${String(e)}`);
      process.stdout.write(JSON.stringify({}));
    }
    return;
  }
  // kiro: text to stdout (not JSON). On exception, no output, exit 0
  try {
    const text = kiroSession(readStdin(), agentsMd);
    if (text !== null) process.stdout.write(text);
  } catch (e) {
    log(`session(kiro) failed, so injected nothing: ${String(e)}`);
  }
}

/** Handle `lockage setup kiro ...`. */
function dispatchSetup(sub: string | undefined, rest: string[]): void {
  if (sub !== 'kiro') {
    usageError(`the setup subcommand must be kiro (received: ${sub ?? '(none)'})`);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      repo: { type: 'string' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    const result = setupKiro({ repo: values.repo, force: values.force });
    for (const line of result.lines) process.stdout.write(line + '\n');
    process.exitCode = result.exitCode;
  } catch (e) {
    // A mkdir/write failure or a --repo pointing to a nonexistent directory is fatal (stderr + non-zero exit)
    process.stderr.write(`lockage setup kiro: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
