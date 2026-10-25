# PR 7: teams, agent mail, definitions, sharing, notifications

Depends on PR 6. Routers: `teams` (9), `agentMail` (4), `agentDefinitions` (5), `sharing` (3), `notifications` (3), `viewportDiagnostics` (1). Twenty-five routes.

## Routes

Teams: `GET /teams`, `GET /team-presets`, `POST /teams`, `POST /teams/from-preset`, `POST /teams/:id/members`, `PATCH /teams/:id/feed-visibility`, `DELETE /teams/:id`, `POST /teams/:id/reviews`, `GET /reviews/conversation/:id`. Mail: `GET /teams/:id/messages`, `POST /teams/:id/threads/:threadId/resume`, `GET /agents/:id/mail`, `POST /agents/:id/mail/:threadId/resume`. Definitions: `GET /agent-definitions`, `GET|PUT|DELETE /agent-definitions/:id`, `POST /agent-definitions/:id/create`. Sharing: `POST /share/preview`, `POST /share/send`, `POST /routing/preview`. Notifications: `GET /notifications`, `POST|DELETE /notifications/subscriptions`. Diagnostics: `POST /ui/viewport-diagnostics`.

## Rules specific to this PR

- `PublicTeam` exists; `preset_config` stays `Text`.
- `POST /teams/:id/reviews` and `GET /reviews/conversation/:id` are the review-request and status routes the review loop itself uses (`src/server/code-reviews.ts`, `review-snapshot.ts`). Type them exactly; the status response's `reviewId`, `fingerprint` and lead `conversationId` are what `process.md` tells agents to compare, so field names do not change.
- Mail responses come from `agent-mail.ts` (1,468 lines; do not refactor it). `agent-mail-schema.ts` holds the agent-facing tool input schemas (`messageSchema`, `directorySchema`, `statusSchema`), not response shapes; declare the thread and message projections from what the four handlers return, and keep them consistent with the tool status output so one thread shape serves both the browser and `loop_message_status`.
- `agent-definitions` bodies are Markdown with frontmatter; the body schema is the raw text with the existing size limit, validated by the handler as today.
- Notifications subscriptions carry Web Push keys inbound; they are input, never echoed in a response. Test it.

## Client, tests, acceptance

Move call sites; record deferred ones. Full baseline, `openapi:check`, `smoke:workspace`. None of the six routers registers through `legacy`.
