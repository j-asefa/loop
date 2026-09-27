# Validation evidence — 2026-09-25

Native compatibility was rerun on 2026-09-27 with the patched Linux ARM64 HAPI binary, Codex 0.157.0 and Claude Code 2.1.280. CLI/Hub typechecks passed; missing and synthetic API credentials remained blocked. No authenticated inference was performed.

These are separate levels of evidence. Synthetic protocol fixtures do not prove provider subscription execution, and fixtures do not prove a full laptop journey with real provider sign-in.

| Area | Implemented boundary and evidence | Outstanding validation |
|---|---|---|
| Existing product | Current PR #2 through `137b82b` preserved; typecheck/build, 167 tests across 29 files; Chromium/WebKit personal smoke and full fixture journeys | Final CI and actual phone install |
| Native compatibility | Real Linux HAPI 0.30.7, Codex 0.157.0, Claude Code 2.1.280 start; patched CLI/Hub typecheck | Human provider sign-in, same-process successful subscription turn, actual native usage limits |
| Credentials/transport | Real Linux Hub/Runner through Loop proxy; mTLS missing/wrong credentials, worker interactive API, copied-token namespace and revocation denial | Replacement fencing |
| Billing | Missing and synthetic cached API auth rejected by official native status; fixture freshness/policy and immutable connection tests; actual-process Codex guard in patched app-server path | Authenticated account-change/expired-token/native queued-turn cases |
| Dispatch/recovery | Stable receipt/local ID, pre-send CAS, unresolved mutation handling, no stale-lease replay, native completion correlation, duplicate projection and history reset tests | Lost acknowledgements across real authenticated Hub/Runner process crashes, native cold resume lineage |
| Approvals/tools | Existing MCP/workflow approval/delegation/browser regressions pass; native exact request identity, durable submitted state, expiry denial, scoped gateway | Real native approve/deny/input prompts and disconnected cancel acknowledgment |
| Teams/workflows | Existing ordering/budget/cancellation tests retained; native children use selected provider policy on same environment | Real mixed-runtime manager/child journey and resident-capacity measurements |
| Memory quality | 32 fixed synthetic questions across four projects, real MemSearch/ONNX with `--network none`; 30/32 recall@5 (93.75%), FTS 31/32, existing local MiniLM 32/32 | Fresh Codex→Claude and reverse, opt-in real corpus, timings on x86 hardware; no claim of improvement |
| Memory scope/deletion | Scope/owner/revision checks, one no-answer query, correction, stale deletion replay, UI note revisions/tombstone; SQLite restore preserves tombstones | Full multi-service restore and deletion replay on a disposable local install |
| Memory resources | Cold 8.28 s; warm p95 8728 ms; indexing p95 4911 ms; max RSS 1,318,064 KiB; index/source files 207,641 bytes | Warm <1 s target **not met** in Linux amd64 emulation on this ARM host; 1.5 s app deadline uses keyword fallback. Not sizing evidence |
| Artifacts | Worker path/descriptor/type/size checks; content-addressed local file write, hash/length confirmation, owner-scoped download | Interrupted upload/retry and phone file open |
| New UI | Real local API at 320/390/1024 widths: setup-required state; memory readiness; note create/edit/remove; native sign-in reopen/provider-isolation/code/cancel protocol fixture | Actual provider sign-in, native approval and uploaded artifact on iPhone |
| Packaging | Digest-pinned app/native/memory images built locally; all tools/source/patches included; offline app/queue containers retain completed diagnostic through API restart with native services absent | Laptop install from the published package |
| Backup/rollback | Additive migrations; SQLite backup restore test passes | Actual coherent app+Hub+worker restore, certificate/credential rotation and rollback drill |

Raw content-free results: [native compatibility](evidence/native-compatibility.json), [private transport](evidence/native-transport.json), [MemSearch evaluation](evidence/memory-evaluation.json), [existing local embedding baseline](evidence/baseline-evaluation.json). Timings were collected while other local workloads were running. MiniLM ran natively on ARM; do not compare its latency directly with emulated x86 ONNX.

Commands:

```sh
npm run typecheck
npm test -- --reporter=dot
npm run build
npm run smoke:browser
npm run smoke:journey
node scripts/native-transport-smoke.mjs
docker run --rm --platform linux/amd64 --network none \
  -v "$PWD/native/compatibility.mjs:/opt/loop-native/compatibility.mjs:ro" \
  loop-architecture-native:validation node /opt/loop-native/compatibility.mjs
```

The offline memory evaluation uses the actual image with `memory/service.py` and `memory/evaluate.py`, a private synthetic token at `/evidence/token`, writable synthetic `/data`, `--network none`, `--cpus 2`, and a 6 GiB requested limit (Docker Desktop had about 3.8 GiB total). No provider/model API calls were made. The existing baseline script uses `localEmbeddings` on exactly `memory/fixtures-v1.json`. Model weights are free local compute; no API key was created.

A published draft PR is not completion of the native acceptance gates. See [laptop operation](../specs/unified-runtime/01-OPERATIONS.md) for setup and recovery.
