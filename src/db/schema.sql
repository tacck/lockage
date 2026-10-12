-- =========================================================
-- coord-dev-mcp schema (per minimal-design.md §3)
-- Source of truth = local SQLite (WAL). Issue the following PRAGMAs at startup.
--   PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
--
-- Distribution meta columns are added to every table:
--   host_id : the originating host (fixed to the local host in Phase 1)
--   origin  : 'local' | 'synced' | 'candidate' (fixed to 'local' in Phase 1)
-- =========================================================

-- ---------- tickets: the container for work items (cross-cutting, long-lived, never claimed. model 3) ----------
CREATE TABLE IF NOT EXISTS tickets (
    id            TEXT PRIMARY KEY,            -- UUID/ULID
    title         TEXT NOT NULL,
    body          TEXT,                        -- body (background / acceptance criteria). Indexed by FTS5
    status        TEXT NOT NULL DEFAULT 'open' -- open|in_progress|closed
                     CHECK (status IN ('open','in_progress','closed')),
    priority      INTEGER NOT NULL DEFAULT 0,  -- larger is higher priority. Ties break by created_at ascending. Negatives allowed (defer). Rough guide -10/0/10/100
    assignee      TEXT,                        -- assignee (not a claim; just an owner label)
    version       INTEGER NOT NULL DEFAULT 0,  -- D-4 decided: optimistic lock on body/status (CAS only via update_ticket)
    integration_branch TEXT,                   -- per-ticket PR: integration branch name (NULL = not yet created). A-2
    ticket_ready_at INTEGER,                   -- per-ticket PR: time ticket_ready was emitted (NULL = not emitted). CAS prevents double emission. A-3
    created_by    TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    host_id       TEXT NOT NULL,
    origin        TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

-- ---------- ticket_repos: ticket↔repo cross-cutting (many-to-many, D-1 decided = join table) ----------
-- Convention: a ticket with no rows = fully cross-cutting (repo-independent). One or more rows = it concerns those repos.
CREATE TABLE IF NOT EXISTS ticket_repos (
    ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    repo       TEXT NOT NULL,
    host_id    TEXT NOT NULL,
    origin     TEXT NOT NULL DEFAULT 'local',
    PRIMARY KEY (ticket_id, repo)
);
CREATE INDEX IF NOT EXISTS idx_ticket_repos_repo ON ticket_repos(repo);

-- ---------- tickets_fts: full-text search over ticket bodies (FTS5) ----------
CREATE VIRTUAL TABLE IF NOT EXISTS tickets_fts USING fts5(
    title, body,
    content='tickets',
    content_rowid='rowid',
    tokenize='trigram'          -- substring search for Japanese (unicode61 cannot segment CJK)
);
CREATE TRIGGER IF NOT EXISTS tickets_ai AFTER INSERT ON tickets BEGIN
    INSERT INTO tickets_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS tickets_ad AFTER DELETE ON tickets BEGIN
    INSERT INTO tickets_fts(tickets_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS tickets_au AFTER UPDATE ON tickets BEGIN
    INSERT INTO tickets_fts(tickets_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO tickets_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- ---------- tasks: the task entity (has a version column for optimistic locking) ----------
CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    ticket_id     TEXT REFERENCES tickets(id) ON DELETE SET NULL,  -- parent ticket (nullable. model 3)
    repo          TEXT NOT NULL,               -- a task is repo-local (FR-7.4)
    title         TEXT NOT NULL,
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'open' -- open|in_progress|done|abandoned|blocked
                     CHECK (status IN ('open','in_progress','done','abandoned','blocked')),
    assignee      TEXT,                        -- the claiming agent_id (NULL = unclaimed)
    priority      INTEGER NOT NULL DEFAULT 0,  -- larger is higher priority. Ties break by created_at ascending. Negatives allowed (defer). Rough guide -10/0/10/100
    version       INTEGER NOT NULL DEFAULT 0,  -- for CAS. +1 on every update
    heartbeat_at  INTEGER,                     -- last liveness time of the claim holder (unix sec)
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    host_id       TEXT NOT NULL,
    origin        TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_ticket   ON tasks(ticket_id);
CREATE INDEX IF NOT EXISTS idx_tasks_repo     ON tasks(repo);

-- ---------- task_edges: the dependency DAG (blocks edges) ----------
CREATE TABLE IF NOT EXISTS task_edges (
    from_task  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    to_task    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT 'blocks' CHECK (kind IN ('blocks')),
    host_id    TEXT NOT NULL,
    origin     TEXT NOT NULL DEFAULT 'local',
    PRIMARY KEY (from_task, to_task)
);
CREATE INDEX IF NOT EXISTS idx_edges_to ON task_edges(to_task);

-- ---------- claims: advisory lease over file globs ----------
CREATE TABLE IF NOT EXISTS claims (
    id            TEXT PRIMARY KEY,
    holder        TEXT NOT NULL,               -- agent_id
    globs         TEXT NOT NULL,               -- JSON array string
    task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    lease_ttl_sec INTEGER NOT NULL DEFAULT 28800,  -- 8h
    heartbeat_at  INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,            -- heartbeat_at + lease_ttl_sec (denormalized)
    released_at   INTEGER,                     -- explicit release time (NULL = active)
    created_at    INTEGER NOT NULL,
    host_id       TEXT NOT NULL,
    origin        TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_claims_active  ON claims(released_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_claims_holder  ON claims(holder);

-- ---------- publish_locks: a per-ticket publish advisory lock (lease/TTL) ----------
-- An advisory lock that closes the read→act race where two lockage-publish processes pick up
-- the same ticket simultaneously. It mirrors the lease/TTL design of the claims table (glob lease)
-- and is acquired/stolen via a BEGIN IMMEDIATE CAS. PK=ticket_id serializes only the same ticket
-- and does not block other tickets (other tickets in the batch keep being processed). A row with expires_at < now is considered stale and may be stolen.
CREATE TABLE IF NOT EXISTS publish_locks (
    ticket_id    TEXT PRIMARY KEY,            -- 1 ticket = 1 lock. Does not block other tickets
    holder       TEXT NOT NULL,               -- the acquirer token (ulid). Used to authenticate the release
    acquired_at  INTEGER NOT NULL,            -- acquisition time (unix seconds)
    expires_at   INTEGER NOT NULL,            -- expiry time (acquired_at + ttl). Past this it may be stolen
    host_id      TEXT NOT NULL,
    origin       TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_publish_locks_expires ON publish_locks(expires_at);

-- ---------- board_messages: the shared board / directed handoff ----------
CREATE TABLE IF NOT EXISTS board_messages (
    id           TEXT PRIMARY KEY,
    seq          INTEGER NOT NULL,             -- a monotonically increasing cursor. Assigned MAX+1 inside BEGIN IMMEDIATE
    author       TEXT NOT NULL,
    to_agent     TEXT,
    -- kind has no CHECK (option 3): the value set will keep growing (note/handoff/question/ticket_ready/…),
    -- so the app-layer z.enum (src/index.ts) is the single source of truth. Changing a CHECK in SQLite
    -- requires recreating the table, which is costly each time it grows, so the DB does not constrain it.
    -- State-machine columns (status/state/edges.kind) are fixed by design, so they are still guarded by a DB CHECK (dividing principle: a growing enum lives in the app layer / a fixed one in the DB).
    kind         TEXT NOT NULL DEFAULT 'note',
    body         TEXT NOT NULL,
    ref_task_id  TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    ref_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,  -- a reference pointing at a ticket, e.g. ticket_ready. A-3
    -- Issue #49: the resolution state of a question. NULL = unresolved / non-NULL = resolved (at that time). resolved_by is
    -- the resolving actor (auto-resolve = the assignee who set the task to done/abandoned, manual resolve = the agent_id of resolve_question).
    -- No CHECK (same policy as kind. The source of truth is the app layer: resolve_question rejects anything other than a question).
    resolved_at  INTEGER,                      -- NULL = unresolved. Used to filter read_board(unresolved_only)
    resolved_by  TEXT,                          -- the agent_id of the resolving actor (nullable)
    created_at   INTEGER NOT NULL,
    host_id      TEXT NOT NULL,
    origin       TEXT NOT NULL DEFAULT 'local'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_seq ON board_messages(seq);
CREATE INDEX IF NOT EXISTS idx_board_to  ON board_messages(to_agent, seq);

-- context_entries / context_fts (context tied to git commits) were removed in #69.
-- Tables left in an existing DB are not DROPped so as not to erase records (harmless since nothing reads or writes them).
-- Because an old DB still has these names, do not create a table with the same name for another purpose (CREATE TABLE IF NOT EXISTS
-- would do nothing and keep running with the old column layout).

-- ---------- worktree_assignments: agent↔worktree physical isolation ----------
CREATE TABLE IF NOT EXISTS worktree_assignments (
    id             TEXT PRIMARY KEY,
    agent_id       TEXT NOT NULL,
    worktree_path  TEXT NOT NULL,              -- 1 worktree = 1 agent (the core of physical isolation)
    repo_path      TEXT,                       -- the repo's FS root (target of git -C). The merge treats it as the source of truth
    branch         TEXT NOT NULL,
    base_sha       TEXT,                       -- the branch-point commit SHA. Used later to compute the diff from base (git diff --name-only <base_sha>...HEAD). NULL for old rows / failed resolution
    task_id        TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
    created_at     INTEGER NOT NULL,
    released_at    INTEGER,
    host_id        TEXT NOT NULL,
    origin         TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_wt_agent  ON worktree_assignments(agent_id, status);
-- "1 worktree = 1 agent" applies only to active rows (partial UNIQUE).
-- A column-level UNIQUE would also make released history unique and conflict with §4.5 "reconnect returns to the same deterministic path"
-- (you could not re-INSERT the same path). Limiting it to active satisfies both.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wt_path_active
    ON worktree_assignments(worktree_path) WHERE status = 'active';

-- ---------- agents: session liveness management (the basis for crash-expiry decisions) ----------
CREATE TABLE IF NOT EXISTS agents (
    agent_id      TEXT PRIMARY KEY,
    label         TEXT,
    last_seen_at  INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    host_id       TEXT NOT NULL,
    origin        TEXT NOT NULL DEFAULT 'local'
);

-- ---------- dirty_sets: pre-commit change announcement (mutable. FR-1.5. D-2 = per-file) ----------
CREATE TABLE IF NOT EXISTS dirty_sets (
    id             TEXT PRIMARY KEY,
    agent_id       TEXT NOT NULL,
    worktree_path  TEXT NOT NULL,
    files          TEXT NOT NULL,              -- JSON array: changed file paths (per file)
    updated_at     INTEGER NOT NULL,
    host_id        TEXT NOT NULL,
    origin         TEXT NOT NULL DEFAULT 'local',
    UNIQUE (agent_id, worktree_path)           -- one dirty-set row per worktree (overwritten)
);
CREATE INDEX IF NOT EXISTS idx_dirty_agent ON dirty_sets(agent_id);

-- ---------- merge_queue: the serial queue for the integration merge gate (FR-1.6) ----------
CREATE TABLE IF NOT EXISTS merge_queue (
    id             TEXT PRIMARY KEY,
    seq            INTEGER NOT NULL,           -- serial processing order. Same numbering discipline as board: MAX+1 inside BEGIN IMMEDIATE
    agent_id       TEXT NOT NULL,
    worktree_path  TEXT NOT NULL,
    branch         TEXT NOT NULL,
    task_id        TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    repo           TEXT NOT NULL,
    state          TEXT NOT NULL DEFAULT 'queued'  -- queued|merging|merged|needs_review
                      CHECK (state IN ('queued','merging','merged','needs_review')),
    precheck       TEXT,                        -- 3-way precheck result (JSON)
    target_branch  TEXT,                        -- per-ticket PR: the aggregation target branch (NULL = base, backward compatible). A-1
    enqueued_at    INTEGER NOT NULL,
    processed_at   INTEGER,
    host_id        TEXT NOT NULL,
    origin         TEXT NOT NULL DEFAULT 'local'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_seq   ON merge_queue(seq);
CREATE INDEX IF NOT EXISTS idx_merge_state ON merge_queue(state, seq);

-- ---------- wakes: the pending queue for A2A wakes (§4.8. non-board wake signals such as overlap) ----------
-- The board is represented by board_messages (fetched incrementally by the seq cursor), but transient wake signals
-- that should not be left on the board, such as overlap, are stacked here and consumed by wait_for_unblock.
-- take_pending_wakes(agent_id, kind) = read the rows with consumed_at IS NULL and mark them consumed.
CREATE TABLE IF NOT EXISTS wakes (
    id            TEXT PRIMARY KEY,
    target        TEXT NOT NULL,               -- the agent_id to wake
    kind          TEXT NOT NULL                -- overlap|task_ready|board (currently only overlap goes through this table)
                     CHECK (kind IN ('overlap','task_ready','board')),
    payload       TEXT,                        -- JSON (originating agent / files, etc.)
    created_at    INTEGER NOT NULL,
    consumed_at   INTEGER,                     -- consumed time (NULL = pending)
    host_id       TEXT NOT NULL,
    origin        TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_wakes_pending ON wakes(target, kind, consumed_at);
