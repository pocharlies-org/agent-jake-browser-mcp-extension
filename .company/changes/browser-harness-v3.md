# browser-harness-v3 (INFRA-721, M4b) — extension

- **Old surface:** `docs/contracts/browser-harness-v2.md`: vendored protocol with the 40-tool catalog, digest `sha256:f7e7d2f5…cfe9b5`. Left unchanged and marked deprecated.
- **New surface:** `docs/contracts/browser-harness-v3.md`: vendored protocol re-packed from the server commit of the paired PR (catalog digest `sha256:5fdec80d…2f7`, two added tools); `browser_passkey` stays pending here behind the `passkey` capability.
- **Who moves:** the server (paired PR, same branch name `INFRA-721-m4b-port`); a browser still on the v2 build is rejected on `/ws/harness` until updated; the legacy wire is unaffected. Nothing is deployed or published by this change.
- **Decision recorded in:** INFRA-721 `00-spec.md` (C7e) and INFRA-383 `nota-architect-plan.md`; the passkey gap is declared in INFRA-721 `50-entrega.md`.
