# Executable workflows

OpenProse was evaluated against its current official docs and VM specification on 2026-09-23: https://docs.prose.md/ and https://github.com/openprose/prose/blob/main/skills/open-prose/prose.md . The current contract model delegates session spawning/tool execution and state backends to a Prose-Complete host; the linked Reactor README was not retrievable by the documentation tool. Loop currently has isolated API model calls and a transactional per-user queue, not a Prose-Complete coding harness. Hosting that runtime safely would require an additional isolation/session backend and its approvals bridge.

V0 therefore uses **Loop DSL**, `loop.workflow/v1`, a bounded JSON sequence. It does not claim OpenProse syntax or compatibility. The compiler/runtime seam can later accept a verified OpenProse adapter without changing ownership, approvals or run storage.

A workflow has a title; named text inputs; roles bound to stable agent IDs; sequential steps; named outputs; output folder; and limits. Agent steps interpolate only `{{inputs.name}}` or a prior `{{steps.id}}`. Approval steps review one exact prior output. Save steps write typed artifacts. Unknown/forward references, duplicate steps, cycles, unknown fields and over-budget calls are rejected. No shell, arbitrary code, recursion or implicit scheduling is supported.

Every run snapshots the source version, inputs, provider/model/instructions and connection IDs. Each child has a real conversation and independent durable run. Checkpoints prevent duplicate child submission on worker restart. A lost in-flight child becomes interrupted and stops dependent work. Approvals bind exact content and expire after 24 hours; only the authenticated owner can decide. Pending approvals pause the parent without occupying a worker. Cancelling a workflow cancels its active child.

Bounds: at most 20 steps, 10 model calls, 4,096 output tokens per call, 100,000 input bytes per step, and 1,800 seconds of child runtime. Defaults are lower. These are finite usage ceilings, not fabricated currency estimates; actual model pricing applies. Human review time is excluded. Provider/model IDs come from the selected agents. Live cross-provider evidence requires keys for both providers.

Author in the workflow editor, validate, save a version, fill inputs, then Run. The selected version is displayed beside “Go for it”. Saved workflow artifacts reopen the editor. The history panel links each child conversation and saved result.
