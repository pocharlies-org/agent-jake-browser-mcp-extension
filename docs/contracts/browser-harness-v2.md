# Browser Harness negotiated wire contract (v2) — extension side

Status: **deprecated (INFRA-721)**, superseded by [`browser-harness-v3.md`](browser-harness-v3.md) (the tool set grew, so the catalog digest changed).
Supersedes `browser-harness-v1.md` (deprecated, untouched). The wire,
schemas, errors and limits are defined **once**, in the server repository (`packages/protocol`, doc
`docs/contracts/browser-harness-v2.md`); this extension consumes that package as the vendored tarball
`vendor/protocol/agent-jake-browser-protocol.tgz` (provenance and SHA-256 in `vendor/protocol/provenance.json`,
npm integrity in the lockfile, verified by `npm run verify:protocol` and in CI). There is no second copy of any schema here.

The wire integer `1` of the hello is not the legacy "v1" document; package semver, catalog digest and
the MCP initialize version are further distinct identifiers.

## What the extension does

- **Opt-in.** `ajb.wireMode = 'negotiated'` (popup message `saveServerConfig {wireMode}`); absent = legacy, so
  existing installs are unchanged. The operator enters the negotiated URL (e.g. `wss://host/ws/harness`);
  nothing is appended to a URL by guesswork and there is **no fallback** to the legacy wire.
- **States.** `DISCONNECTED → CONNECTING → NEGOTIATING → READY`; transient failures → `RETRY_WAIT` (fixed 5 s);
  explicit auth/protocol/catalog failures, a hello that is not acknowledged within 5 s, an invalid frame, a tool
  before the ack, or a duplicate ack → `BLOCKED` until configuration changes or an explicit retry. `OPEN` only
  sends **one** hello; heartbeat (20 s, `{type:'heartbeat'}`) starts after the validated `hello_ack`.
- **Ack validation.** Schema, `protocolVersion ∈ offered`, catalog digest equal. `connect()` resolves only after it.
- **Stale protection.** Every callback and operation captures its socket and a generation; stale events are
  ignored, and a finished operation answers only on its original, still-READY socket. `request_cancel` discards
  the late result (the action already performed is not undone); `session_close` notifies a hook and never closes the shared socket.
- **Identity.** `ajb.connectionId` is sent as `installationId` (a hint, never authority). Token, URL and installation id
  survive a failed negotiation. Status (`getStatus.negotiation`) exposes state, last error code, sanitized endpoint
  (no query/token) and wire version.
- **Limits.** 32 MiB per complete message: inbound is checked before parsing (the browser may already have
  allocated the message: no preallocation protection is claimed); an oversize result becomes a bounded
  `payload_too_large` `tool_result` instead of truncation or replay.
- **Session targets.** `IncomingMessage.sessionId` / `tabHandle` are passed to handlers. INFRA-413 owns the
  window-per-session lifecycle and `browser_claim_tab` and must consume these fields, not invent a session map.
  Handle issuance/invalidation (M1B.3) is not part of this revision.

## Compatibility fixture

`vendor/protocol/version-matrix.json` is byte-identical to the server repository's fixture. Both repos execute it
against the real handshake (`tests/unit/background/handshake-matrix.test.ts` here).
