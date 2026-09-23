# Provider capabilities · checked 2026-09-23

| Capability | Evidence | Decision / verification |
|---|---|---|
| OpenAI API | https://developers.openai.com/api/docs/guides/text | Real server-side API adapter; key needed for live verification |
| Codex account sign-in | https://learn.chatgpt.com/docs/app-server auth endpoints: account/login/start chatgptDeviceCode; thread APIs | Implemented official app-server device-code flow, subscription identity verification, models/rate limits and per-connection Docker isolation. Live authenticated usage requires user sign-in. |
| Anthropic API | https://platform.claude.com/docs/en/api/overview | API key supports model calls; does not grant consumer history |
| Claude account sign-in | https://code.claude.com/docs/en/agent-sdk/overview (Get started) | Custom Agent SDK/API login remains restricted. Loop now hosts the unmodified Claude Code binary under its documented hosting conditions, using native auth login/status/logout and subscription identity checks. No token exchange/reuse as an API key. See SUBSCRIPTIONS.md and https://code.claude.com/docs/en/legal-and-compliance. |
| Loop identity | https://better-auth.com/docs/installation | Better Auth email/password + optional configured GitHub OAuth. Distinct from provider access. |

No credentials from unrelated conversations are reused. No provider inference or Datadog access has been live-tested at this checkpoint.

Subscription connections are the default UX; API keys are optional. Native CLI credentials stay in isolated runtime volumes. Both runtime versions and verification limits are documented in [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md).
