# Main-tree protection (Kiro Power steering: main-tree-guard)

**Do not edit the main tree (the working tree of the lockage body's repository) directly.**
Edit only inside the `worktree_path` that `assign_worktree` returned. This restates `AGENTS.md`'s
"Principle 2: Always edit inside your assigned worktree. Do not touch the main tree directly" as steering,
to double up the guard so it is effective even in an environment without the hook. For the full text of the principle, see `AGENTS.md`
(the logic is not duplicated here).

## Keep this

- Do all editing, testing, committing inside the `worktree_path`. Run git with `git -C <worktree_path>`.
- When you cannot move into the worktree yourself (CWD cannot be changed), do not start on the mainline.
  Ask the user to switch with `post_board(kind:"question")` and wait.
- Uncommitted changes in the main tree are invisible to other agents and can make another agent's `task_done`
  (the merge performed on the main working tree) fail. Do not leave them.

## Relationship with the hook

The Kiro hook that detects main-tree edits (a guard that judges by exit code with `PreToolUse` targeting `fs_write` / `str_replace` and the like) is
not included in the Power's install; it is placed separately in the target's `.kiro/hooks/`.
There are environments where it is not placed, or where it is disabled.
So this steering is effective even then: explicitly keep to **not editing the main tree directly**.
If the hook rejects a main-tree edit (exit 2), do not redo the same edit by another means such as Bash.
Stop editing and report that it was rejected (per the relevant principle of `AGENTS.md`).

Kiro's hook has nothing corresponding to the Claude Code version's "confirmation (ask)," and main-tree edits are rejected with no confirmation.
`AGENTS.md`'s "If a confirmation is shown for a main-tree edit…" / "Once a confirmation is allowed…" do not apply to Kiro.
Work that falls under the exception below is rejected too, so in that case stop editing and tell the user that, to stop the guard, they need to set the environment variable
`LOCKAGE_GUARD_DISABLE=1` and relaunch Kiro (do not set it yourself to work around it).

## Exception

Only the top of `AGENTS.md`'s "When the user instructs you not to use lockage" is the exception.
For the rules in that case (limiting the scope, pre-confirmation with `list_claims` / `list_dirty`, writing it in the final report, etc.),
follow `AGENTS.md`. Do not omit lockage on your own judgment.
