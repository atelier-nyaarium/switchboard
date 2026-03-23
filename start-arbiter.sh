#!/usr/bin/env bash

pushd "$(dirname "$0")" > /dev/null || exit 1

docker compose down --remove-orphans 2>/dev/null || true
docker compose up --build -d

# Wait for the arbiter to be healthy
echo "Waiting for arbiter to be ready..."
for i in $(seq 1 30); do
	if curl -sf http://localhost:20000/health > /dev/null 2>&1; then
		echo "Arbiter is ready."
		popd > /dev/null
		exit 0
	fi
	sleep 2
done

echo "WARNING: Arbiter did not become healthy within 60s"
popd > /dev/null
exit 1
