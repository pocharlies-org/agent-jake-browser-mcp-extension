#!/usr/bin/env bash
# INFRA-388 (M3, C4b): la build de la extensión solo es desplegable desde el repo
# CANONICO pocharlies-org/agent-jake-browser-mcp-extension. Un fork (p. ej.
# jibanez-staticduo/*) no es origen: agent-browser-sync.sh (x86-host-runtime) instala la
# extensión solo desde el canonico. El mismo principio lo aplica el updater
# (dgx-infra k8s/infrastructure/update-watch/forkers/) antes de construir; este script
# es la guarda visible en la CI de GitHub: el job `source-guard` lo corre en cada push/PR
# y su self-test demuestra en cada run que un origen no canónico sale BLOQUEADO.
#
#   image-origin-guard.sh                 # comprueba el repo del run (GITHUB_REPOSITORY)
#   image-origin-guard.sh <origin>        # comprueba un origen concreto (dry-run)
#   image-origin-guard.sh --self-test     # run de CI: exige fallo con origen intruso y
#                                         # paso con el repo real
set -u
CANONICAL="${IMAGE_ORIGIN_GUARD_CANONICAL:-pocharlies-org/agent-jake-browser-mcp-extension}"

check() { # check <origen>
  local origin="$1"
  # normaliza: acepta owner/repo, URL git o https
  origin="${origin#https://github.com/}"; origin="${origin#git@github.com:}"
  origin="${origin%.git}"
  if [ "$origin" = "$CANONICAL" ]; then
    echo "OK: origen desplegable $origin (canonico)"
    return 0
  fi
  echo "BLOQUEADO: $origin no es el canónico ($CANONICAL)." >&2
  echo "  La build de la extension solo se despliega desde" >&2
  echo "  $CANONICAL; desde un fork no hay build desplegable (agent-browser-sync la instala solo desde el canonico)." >&2
  return 1
}

if [ "${1:-}" = "--self-test" ]; then
  # Prueba del fallo desde un origen no canónico (C4b): si el guard dejara pasar a un
  # intruso, el self-test revienta y el run de CI va en rojo.
  if check "intruder-fork/agent-jake-browser-mcp-extension" 2>/dev/null; then
    echo "SELF-TEST-FALLO: el guard NO bloqueo un origen no canonico" >&2
    exit 1
  fi
  echo "SELF-TEST: origen no canonico bloqueado (esperado)"
  # En CI es GITHUB_REPOSITORY; fuera de GitHub, el remote origin del checkout.
  check "${GITHUB_REPOSITORY:-$(git remote get-url origin 2>/dev/null)}" || exit 1
  echo "SELF-TEST-OK: falla desde origen no canónico, pasa desde el canónico"
  exit 0
fi

check "${1:-${GITHUB_REPOSITORY:-$(git remote get-url origin 2>/dev/null || echo desconocido)}}"
