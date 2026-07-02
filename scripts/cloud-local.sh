#!/usr/bin/env bash
# Run Ledgerly Cloud locally against a hosted Postgres database using
# static-token auth. Loads secrets from the untracked
# server/.env.staging.local file (never commit real values there).
#
# Usage:
#   ./scripts/cloud-local.sh            # migrate, then start
#   ./scripts/cloud-local.sh migrate    # run pending DB migrations only
#   ./scripts/cloud-local.sh start      # start the server only

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/server/.env.staging.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: missing $ENV_FILE" >&2
  echo "Create it with APP_ENV, PORT, CLOUD_AUTH_MODE, CLOUD_STATIC_TOKEN," >&2
  echo "DATABASE_URL, BASIQ_API_KEY, and CORS_ORIGINS. See docs/release/local-staging.md." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

run_migrate() {
  npm --prefix "$ROOT_DIR/server" run migrate
}

run_start() {
  npm --prefix "$ROOT_DIR/server" start
}

cmd="${1:-}"

case "$cmd" in
  migrate)
    run_migrate
    ;;
  start)
    run_start
    ;;
  "")
    run_migrate
    run_start
    ;;
  *)
    echo "error: unknown command '$cmd' (expected 'migrate', 'start', or no argument)" >&2
    exit 1
    ;;
esac
