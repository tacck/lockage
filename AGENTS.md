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

## Build and test

Commands live in `package.json`. The common ones:

- `npm run build` — compile TypeScript into `dist/`.
- `npm test` — run all tests (auto-builds first).
- `npm run typecheck` — type-check only.

See [`docs/development.md`](docs/development.md) for the full developer guide and
[`docs/releasing.md`](docs/releasing.md) for the release checklist (including the
rule that the three version files must stay in sync).
