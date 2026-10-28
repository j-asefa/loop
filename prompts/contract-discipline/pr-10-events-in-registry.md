# PR 10: events in the registry

Depends on PR 9c.

## Goal

The event stream is a typed contract already (`src/shared/workspace-events.ts`: `WorkspaceEvent`, `WorkspaceFrameV3`, `WorkspaceCapabilities`, `WorkspaceClock`) but it lives outside the registry, so the generated document does not describe it. After this PR the document describes the socket endpoint, its query (`v=3`), its frames and the HTTP fallback page from PR 9a against the same schemas, and the client's frame parser imports the registry entry rather than the schemas directly.

## Work

1. Add a `channels` section to the registry: `workspaceApi.channels.events` with `path: "/events/ws"` (server profile) and the paired host's `/ws`, `query: z.object({ v: z.literal("3") })`, `frames: WorkspaceFrameV3`, `kind: "socket"`. Preserve `workspaceApi.events` as the existing HTTP fallback and stable operation ID. The registrar does not mount sockets; `event-sockets.ts` imports the contract and passes it to the replay producer for version negotiation and frame validation.
2. The generator emits the channel as an OpenAPI `x-channels` extension (or a separate `docs/openapi-channels.json` if the extension makes the main document invalid for the validator the Cards tests use; decide and record). Frames are referenced components, so `WorkspaceEvent` variants appear once.
3. `src/client/workspace-events.ts` parses frames with `workspaceApi.channels.events.frames`. No wire change.

## Checkout reconciliation

The existing replay producer constructed frames directly; it did not already parse them through `WorkspaceFrameV3`. Validate V3 frames with the registry schema but serialize the original object to retain field order and bytes. The existing first-query-value rule stays intact: only `v=3` selects V3; missing or other versions retain V2 rather than becoming rejected upgrades. The HTTP fallback retains its raw event-row page, referenced from the channel document rather than reinterpreted as V3 frames.

Use `docs/openapi-channels.json`: the existing Cards document validator only resolves local `#/components/schemas` and `#/components/responses` references. The companion references the existing HTTP fallback components without changing that validator or duplicating them. The HTTP document is also close to the review capture's per-file limit. Unknown/malformed event decoding is a runtime transform; document its canonical `WorkspaceEvent` output, retaining the same tolerant parser. Serialized byte/depth refinements remain runtime constraints.

## Tests

`test/event-sockets.test.ts` unchanged and green; a test that the registry frame schema and the socket's accepted frames are the same object; `openapi:check`; `smoke:feed-events` and `smoke:reconnect`.

## Acceptance

Every byte on the socket is unchanged. The generated document describes the stream. No schema is duplicated between the registry and the socket module.
