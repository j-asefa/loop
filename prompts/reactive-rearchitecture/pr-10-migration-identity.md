# PR 10: migration identity

Independent cleanup. Land after PR 9b, or before PR 6 if numeric collisions are already blocking parallel work.

## Goal

Migrations are identified by sequence number. `src/server/db.ts` carries about a hundred lines that detect which parallel branch a database came from and renumber its applied versions so the right files still run. A named ledger alone does not solve this: a file name that contains its number changes identity when the number changes on rebase, and rejecting duplicate prefixes still forces renumbering. Fix the identity, not just the ledger.

## Design

1. **Immutable identity.** A migration's identity is its name with the numeric prefix removed, for example `conversation-feed-state`. Names must be unique; the runner refuses to start on a duplicate name. Numeric prefixes order migrations; two files sharing a prefix are allowed and ordered deterministically by name, so independent branches no longer need to renumber. Renumbering a file on rebase changes its order but not its identity.
2. **Ledger.** New table `schema_migrations(name TEXT PRIMARY KEY, prefix INTEGER NOT NULL, applied_at INTEGER NOT NULL)`. The runner records completion itself after each file; future SQL files must not write their own completion records, and the runner rejects a file that inserts into the legacy table.
3. **Legacy compatibility.** Historical SQL files, including 104 to 106, insert into `schema_version` themselves and still run on fresh installs. Keep `schema_version` as a compatibility table that exists for them; "retired" means the runner never reads it after translation and never writes it. Freeze the number-to-name mapping at the translation cutoff in its own module, with the historical branch rules and their comments, rather than inferring history from the future file list.
4. **Translation.** Inside the existing immediate startup transaction: apply the frozen branch rules once, map applied numbers to names, write `schema_migrations`, mark translation done. Startup is idempotent; an interrupted translation reruns safely; simultaneous API and worker startup does not double-apply.
5. Delete the renumbering logic from `db.ts`; document the convention in `docs/development.md`: prefixes order, names identify, same-prefix files are fine, how to add one.

## Tests

- Fresh database; upgrade from a database created on current `origin/main`; restart is a no-op; simultaneous API and worker startup; interrupted translation.
- Fixture databases for each historical branch case the frozen mapping handles; list any case that cannot be reconstructed as a coverage gap in the PR body, not as evidence of safety.
- Duplicate name fails startup; same prefix with different names applies in name order; a file writing `schema_version` is rejected.

## Acceptance

`db.ts` contains no version renumbering; both start paths and concurrent startup pass; the convention is documented.
