# Branch and release strategy

This document is the authoritative description of how branches and releases work
in the lockage repository itself. For the step-by-step release checklist, see
[`./releasing.md`](./releasing.md); for building and testing lockage, see
[`./development.md`](./development.md).

## Overview

lockage follows a Git Flow based model with two long-lived branches:

- **`dev`** — the default/integration branch. All day-to-day work lands here.
- **`main`** — the release branch. A merge into `main` publishes to npm.

The point of the two-branch split is to **concentrate several changes on `dev`
and release them in batches**, instead of publishing a new npm version for every
small change.

## Everyday development

1. Branch off `dev` for a feature or fix (`feature/...`, `fix/...`).
2. Open a pull request **targeting `dev`**.
3. After review, merge into `dev`. Nothing is published yet.

## Releasing

A release moves accumulated changes from `dev` to `main`:

1. Open a pull request from `dev` into `main`.
2. Merge it. The push to `main` triggers the **publish workflow**
   ([`.github/workflows/publish.yml`](../.github/workflows/publish.yml)).

Publishing authenticates with **npm Trusted Publishing (OIDC)** — there is no
`NPM_TOKEN` secret. GitHub Actions mints a short-lived OIDC token that npm
exchanges for a one-off publish credential, and npm attaches build provenance
automatically (lockage is a public repo and a public package). This requires a
Trusted Publisher to be configured on npmjs.com (see the one-time setup below).

The publish workflow is guarded so it only publishes a **not-yet-published**
version:

- It reads the version from `package.json` and queries npm. If that exact
  version is already published, it finishes as a successful no-op — a merge that
  did not bump the version does not fail.
- Before publishing it verifies the three version files are equal
  (`package.json`, `plugins/claude/.claude-plugin/plugin.json`,
  `plugins/antigravity/plugin.json`); it fails fast if they diverge, mirroring
  `test/plugins.test.ts`.
- When a publish is warranted it runs `npm ci`, `npm test`, `npm publish`
  (`prepublishOnly` rebuilds `dist/`), then creates and pushes a `vX.Y.Z` tag
  (skipping without failing if the tag already exists).

## Bumping the version

Use the **version-bump workflow**
([`.github/workflows/version-bump.yml`](../.github/workflows/version-bump.yml))
instead of editing version numbers by hand:

1. Open the Actions tab and run **version-bump**.
2. Choose the semver part to raise: `patch`, `minor`, or `major`.
3. The workflow bumps `package.json`, syncs the two `plugin.json` files and
   `package-lock.json`, then opens a pull request **targeting `dev`**.
4. Review and merge that PR into `dev`.

Deciding whether a change needs a bump at all is covered in
[`./releasing.md`](./releasing.md#when-to-bump-the-version).

## One-time setup (manual, done by a human)

The workflows assume the following target state. Set it up once:

1. **Create `dev` from `main` and push it:**

   ```bash
   git checkout main
   git pull
   git checkout -b dev
   git push -u origin dev
   ```

2. **Set `dev` as the default branch** in the GitHub repository settings
   (Settings → General → Default branch).

3. **Configure a Trusted Publisher on npmjs.com** instead of storing an
   `NPM_TOKEN`. Go to npmjs.com → the `lockage` package → Settings → Trusted
   Publisher, choose **GitHub Actions**, and enter:

   - **Organization or user:** `tacck`
   - **Repository:** `lockage`
   - **Workflow filename:** `publish.yml` (the filename only, with the `.yml`
     extension — not a path)

   Notes:

   - A newly created Trusted Publisher must complete its **first successful
     publish within 2 days**, or the configuration expires and must be recreated.
   - The fields are case-sensitive and are not validated when saved; a mismatch
     only surfaces as an `ENEEDAUTH` error at publish time.
   - Trusted Publishing requires the package to already exist on npm (it does)
     and `package.json`'s `repository.url` to match this GitHub repository (it
     is set to `git+https://github.com/tacck/lockage.git`).
   - No GitHub secret is needed. Optionally, after the first OIDC publish
     succeeds, harden the package via npmjs.com → Settings → Publishing access →
     *Require two-factor authentication and disallow tokens*.
