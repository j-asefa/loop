# PR 9b: MCP management, agent tools and MCP app artifacts

Depends on PR 9a. Router: `mcp` in `src/server/mcp/routes.ts`. Seventeen routes. This router was missing from the original bundle inventory; PR 1 added it to the legacy list.

## Routes

`GET /mcp`, `POST /mcp`, `PATCH /mcp/:id`, `POST /mcp/:id/test`, `GET /mcp/catalog`, `POST /mcp/catalog/:id/install`, `POST /mcp/install`, `GET /mcp/native-candidates`, `POST /mcp/native-candidates/:id/import`, `GET|PUT /mcp/preferences`, `GET /mcp/oauth/callback`, `GET|PUT /agents/:id/tools`, `GET /artifacts/:id/app`, `POST /artifacts/:id/refresh`, `POST /artifacts/:id/tool-call`.

## Rules specific to this PR

- Connection responses never include credentials, OAuth tokens or pasted `mcpServers` secrets. `docs/workspace.md` says the browser receives names and transport kinds only for native candidates; make the schema say the same. Test with a connection row carrying a sealed secret and an OAuth token that the response drops both.
- `POST /mcp` accepts manual name/URL/auth setup; `POST /mcp/install` accepts configuration JSON inbound (`mcpServers` form). Preserve both existing input shapes. The body schema is an input schema in `src/shared` and must not be reused as a response.
- `GET /mcp/oauth/callback` is a browser redirect target. Use `kind: "stream"` with a documented redirect; do not validate a JSON response.
- `GET /artifacts/:id/app` serves the isolated MCP App iframe document; `kind: "stream"` with its content type.
- `POST /artifacts/:id/tool-call` and `POST /artifacts/:id/refresh` dispatch through the tool broker with approval checks. Their bodies carry call identities; required exactly as the handler requires them. Responses are the artifact projection or the broker's typed result; never a raw provider payload.
- `GET /agents/:id/tools` returns workspace tool bindings for the owned agent. `PUT` is retired and always returns HTTP 410 after ownership validation; preserve that refusal and its intentionally ignored body. Do not invent a successful selection update.

## Client, tests, acceptance

Move call sites in the Settings tools views; `/mcp-sharing` and `/agent-sources` in the client list are the companion sharing routes and belong to PR 9a if they are app-level, otherwise record where they are registered and type them here. `npm run check`, full baseline, `smoke:workspace`, `smoke:html`, and `node scripts/heavy-command.mjs scripts/mcp-contracts-browser.mjs` in Chromium and WebKit. The existing HTML smoke covers ordinary previews; the MCP journey covers catalog mutations and the isolated MCP app's tool-call and refresh paths. The `mcp` router registers nothing through `legacy`.
