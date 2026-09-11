#!/usr/bin/env bash
# Gets a Claude Code on the web session ready to build, typecheck and test this
# repo. Local checkouts are left alone: developers manage their own node_modules.
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-$(dirname "${BASH_SOURCE[0]}")/../..}"

# Reinstall only when the lockfile actually changed. A fresh clone gives every
# file a new mtime, so the comparison is against the lockfile's contents rather
# than its timestamp, and a container restored from the environment snapshot
# keeps the node_modules it already has.
stamp=node_modules/.session-start-lock-hash
want=$(sha256sum package-lock.json | cut -d ' ' -f 1)
if [ "$(cat "$stamp" 2>/dev/null || true)" != "$want" ]; then
  npm ci --no-audit --no-fund
  printf '%s\n' "$want" > "$stamp"
fi

# The image ships dockerd but does not start it, and server/docker.ts reaches the
# daemon over /var/run/docker.sock. Backgrounded and non-fatal: every part of the
# app except the database-container features works without a daemon.
docker_note='The Docker daemon is already running.'
if [ ! -S /var/run/docker.sock ]; then
  if command -v dockerd > /dev/null 2>&1; then
    (dockerd > /tmp/dockerd.log 2>&1 &)
    docker_note='The Docker daemon is starting in the background; `docker info` confirms it once up, and /tmp/dockerd.log holds its output.'
  else
    docker_note='No Docker daemon is available, so the database-container features cannot run here.'
  fi
fi

cat <<NOTES
Dependencies are installed. Checks: \`npm test\` (vitest), \`npm run typecheck\`
(client + server), \`npm run check:docs\` (walkthrough validation).
${docker_note}
NOTES
