import type Database from "better-sqlite3";

// Frozen at the named-ledger cutover (main d31122a1, through prefix 121).
// Never derive this history from the current directory or append new files:
// later prefixes can collide or move without changing migration identity.
export const legacyMigrationNames: ReadonlyMap<number, string> = new Map([
  [1, "foundation"],
  [2, "handles"],
  [3, "workspace"],
  [4, "workflows"],
  [5, "mcp"],
  [6, "release"],
  [8, "run-timing"],
  [9, "feed-revisions"],
  [10, "feedback"],
  [11, "agent-creation"],
  [12, "native-hosts"],
  [13, "run-visibility"],
  [14, "search-index-status"],
  [15, "personal-workspace"],
  [16, "projects-and-attention"],
  [17, "mcp-approval-preferences"],
  [18, "agent-traces"],
  [19, "cli-workspace"],
  [20, "native-history-actions"],
  [21, "deployment-profile"],
  [22, "agent-effort"],
  [23, "native-progress"],
  [24, "delete-teams"],
  [25, "live-steering"],
  [27, "hapi-execution"],
  [28, "shared-memory"],
  [29, "native-review-recovery"],
  [30, "agent-activities"],
  [31, "acp-connections"],
  [32, "saved-retirement-notifications"],
  [33, "native-answer-publication"],
  [35, "hapi-pi"],
  [36, "personal-history"],
  [37, "mobile-return"],
  [38, "mobile-continuity"],
  [39, "user-profiles"],
  [40, "trace-search"],
  [41, "reply-excerpt"],
  [42, "pr-watches"],
  [43, "pi-project-trust"],
  [44, "pi-package-recovery"],
  [45, "pr-watch-seen"],
  [46, "unwrap-trace-envelopes"],
  [47, "conversation-feed-hidden"],
  [48, "agent-mail"],
  [49, "repair-conversation-positions"],
  [50, "conversation-pr-watches"],
  [51, "feed-subscriptions"],
  [52, "agent-permission-preference"],
  [53, "mcp-federation"],
  [54, "mcp-reverse-relay"],
  [55, "mcp-federation-revocation"],
  [56, "native-session-permission"],
  [57, "native-session-permission-base"],
  [58, "feed-store"],
  [59, "feed-reads"],
  [60, "feed-sources"],
  [61, "feed-agents"],
  [62, "feed-watches"],
  [63, "feed-browse"],
  [64, "message-run-index"],
  [65, "conversation-transcript"],
  [66, "retired-feed-subscriptions"],
  [67, "hapi-only-harnesses"],
  [68, "pr-watch-registrations"],
  [69, "native-permission-delivery-lease"],
  [70, "team-presets"],
  [71, "restore-native-harnesses"],
  [72, "agent-worktrees"],
  [73, "conversation-message-store"],
  [74, "agent-review-requests"],
  [75, "feed-dismissals"],
  [76, "done-card-dismissals"],
  [77, "project-changes"],
  [78, "project-briefs"],
  [79, "brief-settings"],
  [80, "retire-hapi-records"],
  [81, "conversation-feed-state"],
  [82, "partial-artifact-indexing"],
  [83, "direct-agent-mail"],
  [84, "visible-agent-work"],
  [85, "run-checkouts"],
  [86, "run-verifications"],
  [87, "pr-watch-freshness"],
  [88, "brief-deliveries"],
  [89, "gemini-connections"],
  [90, "brief-enablement"],
  [91, "checkout-run-baseline"],
  [92, "workspace-project"],
  [93, "brief-generation-usage"],
  [94, "brief-reading-summary"],
  [95, "running-builds"],
  [96, "team-feed-visibility"],
  [97, "cards"],
  [98, "card-tokens"],
  [99, "card-reader-display"],
  [100, "remove-briefs-and-status"],
  [101, "native-import-workspaces"],
  [102, "feed-answer-index"],
  [103, "terminal-run-approvals"],
  [104, "done-cards"],
  [105, "done-card-invalidation"],
  [106, "done-author-provenance"],
  [107, "event-subjects"],
  [108, "complete-change-log"],
  [110, "execution-commands"],
  [111, "memory-capture-index"],
  [112, "review-access-index"],
  [113, "native-decision-indexes"],
  [114, "conversation-usage-index"],
  [115, "muse-connections"],
  [116, "personal-decisions"],
  [117, "personal-decision-previews"],
  [118, "grok-connections"],
  [119, "feed-cards"],
  [120, "agent-definitions"],
  [121, "projection-deltas"],
]);

