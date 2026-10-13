# Registering the lockage MCP server

> 日本語版: [mcp-registration_ja.md](mcp-registration_ja.md)

This document covers the details of registering the lockage MCP server with a client — the `npx` server definition, the ledger location (`LOCKAGE_DB`), the maintenance tool set, and what to do if you registered the server by hand before.

**For most people this is handled by the plugin / Power.** The Kiro Power, the Claude Code plugin, and the Antigravity plugin each bundle the server definition, so installing it registers the server too — see the "Setup" section of the top [`README.md`](../README.md). Read this document when you want to change the ledger location, use the maintenance tools, or register the server without a plugin.

---

## The server definition

No clone or build is required. You only add a definition that launches the npm-published artifact with `npx`. Follow each client's configuration file format.

```json
{
  "mcpServers": {
    "lockage": {
      "command": "npx",
      "args": ["-y", "lockage"],
      "disabled": false
    }
  }
}
```

The first run may take a little time to fetch. No clone or `npm run build` is needed.

For Kiro, reflect the bundled `plugins/kiro/mcp.json` into Kiro's `mcp.json` as-is (no placeholder replacement is needed). For Claude Code and Antigravity, you do not register it by hand at all: the plugin bundles this `npx -y lockage` definition (`plugins/claude/.mcp.json` / `plugins/antigravity/mcp_config.json`), so installing the plugin registers the server too.

---

## The ledger location (`LOCKAGE_DB`)

The DB (ledger) is stored at `~/.lockage/lockage.sqlite` by default (the parent directory is created automatically). The default is fine; only those who want to change the location set `LOCKAGE_DB` to an absolute path.

Where you set `LOCKAGE_DB` depends on the client:

- **Kiro**: add `"env": { "LOCKAGE_DB": "/absolute/path/to/lockage.sqlite" }` to the `lockage` server in `mcp.json`.
- **Claude Code**: the bundled server has no `env`, so set `LOCKAGE_DB` in the `env` of a Claude Code settings file (usually `~/.claude/settings.json`) instead (see the Claude Code section of [`../plugins/README.md`](../plugins/README.md#claude-code)).
- **Antigravity**: set `LOCKAGE_DB` in the shell environment from which Antigravity is launched; the server inherits it.

When multiple agents coordinate, line everyone up so they **point at the same `LOCKAGE_DB`**. If you leave the default, everyone points at the same default ledger, so no extra configuration is needed. This becomes the shared coordination ledger. If they are not aligned, claim / dirty / board are not shared and conflict avoidance does not work.

`lockage-publish` is a separate command and reads `LOCKAGE_DB` from the environment it is run in, not from the MCP server. When you place the ledger somewhere other than the default, pass `--db` (or set the shell environment variable `LOCKAGE_DB`) wherever you run it; in particular, a terminal outside the MCP client does not have the `env` of a settings file (without showing it the same ledger, even if a ticket is awaiting a PR you get `published: []`).

---

## Tool sets (`LOCKAGE_TOOLSETS`)

Do not write `LOCKAGE_TOOLSETS` in an agent's configuration (only the default `core` is visible). Only when a human uses the maintenance / diagnostic tools, add `"LOCKAGE_TOOLSETS": "maintenance"` to the `env` of that MCP client.

With the Claude Code plugin, the bundled server has no `env`, so register a separate server for maintenance only where a human uses it, and remove it when done:

```bash
claude mcp add lockage-maint -s local -e LOCKAGE_TOOLSETS=maintenance -- npx -y lockage@latest
claude mcp remove lockage-maint -s local
```

Give it a command different from the bundled one (here `lockage@latest`, which can be newer than the version the bundled server runs). Claude Code merges servers with the same command even when their names and `env` differ, so registering it with `npx -y lockage` would replace the bundled server, leaving only the maintenance server in that session (confirmed with Claude Code 2.1.285).

This server exposes the core tools as well as the maintenance ones, as `mcp__lockage-maint__*` (31 tools with lockage 0.9.2, confirmed). While it is registered, lockage-worker sees a second lockage server and returns "failed", so do not launch workers until you remove it. It reads `LOCKAGE_DB` from the environment Claude Code passes to MCP servers, like the bundled server, so it points at the ledger set in the settings `env` (not tried for this server).

---

## If you registered the server by hand before

For Claude Code and Antigravity, the plugin bundles the server definition, so a hand registration is no longer needed. If you registered it by hand before, remove that registration:

- **Claude Code**: `claude mcp remove lockage -s user` (and `-s local` / `-s project` where you registered it per project). If that registration had `env` (`LOCKAGE_DB` in particular), first check it with `claude mcp get lockage` and move it to the `env` of a settings file (matching the registration's scope) before removing; otherwise the ledger silently falls back to the default and this client stops seeing the other agents' tasks. Claude Code merges MCP servers that have the same command: with the same command (`npx -y lockage`), only the hand-registered one is kept even when its name or `env` differs; with a different command, both are registered and two lockage servers line up. See the Claude Code section of [`../plugins/README.md`](../plugins/README.md#claude-code) for details.
- **Antigravity**: `agy mcp remove lockage`.

With a different command, two lockage servers line up; with the same command, only the hand registration is kept and the bundled definition goes unused. Either way, remove the hand registration after moving any `LOCKAGE_DB` in its `env` to the settings file or environment variable.
