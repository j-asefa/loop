# Loop V0 progress

- Current work: subscription-first runtime extension implemented; final verification and CI recorded in PR #1.
- Branch: feat/loop-v0. Draft PR: https://github.com/j-asefa/loop/pull/1, targeting main. Do not merge or enable auto-merge.
- Original seven-phase implementation remains: persistent API/worker, agents/history/imports/search, workflows, MCP/native artifacts, PWA and sharing.
- Subscription extension: official Codex 0.156.1 device-code login and Claude Code 2.1.280 native authorization/code handoff; account/model checks, reconnect/logout, isolated per-connection Docker credentials, scrubbed process environment, typed Loop tool requests with existing approvals, no API billing fallback. Subscription-first UI; API keys optional.
- Compose now exposes localhost:3000 without a domain, includes private broker/runtime image and uses an optional HTTPS profile. Setup adds a runtime service token while preserving existing secrets.
- Verified locally: native unsigned status with both pinned CLIs; protocol tests for login/account/answer/tool/quota/isolation; browser subscription flows, actual worker completion, subscription MCP approval, logout and cross-user denial. These are unsigned checks and explicit fixtures, not live subscription inference.
- Evidence: SUBSCRIPTIONS.md, EVIDENCE.md and the PR's exact commit/CI result. Production Docker build + HTTP/native unsigned smoke is a separate hosted CI job.
- Remaining: user completes provider sign-in and verifies bounded model work against subscription allowance; live Datadog/embedding checks if desired; external HTTPS host/tunnel and physical iPhone. No public app URL yet. Subscription outputs are buffered until structured validation. Provider limits/extra-usage settings apply; embedding search remains a separate opt-in API feature.
