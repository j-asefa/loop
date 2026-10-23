# PR 1: runtime helpers in TypeScript

## Goal

The `runtime/` directory holds 27 JavaScript modules and 13 hand-written `.d.mts` declaration files for the ones the typed server imports (seventeen import sites: `grep -rn 'from "../../runtime/' src/server`). The declarations drift from the implementations with no compiler check. Convert the directory to TypeScript so the compiler owns those contracts, with no behavior change, across all three ways the code ships.

## Current state to verify

- Declarations exist for `claude-steering`, `concurrency`, `diagnostics`, `harness`, `idle-deadline`, `model-options`, `native-tools`, `protocol`, `published-files`, `redaction`, `steering`, `traces`, `uploads`.
- `runtime/broker.mjs`, `entry.mjs`, `host.mjs` and the codex modules run as standalone processes inside the runtime containers. `Dockerfile.runtime` and `Dockerfile.runtime-broker` both `COPY runtime/ /runtime/` and run the source files directly; emitting compiled output only into `dist/support` would break those images.
- `scripts/build-runtime-assets.mjs` stages `runtime` into `dist/support` for the packaged build; `package.json` lists `runtime` under `files`.
- `runtime/protocol.mjs` and `src/protocol.ts` are different modules that share a name; do not merge them.

## Changes

1. Rename each `runtime/*.mjs` to `.ts`, delete its `.d.mts`, and put the types the declaration promised in the source. Where a declaration was wrong, the source wins and the server call site is fixed.
2. Add `runtime` to the typecheck, either in the root `tsconfig.json` include set or as a referenced project if module settings conflict; `npm run typecheck` must cover it.
3. Three ship paths must keep working, each with explicit verification:
   - **Source mode** (`npm run dev`, `tsx`): server imports resolve to the `.ts` files.
   - **Packaged build**: `build-runtime-assets.mjs` compiles `runtime` to JavaScript in the `dist/support` layout the server expects; update the staged import paths.
   - **Containers**: add a compilation or staging step the Dockerfiles use, so the image entrypoints run compiled JavaScript. Update `Dockerfile.runtime`, `Dockerfile.runtime-broker`, `docker-bake.hcl` and `deployment/` as needed.
4. Update the seventeen server imports to whatever paths the three ship paths agree on.

## Out of scope

Behavior changes, renames beyond the extension, and the `src/protocol.ts` versus `runtime/protocol` naming.

## Acceptance

- No `.d.mts` remains under `runtime/`; `npm run typecheck` reports zero errors with `runtime` included.
- `npm run build`, `npm test -- --maxWorkers=1`, `npm run test:native` and `npm run smoke:package` pass.
- With a Docker daemon: the runtime broker image builds and `node scripts/compose-smoke.mjs` runs against it. Without one, state that the container path was not exercised and that this is a coverage gap, not a pass.
- Every type mismatch the compiler surfaced is listed in the PR body with how it was resolved; those are the bugs this PR exists to find.
- A move counts twice in the review capture; confirm the capture fits before requesting review.
