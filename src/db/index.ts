import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Location of schema.sql.
 * dev (tsx): read src/db/schema.sql directly.
 * build (tsc): tsc does not copy .sql, so the schema is copied to dist/db/ at build time
 * (handled by package.json's build script). Phase 1 simply assumes "the schema.sql at the same
 * level as this file".
 */
const SCHEMA_PATH = join(__dirname, 'schema.sql');

export interface OpenOptions {
  /** DB file path. ':memory:' for in-memory (for tests). */
  path: string;
  /** This host's identifier. Defaults to os.hostname(). Phase 1 is pinned to the own host. */
  hostId?: string;
}

export interface CoordDb {
  readonly db: DatabaseSync;
  readonly hostId: string;
  close(): void;
}

/**
 * Open SQLite, issue PRAGMAs, and apply the schema idempotently.
 * - journal_mode=WAL: concurrent read/write (but WAL is unavailable for :memory:, so skip)
 * - foreign_keys=ON: enable FK constraints
 * - busy_timeout=5000: wait up to 5s on lock contention (both BEGIN IMMEDIATE and the following PRAGMAs). Set it first
 */
export function openDb(opts: OpenOptions): CoordDb {
  // A file DB cannot be opened by SQLite if its parent directory (default ~/.lockage/; changeable
  // via LOCKAGE_DB) does not exist. Create it idempotently here. This SQLite is the primary source
  // of truth for state.
  if (opts.path !== ':memory:') {
    const dir = dirname(opts.path);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(opts.path);
  const hostId = opts.hostId ?? hostname();

  // Set busy_timeout first. If set later, while another concurrently started connection is opening/
  // closing the DB (WAL recovery, etc.), the following journal_mode switch fails immediately with
  // SQLITE_BUSY instead of waiting. This happens on concurrent startup regardless of migration.
  db.exec('PRAGMA busy_timeout=5000;');
  // :memory: does not support WAL. Use WAL only for a file DB.
  if (opts.path !== ':memory:') {
    db.exec('PRAGMA journal_mode=WAL;');
  }
  db.exec('PRAGMA foreign_keys=ON;');

  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  // Checked before schema.sql creates it: see seedBoardCursors.
  const hadBoardCursors = hasTable(db, 'board_cursors');

  // Apply the issue → ticket rename (#70) before schema.sql. If applied after, CREATE TABLE IF NOT
  // EXISTS would create an empty tickets first, making the existing issues impossible to rename.
  migrateIssuesToTickets(db, schema);

  // Apply the schema idempotently (the CREATE TABLE IF NOT EXISTS group).
  // New tables such as publish_locks are applied idempotently by schema.sql's CREATE TABLE IF NOT
  // EXISTS and are created here if absent in an existing DB (brand-new tables, so migrate()'s column
  // additions are not needed).
  db.exec(schema);

  // Idempotent migration for an existing DB. CREATE TABLE IF NOT EXISTS does not add columns to an
  // existing table, so newly added columns are checked for presence via PRAGMA table_info and ALTERed.
  migrate(db);
  if (!hadBoardCursors) seedBoardCursors(db);

  return {
    db,
    hostId,
    close() {
      db.close();
    },
  };
}

/**
 * When board_cursors is first added to an existing ledger, give every agent already known to it a
 * read position at the current MAX(seq), for both directed and broadcast. Without this, those
 * agents would start directed at 0 like a brand-new agent and see every past post addressed to them
 * (long-resolved questions and handoffs) as unread. Agents first seen later still start directed at
 * 0, so a handoff to a not-yet-launched worker is still picked up.
 *
 * "Known" = in agents, or named as an author or to_agent on the board. INSERT OR IGNORE keeps two
 * processes opening the ledger at once from conflicting. A brand-new ledger has nobody to seed.
 */
export function seedBoardCursors(db: DatabaseSync): void {
  db.prepare(
    `INSERT OR IGNORE INTO board_cursors (agent_id, directed_seq, broadcast_seq, updated_at)
     SELECT k.agent_id, m.seq, m.seq, ?
       FROM (SELECT agent_id FROM agents
             UNION SELECT author FROM board_messages
             UNION SELECT to_agent FROM board_messages WHERE to_agent IS NOT NULL) AS k,
            (SELECT COALESCE(MAX(seq), 0) AS seq FROM board_messages) AS m`,
  ).run(unixNow());
}

/** Whether a column exists (PRAGMA table_info). */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/** Whether a table exists (sqlite_master). */
function hasTable(db: DatabaseSync, table: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table) !== undefined
  );
}

