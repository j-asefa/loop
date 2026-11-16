---
paths:
  - "src/server/execution-*.ts"
  - "src/server/effect-authority.ts"
---

Pointers only; the root AGENTS.md is the source of truth.

- Follow the [effect recipe](../../docs/architecture.md#recipe-add-an-external-effect); `executionCommand` in execution-commands.ts is its canonical example.
- Do not resubmit an effect whose outcome is unknown.
