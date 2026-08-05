#!/usr/bin/env bash
# Thin wrapper around ingest.mjs, meant to be the script for both CI
# and a human testing locally.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# .env.ingest, not .env -- wrangler itself auto-loads a plain .env in the cwd
# and would silently use its CLOUDFLARE_API_TOKEN for wrangler's OWN commands
# (deploy, whoami, ...), overriding your `wrangler login` session.
if [[ -f .env.ingest ]]; then
  set -a
  source .env.ingest
  set +a
fi

DOCS_ROOT="../support-docs/docs"
if [[ $# -gt 0 && "$1" != --* ]]; then
  DOCS_ROOT="$1"
  shift
fi

if [[ ! -d "$DOCS_ROOT" ]]; then
  echo "docs root not found: $DOCS_ROOT" >&2
  echo "usage: $0 [path/to/support-docs/docs] [ingest.mjs args...]" >&2
  exit 1
fi

if [[ "$*" != *"--dry-run"* && ( -z "${CLOUDFLARE_ACCOUNT_ID:-}" || -z "${CLOUDFLARE_API_TOKEN:-}" ) ]]; then
  echo "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or pass --dry-run)" >&2
  exit 1
fi

node scripts/ingest.mjs "$DOCS_ROOT" "$@"