// These one-time repairs are the historical startup rules, preserved verbatim.
// Only translation may normalize the old ledger; the named runner never uses
// it for completion decisions after the translation marker has committed.
export function translateLegacyMigrations(db: Database.Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)",
  );
  if (
    db.prepare("SELECT 1 FROM schema_version LIMIT 1").get() &&
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name IN ('deployment_profile','execution_environments')",
      )
      .get()
  )
    throw new Error(
      "Pre-unification databases are unsupported. Choose a fresh LOOP_DATA_DIR.",
    );
  // Both pre-merge branches used native_sessions and migration IDs 20/21.
  // Detect the actual schema, not the version number, and preserve both histories.
  const columns = db.pragma("table_info(native_sessions)") as {
    name: string;
  }[];
  if (columns.some((c) => c.name === "harness"))
    db.exec("ALTER TABLE native_sessions RENAME TO companion_sessions");
  if (
    columns.some((c) => c.name === "hub_session_id") &&
    !db.prepare("SELECT 1 FROM schema_version WHERE version=27").get()
  ) {
    db.exec(
      "INSERT OR IGNORE INTO schema_version VALUES(27,unixepoch()*1000); DELETE FROM schema_version WHERE version=20",
    );
    if (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='memory_sources'")
        .get()
    )
      db.exec(
        "INSERT OR IGNORE INTO schema_version VALUES(28,unixepoch()*1000); DELETE FROM schema_version WHERE version=21",
      );
  }
  // The Pi customization branch used 40/41, then 42/43, before settling on
  // 43/44: main took 40/41 (trace search, reply excerpts) and 42 belongs to
  // PR watches. Move databases opened on that branch to the final numbers so
  // the migrations that own the old numbers still run.
  const version = (n: number) =>
    db.prepare("SELECT 1 FROM schema_version WHERE version=?").get(n);
  const table = (name: string) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
  if (
    version(42) &&
    version(43) &&
    !version(44) &&
    table("pi_package_recovery")
  )
    db.exec(
      "UPDATE schema_version SET version=44 WHERE version=43; UPDATE schema_version SET version=43 WHERE version=42",
    );
  if (version(40) && table("pi_project_trust") && !table("trace_fts"))
    db.exec("UPDATE schema_version SET version=43 WHERE version=40");
  if (
    version(41) &&
    table("pi_package_recovery") &&
    !(db.pragma("table_info(scheduled_sends)") as { name: string }[]).some(
      (column) => column.name === "reply_excerpt",
    )
  )
    db.exec("UPDATE schema_version SET version=44 WHERE version=41");
  // The trace-envelope cleanup was 45 on its branch before main gave 45 to
  // PR watch history. A 45 without that table was the cleanup: it is 46.
  if (version(45) && !version(46) && !table("pr_watch_seen"))
    db.exec("UPDATE schema_version SET version=46 WHERE version=45");
  // The permission branch used 51 before main assigned it to Social feeds.
  // Preserve databases opened on that branch and let the feed migration run.
  if (
    version(51) &&
    !version(52) &&
    !table("feed_subscriptions") &&
    (db.pragma("table_info(mcp_preferences)") as { name: string }[]).some(
      (column) => column.name === "agent_permission_mode",
    )
  )
    db.exec("UPDATE schema_version SET version=52 WHERE version=51");
  // HAPI's permission lease used 68 before main assigned it to PR-watch
  // registrations. Preserve preview databases and let both migrations run.
  if (
    version(68) &&
    !version(69) &&
    (db.pragma("table_info(native_permissions)") as { name: string }[]).some(
      (column) => column.name === "delivery_expires_at",
    )
  ) {
    db.exec("INSERT INTO schema_version VALUES(69,unixepoch()*1000)");
    if (!table("pr_watch_registrations"))
      db.exec("DELETE FROM schema_version WHERE version=68");
  }
  // The native-restoration preview used 70 before team presets landed on main.
  // Identify that preview by schema and preserve its completed recovery without
  // skipping the team tables or running account recovery a second time.
  if (version(70) && !version(71) && !table("team_creations"))
    db.exec("UPDATE schema_version SET version=71 WHERE version=70");
  // Direct-mail previews used 80 before main assigned it to HAPI retirement.
  // Identify the completed mail schema so retirement still runs and mail is
  // not rebuilt a second time when upgrading a preview workspace.
  if (
    version(80) &&
    !version(83) &&
    (db.pragma("table_info(agent_threads)") as { name: string }[]).some(
      (column) => column.name === "scope",
    )
  )
    db.exec("UPDATE schema_version SET version=83 WHERE version=80");
  // Brief migrations 93/94 originally omitted their completion records.
  // Recognize the applied schema so restarting preserves usage and owner text.
  if (!version(93) && table("brief_generation_usage"))
    db.exec("INSERT INTO schema_version VALUES(93,unixepoch()*1000)");
  if (
    !version(94) &&
    (db.pragma("table_info(brief_items)") as { name: string }[]).some(
      (column) => column.name === "summary",
    )
  )
    db.exec("INSERT INTO schema_version VALUES(94,unixepoch()*1000)");

  const record = db.prepare(
    "INSERT INTO schema_migrations(name,prefix,applied_at) VALUES(?,?,?)",
  );
  for (const row of db
    .prepare("SELECT version,applied_at FROM schema_version ORDER BY version")
    .all() as { version: number; applied_at: number }[]) {
    const name = legacyMigrationNames.get(row.version);
    if (!name)
      throw new Error(
        `Unknown legacy migration ${row.version}; translation requires its historical identity.`,
      );
    record.run(name, row.version, row.applied_at);
  }
}
