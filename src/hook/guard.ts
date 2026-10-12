/**
 * Decision for the main-working-tree edit guard. The input/output is normalized to the claude shape
 * { tool_input, cwd, session_id } by each client's adapter (clients.ts) before being passed in.
 *
 * In a repository operating under lockage, if an edit targets a file in the main working tree rather
 * than a worktree, interpose a confirmation. We use a confirmation instead of deny so as not to
 * block the case where a person works on the main tree without using lockage (Kiro, which cannot
 * show a confirmation, falls back to deny).
 *
 * The confirmation keeps appearing until it is allowed. Once allowed and the edit actually happens
 * (PostToolUse), we no longer ask for that session and that repository. An operating repository
 * always leaves traces such as a lockage/ branch or .lockage/, so asking every time would cause
 * confirmation fatigue — leading to always allowing it, or disabling the guard entirely so it
 * becomes a mere formality. We do not place the mark at PreToolUse time because the hook cannot
 * distinguish allow from deny, which would let even a post-deny edit slip through.
 */

import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log, mainTreeRoot } from './repo.js';

// Windows has no getuid. Do not crash on read; fall back to asking every time without using the mark (usableStateDir).
const UID = typeof process.getuid === 'function' ? process.getuid() : null;

// Where the "editing this repo's main working tree was allowed in this session" mark is placed. It
// is the OS temp directory, so it is cleared on reboot. Linux's /tmp is shared across all users, so
// separate it per user.
export const STATE_DIR =
  process.env.LOCKAGE_GUARD_STATE_DIR || join(tmpdir(), `lockage-plugin-guard-${UID}`);

/** The claude-shaped hook payload. antigravity / kiro inputs are normalized to this shape by the adapters. */
export interface GuardPayload {
  tool_input?: { file_path?: string | null; notebook_path?: string | null } | null;
  cwd?: string | null;
  session_id?: string | null;
}

/**
 * true if a state directory writable only by us could be prepared.
 *
 * If another user created the same name first, they could place the mark and disable the guard, so
 * we do not use it (we ask every time then). We also do not use it in an environment where we
 * cannot verify ownership (no getuid).
 */
function usableStateDir(stateDir: string): boolean {
  if (UID === null) return false;
  let st: ReturnType<typeof statSync>;
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    st = statSync(stateDir);
  } catch (e) {
    log(`Cannot prepare the state directory, so not using the confirmed record: ${String(e)}`);
    return false;
  }
  if (st.uid !== UID || (st.mode & 0o077) !== 0) {
    log(`The state directory is not exclusively ours, so not using the confirmed record: ${stateDir}`);
    return false;
  }
  return true;
}

/** Resolve the main-working-tree edit target (the main repository root) from the payload. */
function mainTreeTarget(payload: GuardPayload): string | null {
  const toolInput = payload.tool_input ?? {};
  const path = toolInput.file_path || toolInput.notebook_path;
  if (!path) return null;
  return mainTreeRoot(path, payload.cwd ?? undefined);
}

/** Determine the mark file path from the session_id and the main repository path. */
function markPath(sessionId: string, mainRoot: string, stateDir: string): string {
  const key = createHash('sha256').update(`${sessionId}\0${mainRoot}`).digest('hex');
  return join(stateDir, key);
}

/**
 * PreToolUse: returns the reason string if a confirmation should be interposed, or null if not.
 */
export function decide(payload: GuardPayload, stateDir: string = STATE_DIR): string | null {
  const mainRoot = mainTreeTarget(payload);
  if (mainRoot === null) return null;
  const sessionId = payload.session_id;
  if (
    sessionId &&
    usableStateDir(stateDir) &&
    existsSyncSafe(markPath(sessionId, mainRoot, stateDir))
  ) {
    return null;
  }
  return (
    `${mainRoot} is a repository operating under lockage, and the edit targets its main working tree. ` +
    'If you are working as a lockage task, edit inside the worktree_path returned by assign_worktree. ' +
    'If you are editing the main tree directly as work that does not use lockage, go ahead and allow it. ' +
    'If you allow it, this session will no longer confirm edits to this repository\'s main working tree.'
  );
}

/**
 * PostToolUse: record that an edit to the main working tree actually happened (= was allowed).
 */
export function record(payload: GuardPayload, stateDir: string = STATE_DIR): void {
  const sessionId = payload.session_id;
  if (!sessionId) return; // when the session cannot be identified, do not record; ask every time
  const mainRoot = mainTreeTarget(payload);
  if (mainRoot === null || !usableStateDir(stateDir)) return;
  closeSync(openSync(markPath(sessionId, mainRoot, stateDir), 'w'));
}

/** Check the mark file's existence (statSync throws on a nonexistent path, so swallow it). */
function existsSyncSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
