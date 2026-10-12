#!/usr/bin/env node
/**
 * lockage-publish — the ③ publish CLI (problem B, B-4).
 *
 * A 1-shot command that publishes unprocessed ticket_ready (push the integration branch + create a
 * PR) and reconciles merged PRs (clean up the integration branch + reset integration_branch to
 * NULL). It can be called from cron, an orchestrator, or by hand. Since "the core does not publish",
 * it is a separate bin from the main binary (the lockage MCP server).
 *
 * Usage:
 *   lockage-publish --repo-path <abs> [--mode both|publish|reconcile]
 *                   [--ticket <id>] [--base <branch>] [--provider github|gitlab]
 *                   [--agent-id publisher] [--db <path>] [--server-entry <p>]
 *
 * Defaults:
 *   --mode          : both (run publish → reconcile in order; the natural sweep for periodic runs)
 *   --base          : resolveBaseBranch(repo) (infer dev/stg/main/master from what exists)
 *   --provider      : determined from the origin remote's host (github by default)
 *   --agent-id      : "publisher" (the author of pr_opened/pr_merged)
 *   --db            : $LOCKAGE_DB → ~/.lockage/lockage.sqlite (the cross-repo ledger)
 *   --server-entry  : the index.js in the same dist as this CLI
 */
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBaseBranch } from '../lockage/git.js';
import { LockageClient } from './client.js';
import { publishReadyTickets, reconcileMergedPrs } from './publish.js';
import { makePublishAdapter, detectProvider } from './publish-adapter.js';

const USAGE =
  `lockage-publish — turn ticket_ready into PRs and clean up merged PRs (problem B)\n\n` +
  `Required:\n` +
  `  --repo-path <abs>     absolute path to the local repo where the integration branch exists\n\n` +
  `Optional:\n` +
  `  --mode <m>            both (default) | publish | reconcile\n` +
  `  --ticket <id>         process only this ticket (omit to process all unprocessed)\n` +
  `  --base <branch>       the PR base (inferred via resolveBaseBranch if omitted)\n` +
  `  --provider <p>        github (default) | gitlab (auto-detected from the origin host)\n` +
  `  --agent-id <id>       the author of pr_opened/pr_merged (default publisher)\n` +
  `  --db <path>           the cross-repo ledger (default $LOCKAGE_DB → ~/.lockage/lockage.sqlite)\n` +
  `  --server-entry <p>    the lockage server's dist/index.js (default: bundled)\n`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'repo-path': { type: 'string' },
      mode: { type: 'string', default: 'both' },
      ticket: { type: 'string' },
      base: { type: 'string' },
      provider: { type: 'string' },
      'agent-id': { type: 'string', default: 'publisher' },
      db: { type: 'string' },
      'server-entry': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const mode = values.mode ?? 'both';
  if (
    values.help ||
    !values['repo-path'] ||
    (mode !== 'both' && mode !== 'publish' && mode !== 'reconcile')
  ) {
    process.stderr.write(USAGE);
    process.exitCode = values.help ? 0 : 2;
    return;
  }

  const repoPath = resolve(values['repo-path']!);
  const here = dirname(fileURLToPath(import.meta.url)); // dist/launcher
  const serverEntry = values['server-entry']
    ? resolve(values['server-entry'])
    : join(here, '..', 'index.js'); // dist/index.js
  const dbPath =
    values.db ?? process.env.LOCKAGE_DB ?? join(homedir(), '.lockage', 'lockage.sqlite');
  const agentId = values['agent-id']!;

  const provider =
    values.provider === 'github' || values.provider === 'gitlab'
      ? values.provider
      : detectProvider(repoPath);
  const adapter = makePublishAdapter(provider);

  // base is only needed for publish. Explicit > resolveBaseBranch(repo).
  let base = values.base;
  if (!base) {
    try {
      base = resolveBaseBranch(repoPath);
    } catch {
      base = 'main';
    }
  }

  const client = new LockageClient({ serverEntry, dbPath, toolsets: ['publisher'] });
  await client.connect();
  const result: Record<string, unknown> = { provider, mode, repoPath };
  let hadFailure = false;
  try {
    if (mode === 'both' || mode === 'publish') {
      const published = await publishReadyTickets(client, adapter, {
        repoPath,
        base: base!,
        agentId,
        onlyTicket: values.ticket,
      });
      result.published = published;
      if (published.some((o) => o.result === 'failed')) hadFailure = true;
    }
    if (mode === 'both' || mode === 'reconcile') {
      const reconciled = await reconcileMergedPrs(client, adapter, {
        repoPath,
        agentId,
        onlyTicket: values.ticket,
      });
      result.reconciled = reconciled;
      if (reconciled.some((o) => o.result === 'failed')) hadFailure = true;
    }
  } finally {
    await client.close();
  }

  process.stdout.write(JSON.stringify(result) + '\n');
  // Non-zero if there is at least one per-ticket failure (so cron can detect an anomaly).
  process.exitCode = hadFailure ? 1 : 0;
}

main().catch((e) => {
  process.stderr.write(`lockage-publish fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
