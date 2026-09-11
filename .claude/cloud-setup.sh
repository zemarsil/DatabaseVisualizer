#!/bin/bash
# Setup script for the Claude Code cloud environment. Nothing in this repository
# runs it: paste its contents into the "Setup script" field of the environment
# dialog at claude.ai/code. It is kept here so the environment's contents are
# reviewable and can be restored after the roughly weekly cache expiry.
#
# It runs as root once per environment, before Claude Code launches, and its
# result is snapshotted; later sessions reuse the snapshot and skip it. Because a
# non-zero exit stops sessions from starting, every step here is non-fatal.

# Pre-pull the two database images DatabaseVisualizer starts from its UI. Docker
# Hub's blob CDN is not on the Trusted allowlist, so pull from mirrors that are and
# retag to the names server/docker.ts defaults to; the app skips its own pull
# whenever the image is already present. The environment snapshot keeps the images,
# so every later session starts with both already on disk.
set -uo pipefail

dockerd > /tmp/setup-dockerd.log 2>&1 &
dockerd_pid=$!
for _ in $(seq 1 30); do docker info > /dev/null 2>&1 && break; sleep 1; done

# Bounded and non-fatal: a registry that is slow or unreachable must not keep the
# script from exiting zero, or sessions in this environment fail to start.
pull_as() {
  timeout 200 docker pull -q "$1" > /dev/null 2>&1 && docker tag "$1" "$2" \
    || echo "could not prefetch $2; the app will try Docker Hub itself" >&2
}
pull_as mirror.gcr.io/library/postgres:16 postgres:16 & p1=$!
pull_as mirror.gcr.io/library/mariadb:11 mariadb:11 & p2=$!
wait "$p1" "$p2"

# The snapshot keeps the images on disk and the SessionStart hook starts the daemon
# again in each session, so stop it here rather than leave the script waiting on it.
kill "$dockerd_pid" 2>/dev/null
exit 0
