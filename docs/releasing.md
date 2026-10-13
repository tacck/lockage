# Releasing lockage to npm

> 日本語版: [releasing_ja.md](releasing_ja.md)

This document covers how the `lockage` npm package is released — who runs it, what to check first, and when to bump the version. It is separate from [`./publishing.md`](./publishing.md), which is about `lockage-publish` (turning a lockage ticket into a GitHub/GitLab PR); the two are unrelated operations that happen to share the word "publish". For how to develop, build, and test lockage itself, see [`./development.md`](./development.md); for the version-matching rule across the package and the plugins, see the "version" section of [`../plugins/README.md`](../plugins/README.md#version).

## Who releases, and when

A maintainer releases **manually from a local checkout** (there is no CI publish step at present). The trigger is **merging a PR that bumped the version** (see "When to bump the version" below). After such a PR lands on the default branch, publish that version to npm.

## Prerequisites

- You are an npm owner of the `lockage` package and are logged in (`npm whoami` shows your account).
- Your checkout is on the default branch, up to date with the merged PR, and clean (`git status` is empty).
- Node.js `>= 22.5` (the package's `engines` requirement).

## Steps

1. **Confirm the version to publish.** It must already be bumped in `package.json` by the merged PR — releasing does not bump it. Confirm the three versions match (this is also enforced by `test/plugins.test.ts`):

   ```bash
   node -p "require('./package.json').version"
   node -p "require('./plugins/claude/.claude-plugin/plugin.json').version"
   node -p "require('./plugins/antigravity/plugin.json').version"
   ```

2. **Build and test from a clean tree.**

   ```bash
   npm ci
   npm test
   ```

   `npm test` runs `npm run build` via `pretest`, so a type error or a broken build fails here.

3. **Publish.** `prepublishOnly` (`rm -rf dist && npm run build`) rebuilds `dist/` from scratch, so the published artifact always matches the current source.

   ```bash
   npm publish
   ```

   Do a dry run first if you want to inspect the file list: `npm publish --dry-run`.

4. **Tag the release** so the published version is identifiable in git history (match the existing tag style, e.g. `v0.9.3`):

   ```bash
   git tag v$(node -p "require('./package.json').version")
   git push --tags
   ```

5. **Verify.** `npm view lockage version` shows the version you just published. Because the plugins launch the server with an unpinned `npx -y lockage`, a fresh npx run (outside the lockage repository, where it would otherwise use the working tree's `dist/`) will resolve the new version once its cache refreshes:

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
