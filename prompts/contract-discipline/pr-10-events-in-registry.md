# PR 10: events in the registry

Depends on PR 9.

## Goal

The event stream is a typed contract already (`src/shared/workspace-events.ts`: `WorkspaceEvent`, `WorkspaceFrameV3`, `WorkspaceCapabilities`, `WorkspaceClock`) but it lives outside the registry, so the generated document does not describe it. After this PR the document describes the socket endpoint, its query (`v=3`), its frames and the HTTP fallback page from PR 9 against the same schemas, and the client's frame parser imports the registry entry rather than the schemas directly.

## Work

1. Add a `channels` section to the registry: `workspaceApi.events` with `path: "/events/ws"` (server profile) and the paired host's `/ws`, `query: z.object({ v: z.literal("3") })`, `frames: WorkspaceFrameV3`, `kind: "socket"`. The registrar does not mount sockets; `event-sockets.ts` imports the contract for its query validation and for the frame schema it already validates against.
2. The generator emits the channel as an OpenAPI `x-channels` extension (or a separate `docs/openapi-channels.json` if the extension makes the main document invalid for the validator the Cards tests use; decide and record). Frames are referenced components, so `WorkspaceEvent` variants appear once.
3. `src/client/workspace-events.ts` parses frames with `workspaceApi.events.frames`. No wire change.

## Tests

`test/event-sockets.test.ts` unchanged and green; a test that the registry frame schema and the socket's accepted frames are the same object; `openapi:check`; `smoke:feed-events` and `smoke:reconnect`.

## Acceptance

Every byte on the socket is unchanged. The generated document describes the stream. No schema is duplicated between the registry and the socket module.
