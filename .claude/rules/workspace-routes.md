---
paths:
  - "src/shared/*-routes.ts"
  - "src/server/*-routes.ts"
  - "src/shared/workspace-api.ts"
  - "src/server/registrar.ts"
---

Pointers only; the root AGENTS.md is the source of truth.

- Follow the [route recipe](../../docs/contracts.md#recipe-add-a-workspace-route); the webhook routes are its canonical example.
- Do not import `workspace-api.ts` from a feature routes module.
