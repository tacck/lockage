# PR-publishing trigger (Kiro Power steering: publish-pr)

**A Pull Request is created "per ticket" by `lockage-publish`. Do not `gh pr create`.**
This is the highlights of `AGENTS.md`'s "Principle 6" and "Safety net before session end," restated as steering.
Treat `AGENTS.md` as the single authority for the exact aggregation, reconcile behavior; the full text is not duplicated here.

> `lockage-publish` is a CLI command, not an MCP tool (bin: `dist/launcher/publish-cli.js`).
> Invoke it with a means that can run commands, such as Bash. If it is not on PATH, run it with `node <absolute path to the lockage body>/dist/launcher/publish-cli.js`.
> Since the CLI does not receive `mcp.json`'s `env.LOCKAGE_DB`, when you place the ledger other than the default (`~/.lockage/lockage.sqlite`),
> add `--db <the same path as mcp.json's LOCKAGE_DB>` (without it, it looks at a different empty ledger and nothing becomes a PR).

## The main path of PR publishing

1. Confirm the remaining tasks of the same ticket (`list_tasks(ticket_id)`). If tasks remain, proceed to the next task and do not publish a PR yet.
2. **When you set the last task to `task_done`**, confirm `pending_tickets` / `pending_update_tickets` with `publisher_status`.
3. Invoke `lockage-publish --repo-path <absolute path> --ticket <ticket_id>` once.
   - Do not add `--mode` (the default `both` = publish + reconcile).
   - Do not invoke `--mode publish` alone.

## The sweep before session end (safety net)

```
Check publisher_status:
  pending_count > 0 or pending_update_count > 0
    → lockage-publish --repo-path <absolute path> (full sweep. No --ticket. --mode omitted)
  awaiting_merge_count > 0
    → lockage-publish --repo-path <absolute path> --mode reconcile
  all 0 → do nothing
```

## Supplement

- Concurrent launch is safe via the per-ticket advisory lock (a ticket being handled is `skipped` = `locked`). Even if multiple agents
  launch at once, there is no double processing.
- When a task is later added to a ticket that already has a PR and becomes `done`, `ticket_ready` is re-issued and
  appears in `publisher_status`'s `pending_update_tickets`. `lockage-publish` treats this as a follow-up push to the existing PR.
- For the re-branching of follow-up tasks (fixes after opening a PR) and the cleanup note, see the relevant section of `AGENTS.md`.