function renameColumnIfExists(db: DatabaseSync, table: string, from: string, to: string): void {
  if (hasTable(db, table) && hasColumn(db, table, from)) {
    db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  }
}

/**
 * #70: in step with renaming lockage's work unit from issue to ticket, move the existing DB's
 * tables, columns, and board kinds to the new names (idempotent). Does nothing if issues is absent
 * (new DB) or tickets already exists.
 *
 * FTS5's external-content setting (content='issues') does not follow a table rename, so drop
 * issues_fts and its triggers, re-create it as tickets_fts via schema.sql, and rebuild the index.
 * Also drop the old indexes (they would remain rewritten to point at the new column names after the
 * rename and duplicate the new-named ones that schema.sql creates).
 *
 * The rename, applying schema.sql, and rebuilding the index are committed in a single transaction.
 * If it stops midway, the next startup sees tickets so migration does not run, leaving an empty
 * tickets_fts. Updating a pre-migration ticket then would make FTS5's delete look for a row absent
 * from the index and raise SQLITE_CORRUPT_VTAB.
 *
 * @param schema the contents of schema.sql (read by the caller).
 * @returns true if a rename was performed.
 */
export function migrateIssuesToTickets(db: DatabaseSync, schema: string): boolean {
  if (!hasTable(db, 'issues') || hasTable(db, 'tickets')) return false;

  db.exec('BEGIN IMMEDIATE');
  try {
    // The pre-lock check may be stale if another concurrently started process finished the migration first.
    if (!hasTable(db, 'issues') || hasTable(db, 'tickets')) {
      db.exec('COMMIT');
      return false;
    }
    db.exec(`
      DROP TRIGGER IF EXISTS issues_ai;
      DROP TRIGGER IF EXISTS issues_ad;
      DROP TRIGGER IF EXISTS issues_au;
      DROP TABLE IF EXISTS issues_fts;
      DROP INDEX IF EXISTS idx_issues_status;
      DROP INDEX IF EXISTS idx_issue_repos_repo;
      DROP INDEX IF EXISTS idx_tasks_issue;
      ALTER TABLE issues RENAME TO tickets;
    `);
    renameColumnIfExists(db, 'tickets', 'issue_ready_at', 'ticket_ready_at');
    if (hasTable(db, 'issue_repos')) {
      db.exec(`ALTER TABLE issue_repos RENAME TO ticket_repos`);
    }
    renameColumnIfExists(db, 'ticket_repos', 'issue_id', 'ticket_id');
    renameColumnIfExists(db, 'tasks', 'issue_id', 'ticket_id');
    renameColumnIfExists(db, 'publish_locks', 'issue_id', 'ticket_id');
    renameColumnIfExists(db, 'board_messages', 'ref_issue_id', 'ref_ticket_id');
    if (hasTable(db, 'board_messages')) {
      // lockage-publish looks at the board's ticket_ready to find tickets awaiting a PR, so move the old kind too.
      db.exec(`UPDATE board_messages SET kind = 'ticket_ready' WHERE kind = 'issue_ready'`);
    }
    db.exec(schema);
    db.exec(`INSERT INTO tickets_fts(tickets_fts) VALUES ('rebuild')`);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already closed */
    }
    throw e;
  }
  return true;
}

/**
 * Backward-compatible migration for an existing DB (idempotent).
 * - worktree_assignments.repo_path: the FS root of the repo that merge uses for `git -C`. Absent in
 *   an old DB, so ADD COLUMN (existing rows stay NULL = fall back to the argument at merge time).
 * - worktree_assignments.base_sha: the fork-point commit SHA, to compute the diff from base later.
 *   Absent in an old DB, so ADD COLUMN (existing rows stay NULL = the diff side falls back to status only).
 * - Per-ticket PR (A-1〜A-3): ADD COLUMN for tickets.integration_branch / tickets.ticket_ready_at /
 *   merge_queue.target_branch / board_messages.ref_ticket_id (all nullable).
 * - Remove the CHECK (note|handoff|question) on board_messages.kind (option 3). SQLite requires a
 *   table rebuild to change a CHECK, so if the old CHECK remains in the DDL string, copy to _new and swap.
 */
