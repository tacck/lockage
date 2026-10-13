# lockage plugins (plugins/)

> 日本語版: [README_ja.md](README_ja.md)

Distribute lockage's coordination rules (`AGENTS.md`) and the lockage-workflow skill as plugins for each AI client.
With a plugin install, Claude Code and Antigravity can use lockage without placing anything in the target repository.
Kiro, in addition to registering the Power, needs the hook templates placed into the target's `.kiro/hooks/` (see "Kiro (Power)" below).
The Claude Code plugin also bundles the lockage MCP server definition (`.mcp.json`), so installing the plugin registers the server too.
For the other clients, registering the lockage MCP server is needed separately.

## Structure

| Directory | Role |
|---|---|
| `shared/` | **Canonical source.** `AGENTS.md`, `skills/lockage-workflow/SKILL.md`. Not read directly from any client. The hook decision logic has been ported to the TypeScript implementation in `src/hook/`, and each client launches it via `npx -y lockage hook ...`. |
| `claude/` | **Root of the Claude Code plugin.** `.claude-plugin/plugin.json`, `.mcp.json` (the MCP server definition), `hooks/hooks.json`, `agents/lockage-worker.md`. The marketplace is `.claude-plugin/marketplace.json` at the repository root. |
| `antigravity/` | **Root of the Antigravity plugin.** `plugin.json`, `hooks.json`. |
| `kiro/` | **Root of the Kiro Power** (`POWER.md` format). `POWER.md`, the `mcp.json` template, `steering/` (includes copies of `AGENTS.md` and the lockage-workflow skill), `hooks/` (templates to place into `.kiro/hooks/`). |

