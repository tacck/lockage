/**
 * Per-client adapters. They call the pure logic in repo.ts / context.ts / guard.ts, parse each
 * client's input (claude / antigravity / kiro), and build the response. Only the input/output
 * shapes are client-specific; the decision logic itself stays inside the pure logic.
 *
 * The final control of exit codes and stdout/stderr is handled by the outermost shell in
 * dispatch.ts. Here we decide "what to output", and dispatch.ts handles "how to output it" (write
 * the JSON to stdout / set the exit code). Rather than returning both side effects (record, stderr
 * log) and an "output payload", each adapter function returns a value natural to its client.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildContext, DEFAULT_HEADER } from './context.js';
import type { BuildContextOptions } from './context.js';
import { decide, record } from './guard.js';
import type { GuardPayload } from './guard.js';
import { inUse, log, mainTreeRoot, repoState } from './repo.js';

/** The heading used by the kiro session (the kiro version of HEADER). */
const KIRO_HEADER = '## lockage coordinated development (lockage Kiro Power)\n';

/** Parse a JSON string. Unparseable / non-JSON is treated as an empty object. */
function parsePayload(stdin: string): Record<string, unknown> {
  try {
    const v = JSON.parse(stdin);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// --- claude ------------------------------------------------------------------

/** Input for the claude guard. */
interface ClaudeGuardPayload extends GuardPayload {
  hook_event_name?: string | null;
}

/**
 * Result of the claude guard. Returns the JSON to write to stdout (null if none). record is already
 * performed as a side effect. For PreToolUse, if decide returns a reason, an ask JSON, otherwise no
 * output. For PostToolUse, record and output nothing.
 */
export function claudeGuard(stdin: string): object | null {
  const payload = parsePayload(stdin) as ClaudeGuardPayload;
  if (payload.hook_event_name === 'PostToolUse') {
    record(payload);
    return null;
  }
  const reason = decide(payload);
  if (reason === null) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  };
}

/** Input for the claude session. */
interface ClaudeSessionPayload {
  hook_event_name?: string | null;
  agent_type?: string | null;
  cwd?: string | null;
}

/**
 * Build the fixed text for lockage-worker.
 * Distinct from buildContext: even if the worker is started outside git, pass at least the location
 * of the canonical rules.
 */
function buildWorkerContext(agentsMd: string, mainRoot: string | null): string {
  let context = DEFAULT_HEADER + `- canonical coordination rules: ${agentsMd} (read it with Read before starting work)\n`;
  if (mainRoot !== null) {
    context += `- repository of the launch location: ${mainRoot}\n`;
  }
  return context;
}

/**
 * Result of the claude session. Returns the JSON to write to stdout (null if none).
 * For SessionStart, no output if repoState(cwd) is null, otherwise buildContext as
 * additionalContext. For SubagentStart, no output unless agent_type includes lockage-worker, in
 * which case buildWorkerContext as additionalContext. The output JSON's hookEventName echoes the
 * input event name.
 */
export function claudeSession(stdin: string, agentsMd: string): object | null {
  const payload = parsePayload(stdin) as ClaudeSessionPayload;
  const event = payload.hook_event_name || 'SessionStart';
  // Add nothing for subagents unrelated to lockage. Decide this before calling git
  if (event === 'SubagentStart' && !(payload.agent_type || '').includes('lockage-worker')) {
    return null;
  }
  const st = repoState(payload.cwd || process.cwd());

  let context: string;
  if (event === 'SubagentStart') {
    context = buildWorkerContext(agentsMd, st === null ? null : st.mainRoot);
  } else {
    if (st === null) return null; // inject nothing outside a git repository
    context = buildContext(st, { agentsMd, readTool: 'Read' });
  }

  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

// --- antigravity -------------------------------------------------------------

/** Input for the antigravity guard. */
interface AntigravityGuardPayload {
  toolCall?: { args?: { TargetFile?: string | null } | null } | null;
  workspacePaths?: string[] | null;
  conversationId?: string | null;
  error?: unknown;
}

/** Normalize antigravity input into the claude-shaped guard payload. */
function toGuardPayload(payload: AntigravityGuardPayload): GuardPayload {
  const args = payload.toolCall?.args ?? {};
  const workspaces = payload.workspacePaths ?? [];
  return {
    tool_input: { file_path: args.TargetFile ?? null },
    // Resolve relative paths from the workspace (the hook's working directory depends on the caller)
    cwd: workspaces.length > 0 ? workspaces[0] : null,
    session_id: payload.conversationId ?? null,
  };
}

/** The default response when the antigravity guard "passes" (built each time). */
function antigravityPass(): object {
  return { decision: 'ask' };
}

/**
 * Result of the antigravity guard. Always returns an output JSON (returning nothing is treated as
 * deny, so always return a decision).
 * pre: decide null→{decision:'ask'}, with a reason→{decision:'force_ask',reason}.
 * post: record only when there is no error, always {}.
 */
export function antigravityGuard(stdin: string, event: 'pre' | 'post'): object {
  const payload = parsePayload(stdin) as AntigravityGuardPayload;
  if (event === 'pre') {
    const reason = decide(toGuardPayload(payload));
    if (reason === null) return antigravityPass();
    return { decision: 'force_ask', reason };
  }
  // post: do not record when the tool failed (there is an error)
  if (!payload.error) {
    record(toGuardPayload(payload));
  }
  return {};
}

/** Input for the antigravity session. */
interface AntigravitySessionPayload {
  invocationNum?: number | null;
  transcriptPath?: string | null;
  workspacePaths?: string[] | null;
}

/** Whether a transcript line is an EPHEMERAL_MESSAGE we injected. */
function isOurMessage(line: string): boolean {
  // To avoid parsing every line even for a large transcript, narrow by string first, then parse
  if (!line.includes('EPHEMERAL_MESSAGE')) return false;
  let step: Record<string, unknown>;
  try {
    step = JSON.parse(line);
  } catch {
    return false;
  }
  return step.type === 'EPHEMERAL_MESSAGE' && String(step.content ?? '').startsWith(DEFAULT_HEADER);
}

/** Expand a `~`-prefixed path with homedir (minimal version). */
function expandUser(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/** Whether the text has already been injected into the conversation. Unreadable/not-yet-created is false. */
function alreadyInjected(transcriptPath: string | null | undefined): boolean {
  if (!transcriptPath) return false;
  let content: string;
  try {
    content = readFileSync(expandUser(transcriptPath), { encoding: 'utf8' });
  } catch {
    // The transcript is not written yet (first call) or unreadable. Prefer injecting again over missing it
    return false;
  }
  return content.split('\n').some((line) => isOurMessage(line));
}

/**
 * Result of the antigravity session. Returns the JSON to inject (injectSteps or {}).
 * If invocationNum!==0 or already injected, {}; otherwise concatenate buildContext over
 * workspacePaths in order, deduplicating by repoState→mainRoot??toplevel.
 */
export function antigravitySession(stdin: string, agentsMd: string): object {
  const payload = parsePayload(stdin) as AntigravitySessionPayload;
  const message = buildAntigravityMessage(payload, agentsMd);
  return message ? { injectSteps: [{ ephemeralMessage: message }] } : {};
}

function buildAntigravityMessage(
  payload: AntigravitySessionPayload,
  agentsMd: string,
): string | null {
  // Read the transcript only when invocationNum is 0 (do not re-read every time)
  if (payload.invocationNum !== 0) return null;
  if (alreadyInjected(payload.transcriptPath)) return null;
  const contexts: string[] = [];
  const seen = new Set<string>();
  const opts: BuildContextOptions = { agentsMd, readTool: 'view_file' };
  for (const workspace of payload.workspacePaths ?? []) {
    const st = repoState(workspace);
    if (st === null) continue; // outside a git repository
    const key = st.mainRoot ?? st.toplevel;
    if (seen.has(key)) continue;
    seen.add(key);
    contexts.push(buildContext(st, opts));
  }
  return contexts.length > 0 ? contexts.join('\n') : null;
}

// --- kiro ---------------------------------------------------------------------

// Exit codes for the kiro guard. PreToolUse is fail-closed.
export const KIRO_EXIT_ALLOW = 0;
export const KIRO_EXIT_DENY = 2;

/** Input for the kiro guard. Looks at file_path or path. */
interface KiroGuardPayload {
  hook_event_name?: string | null;
  tool_name?: string | null;
  tool_input?: { file_path?: string | null; path?: string | null } | null;
  cwd?: string | null;
}

/**
 * Decision result of the kiro guard. Returns an exit code. Messages to stderr are emitted inside
 * this function.
 * - PostToolUse → exit 0 (a defensive contract; not called by the generated hook)
 * - path unavailable → exit 0 + stderr warning (the list of tool_input keys)
 * - mainTreeRoot !== null → exit 2 + stderr message
 * - otherwise → exit 0
 * Exceptions (e.g. a git parse error) are made fail-closed (exit 2) by the outermost shell in
 * dispatch.ts.
 */
export function kiroGuard(stdin: string): number {
  const payload = parsePayload(stdin) as KiroGuardPayload;
  // In Kiro, PostToolUse is only a post-hoc notification; this Power keeps no memory of allowances, so it does not decide (always allow)
  if (payload.hook_event_name === 'PostToolUse') return KIRO_EXIT_ALLOW;

  const toolInput = payload.tool_input ?? {};
  const path = toolInput.file_path || toolInput.path;
  if (!path) {
    const keys = Object.keys(payload.tool_input ?? {}).sort();
    log(
      `Could not extract the edit target path from ${payload.tool_name}'s tool_input, so allowed without deciding` +
      ` (tool_input keys: [${keys.join(', ')}]; expected via file_path or path).`,
    );
    return KIRO_EXIT_ALLOW;
  }
  if (mainTreeRoot(path, payload.cwd ?? undefined) === null) {
    return KIRO_EXIT_ALLOW;
  }
  process.stderr.write(
    'This edit target is the main working tree of a repository operating under lockage. ' +
    'If you are working as a lockage task, edit inside the worktree_path returned by assign_worktree. ' +
    'If you must edit the main working tree directly, set the environment variable LOCKAGE_GUARD_DISABLE=1 to disable the guard.\n',
  );
  return KIRO_EXIT_DENY;
}

/** Input for the kiro session. */
interface KiroSessionPayload {
  cwd?: string | null;
}

/**
 * Result of the kiro session. Returns the text to write to stdout (null if none).
 * No output if repoState(cwd) is null, otherwise buildContext (KIRO_HEADER) as stdout text.
 * Appends a self-diagnostic at the end inside the kiro adapter.
 */
export function kiroSession(stdin: string, agentsMd: string): string | null {
  const payload = parsePayload(stdin) as KiroSessionPayload;
  const st = repoState(payload.cwd || process.cwd());
  if (st === null) return null; // inject nothing outside a git repository
  let text = buildContext(st, { agentsMd, readTool: 'Read', header: KIRO_HEADER });
  text += kiroGuardDiagnostic(st.mainRoot ?? st.toplevel);
  return text;
}

/**
 * Self-diagnostic for a missing guard hook. Looks at .kiro/hooks/lockage-guard.json directly under
 * the main repository, and returns a one-line warning if it is missing. Returns an empty string
 * (appends nothing) if present or on exception. This does not pollute buildContext itself; it is
 * done only inside the kiro adapter.
 */
function kiroGuardDiagnostic(base: string): string {
  try {
    const guardPath = join(base, '.kiro', 'hooks', 'lockage-guard.json');
    if (!existsSync(guardPath)) {
      return '- The guard hook is not installed. Run npx -y lockage setup kiro to install the guard hook.\n';
    }
  } catch {
    // Swallow a diagnostic failure and append nothing (injection-only; never deny)
  }
  return '';
}
