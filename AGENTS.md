# AGENTS.md

Conventions for contributors and agents working on the **lockage repository
itself**. (This is not the lockage end-user coordination rules; those live under
`plugins/` and `.kiro/steering/`.)

## Branch and release workflow

The default branch is **`dev`**; releases happen via a **`dev` -> `main`** PR,
which publishes to npm. For everyday work, branch off `dev` into a working
branch (`feature/...`, `fix/...`, `chore/...`) and open a pull request
**targeting `dev`** — never commit to `dev` or `main` directly. See
[`docs/branch-strategy.md`](docs/branch-strategy.md) for the authoritative
details (everyday flow, the publish and version-bump workflows, and the one-time
setup).

## Release steps and who runs each (AI vs human vs CI)

The authoritative "how release works" is [`docs/branch-strategy.md`](docs/branch-strategy.md)
and the release checklist is [`docs/releasing.md`](docs/releasing.md). This
section only fixes **who performs each step** so an AI agent knows which parts
it may do on its own and which it must leave to a human. Do not restate the
release mechanics here; follow those docs for the details.

| # | Step | Runner | Notes |
|---|---|---|---|
| 1 | Bump the version (run the **version-bump** workflow, then merge the auto-opened bump PR into `dev`) | **Human** | Dispatched from the Actions tab. An AI does not trigger it on its own. |
| 2 | Open the **`dev` -> `main`** release PR | **AI** (may do it when asked) | `gh pr create --base main --head dev`. Title under 70 chars; body in Japanese summarizing what the release includes. Do not merge it. |
| 3 | Merge the `dev` -> `main` PR | **Human** (or AI only on an explicit human instruction) | The push to `main` triggers the publish workflow. |
| 4 | Publish to npm | **CI** (publish workflow) | Fully automated via OIDC. No AI or human action; it is a no-op if the version is already on npm. |
| 5 | Confirm the publish, then register the release on **GitHub Releases** | **AI** | See the procedure below. |

### Rules the AI must keep

- **Only steps 2 and 5 are the AI's to run.** Never dispatch version-bump
  (step 1), never merge into `main` (step 3) unless a human explicitly says so
  in the conversation, and never publish by hand (step 4 is CI's).
- **Do not create a GitHub Release until the npm publish is confirmed** (step 5
  waits on step 4). Verify with `npm view lockage version` showing the new
  version before registering the release.
- **Use the tag the publish workflow already pushed.** The publish workflow
  creates and pushes the `vX.Y.Z` git tag itself (see `publish.yml`), so the AI
  must **not** create or move tags. Register the GitHub Release against that
  existing tag.

### Step 5 in detail: register the GitHub Release

Run this only after the npm publish for that version is confirmed.

1. **Confirm the publish.** The version from `package.json` must resolve on npm:

   ```bash
   test "$(npm view lockage version)" = "$(node -p "require('./package.json').version")" \
     && echo "published: ok" || echo "not published yet — wait for CI"
   ```

2. **Confirm the tag exists on the remote** (pushed by the publish workflow):

   ```bash
   git fetch --tags
   git rev-parse "v$(node -p "require('./package.json').version")" >/dev/null && echo "tag ok"
   ```

   If the tag is missing, the publish workflow has not finished (or skipped as a
   no-op because the version was unchanged). Do not create the tag yourself;
   wait for CI, or tell the user.

3. **Create the Release against that tag**, letting GitHub generate the notes
   from merged PRs. `--verify-tag` fails instead of creating a new tag if the
   tag is absent, which keeps tag creation CI's job:

   ```bash
   VERSION="$(node -p "require('./package.json').version")"
   gh release create "v${VERSION}" --title "v${VERSION}" --verify-tag --generate-notes
   ```

   Review the generated notes; adjust the body in Japanese if a human-readable
   summary helps. Do not mark it a pre-release for a normal release.

4. **Report the Release URL** that `gh release create` prints.

## Build and test

Commands live in `package.json`. The common ones:

- `npm run build` — compile TypeScript into `dist/`.
- `npm test` — run all tests (auto-builds first).
- `npm run typecheck` — type-check only.

See [`docs/development.md`](docs/development.md) for the full developer guide and
[`docs/releasing.md`](docs/releasing.md) for the release checklist (including the
rule that the three version files must stay in sync).
