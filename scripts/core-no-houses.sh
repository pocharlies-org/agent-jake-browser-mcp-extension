#!/usr/bin/env bash
# INFRA-388 (M3, D2/C3): «core sin casas» para TODO el paquete. packages/core (y
# packages/protocol cuando exista) no pueden mencionar las casas: ni
# house-pocharlies, ni house-staticduo, ni op-safe. Las casas son adaptadores en
# packages/house-*; el core/protocol es neutro (regla D2 del plan INFRA-383).
# Extiende (no duplica) la comprobación que hoy solo cubría interaction.ts: el grep
# recorre el paquete entero, código, tests y manifiestos.
set -u
cd "$(dirname "$0")/.."
targets=(packages/core)
[ -d packages/protocol ] && targets+=(packages/protocol)
hits=$(grep -rEn 'house-pocharlies|house-staticduo|op-safe' "${targets[@]}" 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "FALLO: el core menciona casas (regla D2: core sin casas):" >&2
  printf '%s\n' "$hits" >&2
  exit 1
fi
echo "OK: core sin casas (${targets[*]})"
