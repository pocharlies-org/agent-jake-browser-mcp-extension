# Browser Harness negotiated wire contract (v3) — extension side

Status: **active, experimental**. Supersedes [`browser-harness-v2.md`](browser-harness-v2.md) (deprecated, kept as it was). The
definition is in the server repository (`packages/protocol`, doc `docs/contracts/browser-harness-v3.md`); this extension
consumes it as the vendored tarball `vendor/protocol/agent-jake-browser-protocol.tgz`, now re-vendored from the server
commit recorded in `vendor/protocol/provenance.json`. No second copy of any schema lives here.

## What changes for the extension

- The catalog digest in the hello is now `sha256:5fdec80d…2f7` (v2 was `f7e7d2f5…cfe9b5`). A server on v2 rejects this
  extension with `catalog_version_mismatch`, and the other way round: both repos move together.
- `browser_fill_secret` is handled by the server (it sends `browser_type`); the extension has no handler for it and never
  stores what `browser_type` typed (the activity history keeps no payload, covered by a test).
- `browser_passkey` is catalogued behind the `passkey` capability. This extension does **not** offer it yet (the ceremony
  needs the WebAuthn guard, tracked in INFRA-374, which is being split), so a server answers `capability_unavailable` and nothing reaches
  the browser. `tests/handler-parity.test.ts` lists it as pending and fails the day the handler appears without the list
  being updated.
