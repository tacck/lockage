# Releasing lockage to npm

> 日本語版: [releasing_ja.md](releasing_ja.md)

This document covers how the `lockage` npm package is released — who runs it, what to check first, and when to bump the version. It is separate from [`./publishing.md`](./publishing.md), which is about `lockage-publish` (turning a lockage ticket into a GitHub/GitLab PR); the two are unrelated operations that happen to share the word "publish". For the overall branch model, see [`./branch-strategy.md`](./branch-strategy.md); for how to develop, build, and test lockage itself, see [`./development.md`](./development.md); for the version-matching rule across the package and the plugins, see the "version" section of [`../plugins/README.md`](../plugins/README.md#version).

## Who releases, and when

Releases are **automated by CI**. The GitHub Actions publish workflow ([`.github/workflows/publish.yml`](../.github/workflows/publish.yml)) runs on every push to `main` and publishes to npm when `package.json` carries a not-yet-published version. The trigger is therefore **merging a `dev` -> `main` PR after the version was bumped** (see "When to bump the version" below). No one publishes from a local checkout.

Publishing authenticates with **npm Trusted Publishing (OIDC)**, not a stored `NPM_TOKEN`: GitHub Actions mints a short-lived OIDC token that npm exchanges for a one-off publish credential, and provenance is attached automatically. The publish job sets `permissions: id-token: write` and runs `npm publish` with no `NODE_AUTH_TOKEN`.

## Prerequisites

The one-time setup — creating `dev`, making it the default branch, and configuring a **Trusted Publisher** for the package on npmjs.com (GitHub Actions, repo `tacck/lockage`, workflow `publish.yml`) — is described in [`./branch-strategy.md`](./branch-strategy.md#one-time-setup-manual-done-by-a-human). Once that is in place, no per-release prerequisites apply to a human: CI upgrades npm to the Trusted-Publishing minimum (`>= 11.5.1`) on Node `22.14` and authenticates via OIDC automatically. No secret is stored.

## Steps

1. **Bump the version** (unless it was already bumped on `dev`). Run the **version-bump** workflow ([`.github/workflows/version-bump.yml`](../.github/workflows/version-bump.yml)) from the Actions tab and choose the semver part to raise (`patch` / `minor` / `major`). It bumps `package.json`, keeps the two `plugin.json` files and `package-lock.json` in sync, and opens a PR targeting `dev`. Merge that PR into `dev`.

   The three versions must match (also enforced by `test/plugins.test.ts` and re-checked by the publish workflow before it publishes):

   - `package.json`
   - `plugins/claude/.claude-plugin/plugin.json`
   - `plugins/antigravity/plugin.json`

2. **Open and merge a `dev` -> `main` PR.** This batches the accumulated changes on `dev` into a release. The push to `main` starts the publish workflow.

3. **Let CI publish.** The publish workflow:

   - verifies the three version files are equal (fails fast if they diverge);
   - checks npm — if `package.json`'s version is already published it finishes as a successful no-op, so a merge without a bump does not fail;
   - otherwise runs `npm ci`, `npm test`, `npm publish` (via Trusted Publishing / OIDC — no token; `prepublishOnly` rebuilds `dist/` so the artifact matches source, and provenance is attached automatically), then creates and pushes a `vX.Y.Z` tag (matching the existing tag style, skipping without failing if the tag already exists).

4. **Verify.** `npm view lockage version` shows the version CI just published. Because the plugins launch the server with an unpinned `npx -y lockage`, a fresh npx run (outside the lockage repository, where it would otherwise use the working tree's `dist/`) will resolve the new version once its cache refreshes:

   ```bash
   npx -y lockage </dev/null
   # stderr shows: [lockage] ready (version=<the published version>, db=..., toolsets=...)
   ```

## When to bump the version

The version lives in three files that must stay equal — `package.json`, `plugins/claude/.claude-plugin/plugin.json`, and `plugins/antigravity/plugin.json` — and `test/plugins.test.ts` fails if they diverge. Because the plugins launch the npm package with an unpinned `npx -y lockage`, a plugin change only reaches users once a new version is published to npm. So the bump rule is driven by whether a release is needed, by the kind of change:

| Change | Bump the three versions? | Publish to npm? |
|---|---|---|
| `src/` (the server / `lockage-publish`) | Yes | Yes |
| `plugins/claude/` or `plugins/antigravity/` (including a change to the canonical `plugins/shared/` that updates a copy) | Yes | Yes |
| `plugins/README.md` or `plugins/kiro/` only | No | No |
| docs only (`docs/`, top-level `README*.md`) | No | No |

A `plugins/kiro/` or `plugins/README.md`-only change does not need a bump because Kiro's `POWER.md` format has no version and `plugins/README.md` is not shipped in the npm package. See the "version" section of [`../plugins/README.md`](../plugins/README.md#version) for the plugin-cache reasoning (Claude Code builds a cache per version, so a missed bump may not reach users).
