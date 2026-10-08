# Current extension wire contract (M1A)

> **Status: deprecated (INFRA-386).** Unversioned legacy wire, kept unchanged and still the default
> (`ajb.wireMode` absent = `legacy`). Superseded by [`browser-harness-v2.md`](browser-harness-v2.md).
> Do not add behavior here; a breaking change is a new `.vN+1` document next to this one.

This document records the existing contract, not the proposed M1B handshake.
There is currently no Browser Harness version negotiation or session binding.

- Local fallback: ws://127.0.0.1:8765, configurable through VITE_WS_* defaults.
- Request: { id, type, payload }; response: { id, success, result, error }.
- Existing per-call connection routing is unchanged.
- Effective server URL: ajb.serverUrl in chrome.storage.local, then packaged
  config.json version 1 wsUrl, then build defaults.
- Existing ajb.token, ajb.connectionId and ajb.pairCode storage namespace remains.
  Pairing/token flows and the persistent installation UUID remain core behavior.
- Chrome minimum remains 116; debugger CDP version 1.3 is unrelated to MCP or
  Browser Harness versioning.
- Background/default new-tab behavior and Copilot safety/traffic gates are
  preserved. House metadata grants no authorization and does not select a server.

M1B will define and test negotiation, capabilities, connection/session binding,
opaque tab handles and correlated responses in a separate change. M1A does not
introduce those semantics or switch to port 18766.
