# lockage developer guide (development)

> 日本語版: [development_ja.md](development_ja.md)

This document is for people who develop, build, and test lockage itself. For the user-facing setup, see [`../README.md`](../README.md); for the operational details of publishing PRs (`lockage-publish`), see [`./publishing.md`](./publishing.md).

## Setup (clone + build)

To develop lockage itself, or to use a local version before publication, clone and build the repository.

```bash
git clone <this repository>
cd lockage
npm install
npm run build      # generate artifacts into dist/ (schema.sql is copied too)
```

You can launch the built `dist/index.js` directly with `node dist/index.js` (see "[Launching (during development)](#launching-during-development)" below).

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript and generate `dist/` |
| `npm run dev` | Launch the server directly with `tsx` (no build needed) |
| `npm test` | Run all tests (unit + e2e. Auto-builds first) |
| `npm run test:unit` | Unit tests only (excludes e2e, no build needed) |
| `npm run test:e2e` | The 2-client e2e only (auto-builds first) |
| `npm run typecheck` | Type-check only |

## Launching (during development)

Launch as an MCP server over the stdio transport.

```bash
# launch the built artifact
node dist/index.js

# or during development (no build needed)
npm run dev
```

- The DB location can be specified with the environment variable `LOCKAGE_DB` (default `~/.lockage/lockage.sqlite`). It is a home absolute path on the premise that the cross-cutting ledger is a single global one. The parent directory is created automatically.
- The exposed tool sets can be selected with the environment variable `LOCKAGE_TOOLSETS` (the default is only the agent-facing `core`. See "Provided tools" in the README). Writing an unknown set name makes startup fail.
- Standard output is JSON-RPC only. Startup logs and errors go to standard error.

For the MCP-client registration procedure (user-facing), see [Registering with an MCP client](../README.md#registering-with-an-mcp-client) in the README.

## Testing

Using `node:test`, you can test with no extra dependencies.

```bash
npm test            # run unit + e2e together (auto-builds first)
npm run test:unit   # unit only (no build needed, fast. Verifies the coordination logic individually)
npm run test:e2e    # the 2-client e2e only (auto-builds first)
```

- **Unit** (`test/*.test.ts` other than e2e): verify `claim` / `worktree` / `globs` / `files` / `merge` / `board` / server connectivity individually. The worktree and merge-gate parts create a temporary git repository and run actual `git worktree` / merges.
- **e2e** (`test/e2e.test.ts`): launch the built `dist/index.js` **as two separate-process MCP servers** (agent A / B), point both at **the same `LOCKAGE_DB` file**, and verify coordinated behavior in a configuration close to real operation. It uses a real stdio transport + a real file DB + a real git worktree, not InMemory. The following single flow confirms this system's differentiators as-is:

  1. A creates a task, and **B (a separate process) can see it** (= DB shared)
  2. A's claim succeeds → **B's claim is `conflict`** (= double claim physically rejected by CAS)
  3. A assigns a worktree (= physical isolation by a real `git worktree`)
  4. A publishes dirty → **when B publishes the same file as dirty, an overlap warning** (= warn-never-block)
  5. While B is waiting in `wait_for_unblock`, A does `post_board` → **B returns with `woke_by:"board"`** (= A2A wake)

  `test:e2e` launches `dist/index.js`, so a build is a prerequisite (it is built automatically by `pretest:e2e`). Temporary files are created in `KIROCREW_SCRATCH` (the OS temporary directory when unset) and deleted on exit.

## Project structure

```
lockage/
├── src/
│   ├── index.ts          MCP server body (stdio + registration of all tools)
│   ├── db/
│   │   ├── schema.sql     SQLite schema (12 tables + 1 FTS5)
│   │   └── index.ts       DB connection, PRAGMA, idempotent schema application
│   └── lockage/          coordination logic
│       ├── claim.ts       atomic CAS claim / lease sweep / heartbeat
│       ├── worktree.ts    automatic git worktree assignment, release
│       ├── globs.ts       glob intersection judgment (advisory is approximate, the merge gate is strict)
│       ├── files.ts       advisory claim_files / dirty set
│       ├── merge.ts       integration merge gate (serialization + 3-way pre-check)
│       ├── board.ts       shared board + A2A wake (long-poll)
│       └── git.ts         git wrapper / base-branch resolution
│   └── launcher/         publish tool (does not import the core; drives it via an MCP client)
│       ├── client.ts      a thin callTool wrapper that drives Lockage via a stdio MCP client
│       ├── publish-adapter.ts  publish abstraction (PublishAdapter / Github / Gitlab stub)
│       ├── publish.ts     publishReadyTickets / reconcileMergedPrs (ticket_ready→PR→cleanup)
│       └── publish-cli.ts the lockage-publish entry
├── plugins/              each client's plugin (each a self-contained plugin root)
│   ├── shared/            the canonical source (AGENTS.md, the lockage-workflow skill, the shared hook judgment). npm run sync:plugins copies it to each plugin
│   ├── claude/            the Claude Code plugin (hooks, the lockage-worker agent)
│   ├── antigravity/       the Antigravity plugin (hooks)
│   └── kiro/              the Kiro Power (POWER.md, steering, the mcp.json template, the hook templates)
├── scripts/sync-plugins.ts  copies the canonical source in plugins/shared/ to each plugin (--check detects divergence)
├── .claude-plugin/       Claude Code's marketplace (points at plugins/claude)
└── test/                 the test suite with node:test
```

## Design note (the blocked-interrupt lifecycle)

A blocked interrupt has 3 paths: "`block_task` (indefinite interrupt holding the claim) → `resume_task` (the same agent resumes) / `handoff_task` (bulk transfer to another worker as a whole worktree unit, only on explicit human instruction) / `release_task(abandoned)` (abort)." Orphans are made visible with `list_tasks(status:"blocked")` (no auto-reclaim). On a successful handoff, `post_board(kind:"handoff")` + wake wakes the handoff target.
