# Browser Harness M1B extension implementation plan (A-F resolution recorded)

Read the [extension proposal](../specs/2026-10-01-browser-harness-m1b-extension.md)
and the exact-head paired server contract first. These are future tasks; this PR
changes documentation only and does not authorize a rollout.

## M1B.1: shared protocol and negotiation

- [x] Codex resolves A-F in the shared spec (2026-10-02); conservative handles,
  offline manifest digest, capability_revoked and 32 MiB complete-message bound.
- [ ] Publish/relay the updated exact paired heads; record frozen server design SHA.
- [ ] Vendor the one generated protocol TGZ, provenance and exact lock integrity;
  verify hash before install and CI. Test bundle and actual MV3 worker import.
  Verify packed manifest metadata against packed descriptors/export/provenance
  offline; tampered/stale variants fail, no digest-as-signature claim.
- [ ] Implement negotiated client states, strict hello/ack/reject schemas, 5-second
  proposed timer and 20-second READY-only heartbeat. Runtime connected means READY.
- [ ] Protect all callbacks/completions with socket+generation; no stale reply/replay.
  Connect/cleanup settles once even on close before OPEN or ack.
- [ ] Expose sanitized state/version/errors; preserve URLs/token/UUID/empty-value
  precedence, pairing reload, storage privacy, Copilot gate/lease and unsafe denial.
- [ ] Keep legacy exact-message guards isolated; add separate hello tests for early
  tool, disjoint/invalid versions, mismatched catalog, duplicate ack and timeout.
- [ ] Enforce 32 MiB = 33,554,432 bytes per whole reassembled uncompressed UTF-8
  JSON message in both directions, before parse/send. Test exact bound/bound+1,
  multibyte byte counts, fragmented/compressed aggregate oversize, close1009,
  pending cleanup and local payload_too_large; no replay or undo claim.
- [ ] Measure real screenshot/PDF/drop payloads including envelope/base64/escaping;
  cover existing 10 MiB drop files plus 1 MiB MIME data and eight-file boundary.
  HTTP extension ZIP is not a WS fixture. Record browser preallocation limitation.

Files: `packages/core/src/background/ws-client.ts`, runtime/config/status consumers,
`vendor/protocol`, manifests/lock and unit WS/runtime tests. Server owns protocol
source; extension consumes it without hand-maintained message copies.

## M1B.2: request ownership and per-session context

- [ ] Migrate persistent UUID alias to installationId; keep server browser/live IDs
  separate. Match server enrollment policy without inventing authority from UUID.
  Pair test: shared-token client copies another UUID and cannot replace its socket,
  inherit its identity/binding or settle its pending calls; same/cross-house cases.
- [ ] Strict request/result echo and state validation before handler/CDP. Capture
  origin socket for results; test old operation finishing after reload/disconnect.
- [ ] Pass trusted per-session execution context; handle session-close and cancellation
  without dropping other sessions or promising reversal of completed actions.
- [ ] Prove isolation with two MCP clients/browsers and same JSON-RPC IDs, reordered
  results, forged session/connection, reconnect and wrong-sender replies.
- [ ] Test context/resource cleanup on session change, lost close frame, worker stop,
  socket loss and explicit disconnect; preserve existing Copilot traffic arbitration.

Files: WS client, tool dispatcher/context, background runtime, session tests.
No installed negotiated mode until matching server identity/ownership gates pass.

## M1B.3: handles and shared capability projections

- [ ] Agree live-tab incarnation/recovery algorithm before coding it. Preserve normal
  reconnect continuity only after positive proof and tests for missed close/reuse.
  Default invalidation is fixed; no worker-restart continuity promise from numeric
  tabId/session metadata alone.
- [ ] Carry explicit validated target into tools; remove active/global fallback for
  negotiated requests. Test navigate, close, profile restart, worker sleep/wake,
  foreign handle and two profiles with identical numeric tabId.
- [ ] Project browser schemas/risk/capability and Copilot subsets from one descriptor;
  keep local meta tools local. Test parity with HTTP/stdio projections.
- [ ] Distinguish absent optional capability from failed adapter; no unsafe workaround,
  secret leakage, lost pinned-directory protections or hidden house integration.
- [ ] Test never available capability_unavailable versus same-binding loss after
  reconnect capability_revoked, valid restoration and reset on new session/browser.

Files: `tab-manager.ts`, tool utils/handlers, schema/catalog consumers and capability
tests. House providers and actual CDP allowlists remain subsequent M2 work.

## Pair validation and delivery

After runtime implementation: `npm ci`, `npm run typecheck`, `npm run test:unit`,
`npm run build`, targeted Playwright MV3 pair fixture. Add a negotiated contract
command/workflow; no current extension `test:contract` script is assumed.

Minimum pair matrix: new/new real tool, maximum common/disjoint versions, exact
catalog/mismatch, old/new both directions, no hello, old early tool with zero
actions, wrong auth, multiple browsers/session binding, wrong socket response,
stale completion, cancellation/cleanup, missing capability and tab ownership.
Run both compositions against the same source SHA/TGZ hash; fixtures use synthetic
secrets and loopback endpoints. Retain and execute old wire assertions.

Use one independent proportional review, repair concrete failures and rerun relevant
tests. Record CI links, exact pair commits/artifact hash, real Chrome version,
command results and external platform/minimum-version QA still pending. Baseline
tests are not evidence of M1B negotiated behavior.

Document-only delivery now: link/diff consistency, no runtime/manifests changed,
paired design PRs against canonical master, exact heads relayed by Marlin to Oppo.
Technical merge authority remains delegated to Codex, with an authorized writer
executing exact-head decisions if push rights are absent. Branch protections and
the separately recorded explicit Dani OK before image rollout remain in force.

Separate core new_tab ID bug-fix PR precedes M1B runtime changes: test actual
extension {tab:{id}} and malformed/missing ID, preserve background-tab behavior.
Request original repository/full SHA or PR from Oppo rather than invent provenance.
This design PR implements no bug fix. Legacy retirement remains a later infra step:
both houses migrated under authorization plus 14 full days' notice in topic374,
owned by the house still using legacy; retain executable legacy fixtures afterwards.