At install time each client copies and reads only the plugin's directory, so it cannot reference outside the plugin (such as `../shared`).
That is why `claude/`, `antigravity/`, `kiro/` each hold what they need inside their own directory.
The hook decision logic has been ported to the TypeScript implementation in `src/hook/`, and every client aligns the hook entry point to
`npx -y lockage hook <session|guard> --client <name> ...` (each plugin holds only the hook definition files; see each client's section below).

### Canonical source and copies

Terminology: the **canonical source** is the files inside `shared/` (`AGENTS.md`, `skills/lockage-workflow/SKILL.md`). A **copy** is the canonical source distributed into each plugin.
The **primary** is the `AGENTS.md` placed in the target repository (if present, it takes precedence over the bundled copy in that repository).

The canonical source in `shared/` is copied and distributed to each plugin. Where what goes is in `COPIES` of
[`../scripts/sync-plugins.ts`](../scripts/sync-plugins.ts).

- **Do not edit a copy directly.** Edit the canonical source in `shared/` and run `npm run sync:plugins` to align the copies.
- If a copy diverges from the canonical source, `npm test` (`test/plugins.test.ts`) fails. You can also check with `npm run sync:plugins -- --check`.
- A list of the distributed copies is kept in `plugins/.sync-manifest`. If you remove something from `COPIES` or rename it, the next `npm run sync:plugins` deletes the previously distributed leftover.
- What remains in each plugin is only the per-client input/output difference. The shape of a hook's response differs per client
  (Claude Code uses `permissionDecision: "ask"`, Antigravity uses `force_ask` / `ask`, Kiro uses rejection via exit 2), so it is not unified.

### version

For a PR that changes the contents of `plugins/claude/` or `plugins/antigravity/` (including when editing the canonical source in `shared/` changes a copy),
bump the `version` of `claude/.claude-plugin/plugin.json` and `antigravity/plugin.json` **to the same value**.
A change only to `plugins/README.md` or `plugins/kiro/` does not need a bump. Claude Code builds a cache per version, so
if you forget to bump, `plugin update` may decide there is no update and it will not reach users (what `plugin update` looks at to
decide whether there is an update is unconfirmed). The test only checks that the two versions match; it does not detect a missed bump.
Kiro's `POWER.md` format has no version (the `.claude-plugin/plugin.json` that used to be placed was not read by Kiro, so it was removed).

### Testing

Run at the root of the lockage repository. The hook logic is verified by `test/hook-logic.test.ts`, `test/hook-cli.test.ts`, and
the consistency of the distributed artifacts by `test/plugins.test.ts` (all included in `npm test`).

```bash
npm test
```

## Claude Code

```bash
claude plugin marketplace add <path to the lockage repository>
claude plugin install lockage@lockage
```

If you publish the repository on GitHub, you can register with `claude plugin marketplace add tacck/lockage` instead of a path
(the marketplace's `source` is the in-repository relative path `./plugins/claude`, so registering from GitHub points at the same plugin).
While private, only people with git-clone authentication can register.

- At install, the contents of `plugins/claude/` are **copied into the cache (`~/.claude/plugins/cache/lockage/lockage/<version>/`),
  and that copy is loaded** (confirmed on a real machine in 2026-10. `installPath` in `~/.claude/plugins/installed_plugins.json`
  points at this path). So updating the lockage repository does not automatically reflect into an installed plugin.
- **Take in an update**: at the path you registered with `marketplace add` (checkable via `source.path` of `lockage` in
  `~/.claude/plugins/known_marketplaces.json`), bring main up to date, then run the following and start a new session.
  If you have another branch open at the registered path, that branch's contents get pulled in, so switch to main first.
  If you registered from GitHub, the two `git` lines are not needed.

  ```bash
  git -C <the registered path> switch main
  git -C <the registered path> pull
  claude plugin marketplace update lockage
  claude plugin update lockage@lockage
  ```

  Confirm the update was taken by checking that the `version` of `lockage@lockage` in `~/.claude/plugins/installed_plugins.json`, and
  the tail of `installPath` (`.../<version>`), match the `version` in `plugins/claude/.claude-plugin/plugin.json`.
  If it stays at an old version, suspect the following.
  - The `version` was not bumped on the lockage side (missed bump)
  - The registered path is not up to date with main
  - `claude plugin marketplace update` was not run, or one of the commands ended in error
  - A new session was not started
- To try your local changes during development, launch with `claude --plugin-dir <path to the lockage repository>/plugins/claude`
  without installing, and the `plugins/claude/` right there is loaded (no need to bump the version). If you edited `shared/`, first
  run `npm run sync:plugins`. Loading it at the same time as an installed plugin may line up two of the same (unconfirmed), so
  keep it off while trying, and be sure to restore it when done. Leaving it off silently disables the hooks (such as the main-tree edit confirmation) in subsequent sessions.

  ```bash
  claude plugin disable lockage@lockage   # before trying
  claude plugin enable lockage@lockage    # after trying
  ```
- Validate the manifest: `claude plugin validate plugins/claude` and `claude plugin validate .` (the marketplace).
- If the target repository's `AGENTS.md` has a lockage section, it becomes that repository's primary and takes precedence over the bundled version.
  If you keep it for other clients such as Kiro, **do not delete it**, and keep it the same as the canonical source `plugins/shared/AGENTS.md` whenever that updates
  (if it stays old, the plugin-installed Claude Code also runs on an old procedure).
  For a repository used only with Claude Code, not placing it and leaving it to the bundled version avoids the maintenance effort.
- The hook launches with `npx -y lockage hook <session|guard> --client claude ...`.
  Since `npx` fetches and launches the npm-published artifact, no clone or `npm run build` is needed (the first run may take time to fetch).
  Requirements are Node.js `>= 22.5` and git 2.31 or later. If git is below 2.31, it gives up on judging the repository and passes through without doing anything.
- The main-tree edit confirmation (PreToolUse) is shown only in a repository that lockage is operating in. "Operating" is judged by the main repository having
  any of a branch under `lockage/`, a worktree under `.lockage-worktrees/`, `.lockage/`, so a repository you have run task_done in once keeps a record in the main's `.lockage/` (not removed even by reconcile) and is judged operating from then on.
  Even while operating, the confirmation is once per session until allowed, so to stop the confirmation in a repository where you do not use lockage, use
  `LOCKAGE_GUARD_DISABLE=1`.
  It looks only at Edit / Write / MultiEdit / NotebookEdit; writes via Bash (`sed -i` or redirection) are not confirmed.
- The confirmation is shown **until allowed**. Once allowed and an edit actually happens (recorded in PostToolUse), it does not ask again for the same repository in that session. If you reject it, it asks again on the next main-tree edit.
  To stop it temporarily, set the environment variable `LOCKAGE_GUARD_DISABLE=1`.
- In non-interactive runs such as `claude -p`, since there is no one to answer the confirmation, the edit may be treated as rejected.
  A rejected edit is not recorded, so in that case the main-tree edit is stopped every time
  (how a confirmation is handled in a non-interactive run depends on Claude Code's permission settings, so confirm before using it in a headless worker).
- The plugin bundles the lockage MCP server definition in `plugins/claude/.mcp.json`, which launches the npm-published artifact with `npx -y lockage`
  (the same as the hooks). Installing the plugin registers the server, so no separate `claude mcp add` is needed.
  The version is not pinned: the server is the published lockage that npx resolves (normally the latest), not one tied to the plugin's `version`.
  In `/mcp` it shows as `plugin:lockage:lockage`, and its tools are named `mcp__plugin_lockage_lockage__*` (a hand-registered server's are `mcp__lockage__*`).
  If your own `permissions.allow` or hook `matcher` names lockage tools as `mcp__lockage__...`, rewrite them to `mcp__plugin_lockage_lockage__...` when you switch
  (the bundled AGENTS.md and skill refer to tools by their bare names such as `claim_task`, so they need no change).
- **If you registered the server by hand before** (`claude mcp add lockage ...`), remove it with `claude mcp remove lockage -s user`
  (and `-s local` / `-s project` where you registered it per project).
  If that registration had `env` (`LOCKAGE_DB` in particular), first check it with `claude mcp get lockage` and move it to the `env` of `settings.json`
  (below) before removing; otherwise the ledger silently falls back to the default and this client stops seeing the other agents' tasks.
  Claude Code merges MCP servers that have the same command:
  if the hand-registered one uses the same command (`npx -y lockage`), only the hand-registered one is kept, even when its name or `env` differs;
  if the command differs (such as `node <clone>/dist/index.js`), both are registered and two lockage servers line up.
- The bundled definition does not set `env`, so the ledger is the default `~/.lockage/lockage.sqlite`. To place it elsewhere,
  set `LOCKAGE_DB` in the `env` of Claude Code's `settings.json` (or in the shell environment that launches Claude Code); the server inherits it.
  All agents must point at the same ledger.
- What was confirmed on a real machine (Claude Code 2.1.285, 2026-10-13, loading the plugin with `--plugin-dir`): the server name and tool names above;
  that servers with the same command are merged as described, keeping the hand-registered one; and that `LOCKAGE_DB` set in the shell environment
  or in the settings `env` (given with `--settings`) reaches the bundled server (the DB file was created at that path).
  `lockage-publish` does not receive the MCP server's environment, so when you place the ledger somewhere other than the default,
  show it the same ledger with `--db` or the shell environment variable `LOCKAGE_DB` (without showing it, even if a ticket is awaiting a PR you get `published: []`).
- Delete the skill that an earlier procedure placed in `~/.claude/skills/lockage-workflow/`, since it duplicates the plugin's skill.
- Verification: at the start of a new session, confirm that the context "lockage coordinated development (lockage plugin)" is injected and that
  `plugin:lockage:lockage` shows as connected in `/mcp`. If the injection does not appear, confirm whether `npx` can resolve lockage and whether you launched outside a git repository.
  If `plugin:lockage:lockage` is `failed` in `/mcp`, run `npx -y lockage hook session --client claude </dev/null` once in a terminal (exit 0 means it launched) to see whether npx can fetch
  and launch lockage (network, registry, Node.js `>= 22.5`), then start a new session. The first launch with an empty npx cache connected in about
  6 seconds on a real machine (2026-10-13), within Claude Code's MCP startup timeout; on a slow network, raise it with the `MCP_TIMEOUT` environment variable (milliseconds).

**How to use lockage-worker (subagent)**: the main session launches it with the Agent tool.
- What to pass: `repo_path`, and `task_id` or `ticket_id`. To resume an interrupted task, pass the previous `agent_id` and
  the human's decision via `instructions`. If there is a coordinator, `coordinator`. In an environment where the hook does not run, `agents_md_path`.
- You may launch them in parallel (since claim is CAS, two will not take the same task)
- Response-by-response handling: if blocked, raise the reason to the human. If "could not open a PR," run
  `lockage-publish --repo-path <repo_path> --ticket <ticket_id>` at the caller.
- Once all workers return, do Phase 4 (look at `publisher_status` and sweep / reconcile) in the main session.

## Antigravity

Prerequisite: use agy (the Antigravity CLI; confirmed on 1.3.2) to install. The hook requirements (Node.js `>= 22.5`, git 2.31 or later) are the same as the Claude Code version.
Even if you use only Antigravity 2.0, the IDE, install with agy (the install destination is the same place as 2.0, the IDE).

```bash
agy plugin install <path to the lockage repository>/plugins/antigravity
```

agy is said to be installable from a Git URL too, but whether it can install by pointing at a subdirectory inside the repository (`plugins/antigravity`) is
unconfirmed. Until confirmed, clone first and install by path.

- The contents of `plugins/antigravity/` are **copied into `~/.gemini/config/plugins/lockage/`, and that copy is loaded**
  (confirmed on agy 1.3.2. The official docs' CLI section says `~/.gemini/antigravity-cli/plugins/`, but in reality it was different).
  Antigravity 2.0, the IDE read this location too (the "global plugins" location in the docs). What was confirmed in which environment is as follows.

  | What was confirmed | CLI (agy 1.3.2) | Antigravity 2.0 | IDE |
  |---|---|---|---|
  | The PreInvocation text is passed and the agent reads the bundled `AGENTS.md` | Confirmed (`agy -p`) | Confirmed | Unconfirmed |
  | A `force_ask` confirmation is shown on a main-tree edit | Confirmed it becomes a rejection non-interactively | Confirmed | Unconfirmed |
  | Rejecting a confirmation does not record "allowed," and the confirmation shows again on the next edit | — | Confirmed | Unconfirmed |
  | `ask` becomes the same permission confirmation as when there is no hook | Confirmed (non-interactive) | Unconfirmed | Unconfirmed |

  The current configuration (hook entry point `npx -y lockage hook ...`) has not been confirmed on a real machine. Antigravity 2.0 is an app whose conversation records
  remain in `~/.gemini/antigravity/` (the IDE uses `~/.gemini/antigravity-ide/`).
  Updating the lockage repository is not reflected automatically, so bring main up to date, reinstall with the same command, and start a new conversation.
  On reinstall, the copy is overwritten with the same contents as `plugins/antigravity/` (whether old files remain when a change removes files is unconfirmed;
  if concerned, `agy plugin uninstall lockage` before installing).
- Bump `plugin.json`'s `version` **to the same value** as the Claude Code version (see "version" above). Antigravity re-copies on every reinstall
  regardless of version (confirmed on agy 1.3.2), so it has no effect on whether an update is delivered.
  Aligning them is so that, looking at the installed copy's `plugin.json`, you can tell which version it was installed from.
- The hook (launches with `npx -y lockage hook <session|guard> --client antigravity ...`.
  Since `npx` fetches and launches the npm-published artifact, no clone or `npm run build` is needed):
  - If `npx` cannot resolve lockage, the PreInvocation text is not passed and the edit confirmation does not show (PreToolUse is always `ask`).
    Since work is not stopped, it is hard to notice it became disabled.
  - **PreInvocation**: before the first model call of a conversation, pass the value to put in `repo_path`, the working-tree kind, the location of the bundled `AGENTS.md` as
    an `ephemeralMessage`. This is the substitute because Antigravity has no SessionStart. The passed text remains in the conversation record and is
    visible to the model on subsequent calls, so it is passed once per conversation. If the record (`transcriptPath`) already has an
    `EPHEMERAL_MESSAGE` step passed by this hook, it is not passed again (if the same string as the heading merely appears in an utterance or tool output, it is passed).
    The record is read only on the call where `invocationNum` is 0. If there are multiple workspaces, it is shown per repository.
    It calls git up to 3 times per repository (up to 2 seconds each), so only this hook has a timeout of 30 seconds.
    If workspaces exceed roughly 5, it is cut off and the text may not be passed in that conversation.
  - **PreToolUse / PostToolUse** (`write_to_file` / `replace_file_content` / `multi_replace_file_content`): the decision is the same as the Claude Code version's
    main-tree edit confirmation (the operating judgment, once allowed it does not ask again in that conversation, `LOCKAGE_GUARD_DISABLE=1`).
    The confirmation is interposed with `force_ask` (`ask` honors "always allow," so in an environment where the edit is already allowed, the confirmation does not show).
    When not confirming, it returns `ask`. Antigravity treats a response with no `decision` as a tool rejection, so you cannot return nothing.
    `ask` becomes the same permission confirmation as when there is no hook (`allow` skips the permission confirmation, so it is not used).
    The CLI always returns a decision on every path (pre is `{"decision":"ask"}`, post is `{}`), so it never stops an edit while outputting nothing.
    Writes via `run_command` are not confirmed.
  - The hook is launched with the plugin's directory (`~/.gemini/config/plugins/lockage/`) as its working directory (confirmed on agy 1.3.2).
    There is no environment variable pointing at the plugin root, so the session hook in `hooks.json` passes the location of AGENTS.md with a path relative to the root,
    like `--agents-md ./AGENTS.md` (the CLI makes it absolute at the working directory).
  - In non-interactive runs (`agy -p`), since there is no one to answer the confirmation, `force_ask` becomes a rejection (`ask` too becomes a rejection if there is no allow rule. Same as when there is no hook. Confirmed on agy 1.3.2).
- Registering the lockage MCP server itself is not included in the plugin (same reason as the Claude Code version). Register the contents of
  "Registering with an MCP client" in the repository-root `README.md` with `agy mcp add` (all agents point at the same ledger. The way to show the ledger to `lockage-publish` is the same as the Claude Code version. Example:
  `agy mcp add --env LOCKAGE_DB=<absolute path to the ledger> lockage node <path to the lockage repository>/dist/index.js`).
  The registration destination is `~/.gemini/config/mcp_config.json`, which Antigravity 2.0, the IDE read too (`agy mcp list` listing
  the contents of this file is confirmed on agy 1.3.2; that 2.0, the IDE read it is per the docs).
  Confirm registration by lockage appearing in `agy mcp list`. Without registration, per AGENTS.md's "when no tools are found at all" you
  work without lockage.
- lockage-worker (subagent) is not provided for Antigravity (an Antigravity subagent can be placed in `agents/` at the plugin root).
- Delete the skill an earlier procedure placed in `~/.gemini/config/skills/lockage-workflow/` and the `GEMINI.md` placed in the target, since they
  duplicate the plugin's skill, hooks (the handling of the target's `AGENTS.md` is the same as the Claude Code plugin).
- Verification:
  - `agy plugin validate plugins/antigravity` passes at the root of the lockage repository.
  - Start a new conversation inside a git repository and ask "answer verbatim, without using tools, the heading the lockage plugin showed and the path of the canonical coordination rules,"
    and it should answer the heading "lockage coordinated development (lockage plugin)" and `~/.gemini/config/plugins/lockage/AGENTS.md`
    (asking only for repo_path does not confirm injection, since it could answer by guessing from the workspace path).
  - If it cannot answer, confirm the following. Whether lockage's PreInvocation shows in the CLI's `/hooks`. Whether `npx` can resolve lockage.
    Whether the workspace is a git repository. Whether you tried in a new conversation (the text is passed only on the conversation's first call).
    A hook failure appears on stderr as a line beginning with `[lockage-plugin]`.

## Kiro (Power)

The distribution format corresponding to the Claude Code plugin (`POWER.md` format). `plugins/kiro/` is the Power root.

**At install, Kiro copies only `POWER.md`, `mcp.json`, `steering/`** (confirmed from what remained in
`~/.kiro/powers/installed/` for a 2026-10-10 registration). So the coordination rules (`AGENTS.md`) and the lockage-workflow skill are
placed as copies `steering/AGENTS.md`, `steering/lockage-workflow.md` (`npm run sync:plugins` distributes them).
Since both the MCP server and the hook launch the npm-published artifact with `npx -y lockage`, no clone or `npm run build` is needed
(the bundled `mcp.json` is usable as-is with no placeholder replacement. The hook decision logic has been ported to the TypeScript implementation in `src/hook/`, and
`npx -y lockage hook ...` launches it).

1. **Register the Power.** From "Add Custom Power" in Kiro's Powers panel, register `plugins/kiro` in one of the following ways.
   - **From a folder** (Import power from a folder): choose `plugins/kiro` of the clone.
   - **From GitHub** (Import power from GitHub): enter `https://github.com/tacck/lockage/tree/main/plugins/kiro`.
     Kiro can take in a subdirectory from a URL of the form `tree/<branch>/<path>` (confirmed with another repository's Power.
     The registration remains as `pathInRepo` in `~/.kiro/powers/registries/user-added.json`). It cannot be used until the lockage repository is published,
     and even after publication it has not been confirmed with lockage. A Power registered from GitHub takes in the latest of main.
2. **Register the MCP server.** Reflect the bundled `mcp.json` (`command:npx`, `args:["-y","lockage"]`, `disabled:false`)
   into Kiro's `mcp.json` configuration as-is. **No placeholder replacement is needed.** Since `npx` fetches and launches the npm-published artifact,
   no clone or `npm run build` is needed to launch the MCP server (the first run may take time to fetch).
   The DB (ledger) uses the default `~/.lockage/lockage.sqlite`. The default is fine; only those who want to change the location add
   `env.LOCKAGE_DB` (absolute path to the ledger) to `lockage`.
   **All coordinating agents point at the same `LOCKAGE_DB` (the same ledger DB).** If you leave the default, everyone points at the
   same default, so no extra configuration is needed. If they are not aligned, claim, dirty, board are not shared and conflict avoidance does not work.
   Without registration you end up working without lockage, per AGENTS.md's "when no tools are found at all."
   The way to show the ledger to `lockage-publish` is the same as the Claude Code version.
3. **Place the hooks into `.kiro/hooks/`.** The main path is running `npx -y lockage setup kiro` in the target repository.
   This generates `.kiro/hooks/lockage-guard.json` (main-tree edit guard) and `lockage-session.json` (`SessionStart` context injection).
   Each `action.command` is of the form `npx -y lockage hook <guard|session> --client kiro ...`, so **no manual absolute-path replacement is needed**
   (the session hook's `--agents-md` is filled with the absolute path of the target's `.kiro/steering/AGENTS.md`). If a same-named file already exists, it is
   `unchanged` if the contents are the same, and not overwritten until you add `--force`. Even if you run it inside a worktree, the hooks are placed in the main repository's
   `.kiro/hooks/`. With this path there is no need to clone for the hooks (`npx` fetches and launches the npm-published artifact).
   You can work without hooks, but main-tree edits are not stopped (follow the rules in `main-tree-guard.md` yourself).

   **Alternative when not using setup**: when `npx -y lockage` is unavailable (offline, internal-registry constraints, etc.)/you want to adjust the generated
   files by hand, copy the bundled templates (`lockage-guard.json`, `lockage-session.json`) in the clone's `plugins/kiro/hooks/` into the
   target's `.kiro/hooks/`. Replace `lockage-session.json`'s `--agents-md "<ABSOLUTE_PATH_TO_STEERING_AGENTS_MD>"` with
   the absolute path of the target's `.kiro/steering/AGENTS.md` (`lockage-guard.json` does not use `--agents-md`, so no replacement is needed).
4. **Loading the steering.** The Steering section of `POWER.md` guides when to read `AGENTS.md`, `lockage-workflow.md`, `coordination` /
   `main-tree-guard` / `publish-pr`. Inclusion mode "Always" is recommended for the steering.

- **Verification** (for the 0.5-series configuration, not confirmed on a real machine with lockage):
  - Start a new session in a repository that lockage is operating in and ask "answer verbatim, without using tools, the heading the lockage Power's hook showed and the path of the canonical coordination rules,"
    and it should answer the heading "lockage coordinated development (lockage Kiro Power)" and
    the target's `.kiro/steering/AGENTS.md` (the absolute path `setup kiro` filled into `--agents-md`). If it cannot answer, confirm whether
    `.kiro/hooks/lockage-session.json` is placed and `command` is of the form `npx -y lockage hook session --client kiro ...`
    (a hook failure appears on stderr as a line beginning with `[lockage-plugin]`).
  - When you have it edit a file in the main tree of the same repository, it should be rejected and ask back whether to proceed in a worktree or use `LOCKAGE_GUARD_DISABLE=1`.
  - lockage's tools (such as `claim_task`) should appear in the MCP tool list.
- **Difference in main-tree edit guard behavior (Kiro-specific)**: Kiro's command hook has no output corresponding to Claude Code's
  "confirmation (ask)." So this Power's guard, when you try to edit the main tree (the main working tree, not a worktree) with `fs_write` / `str_replace`
  in a repository that lockage is operating in, **falls to rejection (exit 2)** (the Claude version interposed a confirmation). When you need to edit the main tree directly,
  set the environment variable `LOCKAGE_GUARD_DISABLE=1` to disable the guard.
  On a real machine, after rejecting, the message the script shows (edit inside a worktree/disable with `LOCKAGE_GUARD_DISABLE=1`) was conveyed to the user via the agent,
  taking the form of asking back "proceed in a worktree/directly in the main tree"
  (confirmed 2026-10-10).
  It does not hold a session-scoped allow memory of "once allowed in this session, do not ask again."
  This is by a design judgment that it is unneeded because the rejection scheme is consistent in rejecting every time (disabling is done with `LOCKAGE_GUARD_DISABLE=1`).
- The "operating" judgment (the main has any of a `lockage/` branch, `.lockage-worktrees/`, `.lockage/`) and
  not judging Bash-equivalent writes are the same as the Claude Code version (the judgment shares `mainTreeRoot` of `src/hook/repo.ts` across all clients).
