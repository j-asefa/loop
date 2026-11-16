Pointers only. The root [AGENTS.md](../../../AGENTS.md) is the source of truth.

- Follow the [SQL recipe](../../../docs/architecture.md#recipe-add-or-extend-a-sql-table-module); [mcp-preferences.ts](mcp-preferences.ts) is its canonical example.
- Search the [SQL index](../../../docs/sql-index.md) before adding a query, and run `npm run sql-index` after changing a module.
- Do not prepare statements at module load; declare them with `statement()` from [statement.ts](statement.ts).
