#!/usr/bin/env bash

set -uo pipefail
cd "$(dirname "$0")" || exit 1

if ! git fetch --prune; then
	echo "ERROR: git fetch failed; gateway startup aborted" >&2
	exit 1
fi
if ! git pull --recurse-submodules; then
	echo "ERROR: git pull failed; gateway startup aborted" >&2
	exit 1
fi
if ! git submodule update --init --recursive; then
	echo "ERROR: git submodule update failed; gateway startup aborted" >&2
	exit 1
fi
echo "Deploying commit $(git rev-parse HEAD)"

bun ci

grep -qE '^GATEWAY_ID=' .env 2>/dev/null || export GATEWAY_ID="$(hostname)"
EFF_ID="$(sed -n 's/^GATEWAY_ID=//p' .env 2>/dev/null | head -1)"; EFF_ID="${EFF_ID:-${GATEWAY_ID:-$(hostname)}}"

grep -qE '^HOST_WS_TOKEN=' .env 2>/dev/null || echo "HOST_WS_TOKEN=$(openssl rand -hex 32)" >> .env

docker network inspect switchboard-federation >/dev/null 2>&1 || docker network create switchboard-federation >/dev/null

docker compose down --remove-orphans 2>/dev/null || true
docker compose build --pull || echo "WARNING: could not pull a fresh base image, building on the cached one" >&2
if ! docker compose up --build -d; then
	echo "ERROR: docker compose up failed - the gateway was never started" >&2
	exit 1
fi

echo "Waiting for the gateway to be ready..."
for _ in $(seq 1 30); do
	if curl -sf http://localhost:20000/health > /dev/null 2>&1; then
		echo "Gateway ready (Host: $EFF_ID)."
		exit 0
	fi
	sleep 2
done

echo "ERROR: Gateway did not become healthy within 60s - run: docker logs switchboard" >&2
exit 1
