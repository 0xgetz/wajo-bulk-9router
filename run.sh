#!/usr/bin/env bash
# wajo-bulk-9router — quick launcher
# Usage: ./run.sh [create|serve|connect|verify|models] [args...]
set -euo pipefail

CMD="${1:-serve}"
shift || true

case "$CMD" in
  create)  node src/cli.js create "$@" ;;
  serve)   exec node src/adapter.js "$@" ;;
  connect) node src/cli.js connect "$@" ;;
  verify)  node src/cli.js verify "$@" ;;
  models)  node src/cli.js models "$@" ;;
  chat)    node src/cli.js chat "$@" ;;
  *)       echo "usage: ./run.sh [create|serve|connect|verify|models|chat] [args...]" >&2; exit 1 ;;
esac