export function migrate(db: DatabaseSync): void {
  if (!hasColumn(db, 'worktree_assignments', 'repo_path')) {
    db.exec(`ALTER TABLE worktree_assignments ADD COLUMN repo_path TEXT`);
  }
  if (!hasColumn(db, 'worktree_assignments', 'base_sha')) {
    db.exec(`ALTER TABLE worktree_assignments ADD COLUMN base_sha TEXT`);
  }
  // Per-ticket PR additional columns (idempotent)
  if (!hasColumn(db, 'tickets', 'integration_branch')) {
    db.exec(`ALTER TABLE tickets ADD COLUMN integration_branch TEXT`);
  }
  if (!hasColumn(db, 'tickets', 'ticket_ready_at')) {
    db.exec(`ALTER TABLE tickets ADD COLUMN ticket_ready_at INTEGER`);
  }
  if (!hasColumn(db, 'merge_queue', 'target_branch')) {
    db.exec(`ALTER TABLE merge_queue ADD COLUMN target_branch TEXT`);
  }
  if (!hasColumn(db, 'board_messages', 'ref_ticket_id')) {
    db.exec(`ALTER TABLE board_messages ADD COLUMN ref_ticket_id TEXT`);
  }
  // Issue #49: a question's resolution state (NULL = unresolved). Existing rows stay NULL = backward compatible (readable as unresolved).
  if (!hasColumn(db, 'board_messages', 'resolved_at')) {
    db.exec(`ALTER TABLE board_messages ADD COLUMN resolved_at INTEGER`);
  }
  if (!hasColumn(db, 'board_messages', 'resolved_by')) {
    db.exec(`ALTER TABLE board_messages ADD COLUMN resolved_by TEXT`);
  }
  migrateBoardKindCheck(db);
}

/**
 * Remove the CHECK constraint on board_messages.kind (option 3). SQLite cannot drop a CHECK via
 * ALTER, so if the old CHECK (kind IN ...) remains in sqlite_master's DDL string, rebuild the table.
 * board has only the seq UNIQUE index and no triggers, so _new create → copy → DROP → RENAME →
 * recreate indexes is safe. A new DB (schema.sql creates it without a CHECK) does not match the DDL and is a no-op.
 */
function migrateBoardKindCheck(db: DatabaseSync): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='board_messages'`)
    .get() as { sql: string } | undefined;
  if (!row || !/CHECK\s*\(\s*kind\s+IN/i.test(row.sql)) return; // no CHECK = no rebuild needed

  db.exec('BEGIN IMMEDIATE');
  try {
    // Include ref_ticket_id / resolved_at / resolved_by in the new table too, assuming they already
    // exist from the ADD COLUMN above (otherwise the new columns vanish the moment an old CHECK-ed DB
    // is migrated; the Issue #49 pitfall).
    db.exec(`
      CREATE TABLE board_messages_new (
        id            TEXT PRIMARY KEY,
        seq           INTEGER NOT NULL,
        author        TEXT NOT NULL,
        to_agent      TEXT,
        kind          TEXT NOT NULL DEFAULT 'note',
        body          TEXT NOT NULL,
        ref_task_id   TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        ref_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
        resolved_at   INTEGER,
        resolved_by   TEXT,
        created_at    INTEGER NOT NULL,
        host_id       TEXT NOT NULL,
        origin        TEXT NOT NULL DEFAULT 'local'
      );
      INSERT INTO board_messages_new
        (id, seq, author, to_agent, kind, body, ref_task_id, ref_ticket_id, resolved_at, resolved_by, created_at, host_id, origin)
        SELECT id, seq, author, to_agent, kind, body, ref_task_id, ref_ticket_id, resolved_at, resolved_by, created_at, host_id, origin
          FROM board_messages;
      DROP TABLE board_messages;
      ALTER TABLE board_messages_new RENAME TO board_messages;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_board_seq ON board_messages(seq);
      CREATE INDEX IF NOT EXISTS idx_board_to  ON board_messages(to_agent, seq);
    `);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already closed */
    }
    throw e;
  }
}

/** unix seconds (integer). All tables' *_at are unified as unix seconds. */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
