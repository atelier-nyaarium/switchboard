#!/usr/bin/env bash

pushd "$(dirname "$0")" > /dev/null || exit 1

docker compose down --remove-orphans 2>/dev/null || true
docker compose up --build -d

popd > /dev/null
