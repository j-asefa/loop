Pointers only. The root [AGENTS.md](../AGENTS.md) is the source of truth, including its rule on preserving historical data.

- Naming, ordering and the completion ledger: [database migrations](../docs/development.md#database-migrations).
- A migration that changes stored rows gets a `test/<name>-migration.test.ts` that migrates rows released versions wrote, as [artifact-role-migration.test.ts](../test/artifact-role-migration.test.ts) does.
