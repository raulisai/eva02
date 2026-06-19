#!/usr/bin/env bash
# Construye las imágenes de los agentes del Dev Studio en el orden correcto.
# La base debe ir primera porque backend/frontend/testing hacen FROM eva-agent-base.
#
#   ./docker/agents/build.sh           # construye todas
#   ./docker/agents/build.sh backend   # construye solo la base + backend
set -euo pipefail

cd "$(dirname "$0")"

build() {
  local name="$1" dir="$2"
  echo "==> docker build -t $name $dir"
  docker build -t "$name" "$dir"
}

# La base SIEMPRE primero.
build eva-agent-base base

targets=("${@:-backend frontend testing}")
for t in ${targets[@]}; do
  case "$t" in
    backend)  build eva-agent-backend  backend ;;
    frontend) build eva-agent-frontend frontend ;;
    testing)  build eva-agent-testing  testing ;;
    base)     ;;  # ya construida
    *) echo "rol desconocido: $t (usa backend|frontend|testing)"; exit 1 ;;
  esac
done

echo "✓ imágenes de agentes listas"
