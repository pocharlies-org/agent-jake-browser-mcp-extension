# browser-harness-v2 (INFRA-386, M1B) — extension

- **Old surface:** unversioned legacy WS client (`docs/contracts/browser-harness-v1.md`): OPEN = connected, no hello, replies written to whatever socket is current. Unchanged, now marked deprecated, still the default.
- **New surface:** `docs/contracts/browser-harness-v2.md`: opt-in `ajb.wireMode='negotiated'`; hello/hello_ack state machine, BLOCKED/RETRY_WAIT, generation-bound callbacks, 32 MiB bound; schemas from the vendored `@agent-jake-browser/protocol` tgz.
- **Who moves:** the server (paired PR, same fixture and artifact), INFRA-413 (consume `sessionId`/`tabHandle`), operators of both houses and the updater (DGX-147/309) only in the separate authorized rollout. Nothing is deployed or published by this change.
- **Decision recorded in:** INFRA-383 `nota-architect-plan.md` (APROBADO) and the M1B design (`docs/superpowers/specs/2026-10-01-browser-harness-m1b-design.md`, PR #3).
