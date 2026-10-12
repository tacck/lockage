/**
 * The text passed to the model at the start of a session (the repository state, and the location
 * of the canonical coordination rules).
 *
 * How it is delivered (claude's SessionStart, antigravity's PreInvocation, kiro's SessionStart) is
 * handled by each client's adapter (clients.ts).
 *
 * The body of AGENTS.md is not passed (it would exceed the client's additionalContext limit, so we
 * pass only the path and have the model read it).
 */

import { inUse } from './repo.js';
import type { RepoState } from './repo.js';

// Default HEADER. Clients replace it (kiro overrides it with the "lockage Kiro Power" version).
// Keep it identical across clients (so the injected content does not change).
export const DEFAULT_HEADER = '## lockage coordinated development (lockage plugin)\n';

/** Per-client parameters for buildContext. */
export interface BuildContextOptions {
  // Path to the canonical coordination rules (AGENTS.md). Only placed in the text; existence is not validated.
  agentsMd: string;
  // Name of the tool used to read the body ('Read' for claude/kiro, 'view_file' for antigravity).
  readTool: string;
  // The heading. Defaults to DEFAULT_HEADER.
  header?: string;
}

/**
 * Build the injected text.
 */
export function buildContext(st: RepoState, opts: BuildContextOptions): string {
  const { agentsMd, readTool, header = DEFAULT_HEADER } = opts;
  const tree = st.isLinked ? 'worktree' : 'main working tree';
  const repoPath =
    st.mainRoot ?? 'cannot be determined (a layout such as --separate-git-dir; check and pass the location of the main repository)';
  // lockage matches repos by path string, so passing just a name or a worktree path drops it from listings and checks
  const head =
    header +
    `- value to pass as repo_path: ${repoPath}\n` +
    '- pass the same absolute path as repo_path to open_ticket\'s repos, create_task\'s repo, and lockage-publish\'s --repo-path as well\n' +
    `- current working tree: ${st.toplevel} (${tree})\n`;
  if (inUse(st)) {
    return (
      head +
      '- this repository is operating under lockage. Before starting work that changes files, or work ' +
      `that handles lockage tickets/tasks, read the canonical coordination rules ${agentsMd} with ${readTool} and follow the lockage-workflow skill\'s steps.\n` +
      '- do all editing only inside the worktree returned by assign_worktree, and do not edit the main working tree directly' +
      ' (the only exception is "when the user instructs you not to use lockage" at the top of AGENTS.md).\n' +
      '- if the repository\'s AGENTS.md has a lockage section, treat it as that repository\'s specific rules and prefer it over the bundled canonical rules.\n'
    );
  }
  // For a repository not operating under lockage, pass only the entry point to keep per-session overhead small
  return (
    head +
    '- this repository does not use lockage yet. If the user instructs you to proceed with lockage, ' +
    `read the canonical coordination rules ${agentsMd} with ${readTool} and follow the lockage-workflow skill\'s steps.\n`
  );
}
