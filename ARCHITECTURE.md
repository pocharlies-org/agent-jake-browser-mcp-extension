# ARCHITECTURE.md — agent-jake-browser-mcp-extension

> Extensión MV3 de Browser Harness (canónico: `pocharlies-org/agent-jake-browser-mcp-extension`, tronco `master`).
> Escrito por `developer` en INFRA-386 (primer commit de M1B); el `architect` lo revisa y es quien lo mantiene.

## 1. Clientes y versiones

| cliente | repositorio | versión / contrato | cómo llega |
|---|---|---|---|
| Extensión de Chrome (Chrome ≥116) | este repo (`packages/core`) | contrato `docs/contracts/browser-harness-v2.md` (negociado); `-v1.md` **deprecated** | zip descargable del servidor (`/download`), parea por `/pair` |
| Servidor MCP | `pocharlies-org/agent-jake-browser-mcp-server` | misma `PROTOCOL_VERSION` y mismo catálogo (digest exacto) | imagen del repo k8s |
| Casas | `packages/house-pocharlies`, `packages/house-staticduo` | adaptadores sobre core | composición |

## 2. Dependencias, en ambos sentidos

- **Depende de** — `@agent-jake-browser/protocol`, fuente **solo** en `packages/protocol` del servidor; aquí llega como
  tgz vendorizado (`vendor/protocol/*.tgz` + `vendor/protocol/provenance.json`, hash SHA-256 y digest de catálogo).
  Sin registry, sin firmas: integridad por hash fijado.
- **Dependen de ella** — el servidor (wire WS), INFRA-413 (ciclo de vida de ventana por sesión en `tab-manager.ts`,
  que consume `sessionId`/`tabHandle` de la petición y no inventa mapa de sesión) y el updater DGX-147/309 (hoy en los forks).
- `core` nunca importa una casa (CI: grep `house-pocharlies|house-staticduo|op-safe` = 0 sobre `packages/core`).

## 3. Stack

Node 22, TypeScript, Vite + `@crxjs/vite-plugin`, vitest, Playwright para MV3.

## 4. Componentes compartidos

| concepto | pieza canónica | ruta |
|---|---|---|
| Mensajes, errores, versión, límites | `@agent-jake-browser/protocol` | `vendor/protocol/` (origen: servidor `packages/protocol`) |
| Máquina de estados del WS | `ws-client.ts` + `connection-state.ts` | `packages/core/src/background/` |

## 5. Cómo se construye aquí

Estados: DISCONNECTED → CONNECTING → NEGOTIATING → READY; fallos transitorios → RETRY_WAIT; fallos de
auth/protocolo/catálogo → BLOCKED hasta cambio de configuración o reintento explícito. OPEN no es «conectado»:
solo un `hello_ack` validado. Cada callback captura su socket y generación. Sin fallback al wire legacy.

## 6. Tests

`npm run typecheck`, `npm run test:unit` (vitest, incluye `test:composition`), `npm run build`.
Los tests del wire legacy no se editan; los negociados van al lado.

Contrato de versión (INFRA-390): `vendor/protocol/version-matrix.json` es la misma matriz del servidor (idéntica byte a
byte; el job `contract` del servidor lo comprueba y compara el tgz vendorizado con su pack). `tests/handler-parity.test.ts`
exige un handler por cada tool del catálogo del protocolo que atiende el navegador, y ninguno más. `tests/vendor-protocol.test.ts`
fija que el protocolo vendorizado es el único sitio de esquemas: los que la extensión aún tiene (hasta M1B.3) están listados y
ninguno crece ni aparece uno nuevo.

## 7. CI/CD

`.github/workflows/ci.yml` en runners **`arc-k8s`**. Sin publicación de paquetes ni despliegue desde aquí.

## 8. Trampas

- Forks (`jibanez-staticduo/*`) ≠ canónico (`pocharlies-org/*`).
- `ajb.connectionId` ya guardado se lee como `installationId` (pista, nunca autoridad).
- Un service worker MV3 pierde globales: nunca persistir READY como verdad.
