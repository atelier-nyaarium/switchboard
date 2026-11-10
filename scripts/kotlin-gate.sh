#!/usr/bin/env bash
#
# The Kotlin half of the gate, from anywhere. Resolves the repo root itself, so a shell left in a
# subdirectory cannot turn the run into "cd: android: No such file or directory".

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# shellcheck source=/dev/null
[ -f ~/android-dev/env.sh ] && . ~/android-dev/env.sh

# CI runs the same guard.
bun scripts/check-kotlin-imports.ts || exit 1

# The generated protocol must match its schemas.
protocol=android/app/src/main/java/com/atelier_nyaarium/switchboard/proto/Protocol.kt
phone_registry=android/app/src/main/java/com/atelier_nyaarium/switchboard/proto/PhoneCapabilityRegistry.kt
integration_registry=android/app/src/main/java/com/atelier_nyaarium/switchboard/proto/IntegrationRegistry.kt
harness_registry=android/app/src/main/java/com/atelier_nyaarium/switchboard/proto/HarnessRegistry.kt
fresh_protocol=$(mktemp)
fresh_phone_registry=$(mktemp)
fresh_integration_registry=$(mktemp)
fresh_harness_registry=$(mktemp)
trap 'rm -f "$fresh_protocol" "$fresh_phone_registry" "$fresh_integration_registry" "$fresh_harness_registry"' EXIT
KOTLIN_PROTOCOL_OUT="$fresh_protocol" \
	KOTLIN_PHONE_CAPABILITY_REGISTRY_OUT="$fresh_phone_registry" \
	KOTLIN_INTEGRATION_REGISTRY_OUT="$fresh_integration_registry" \
	KOTLIN_HARNESS_REGISTRY_OUT="$fresh_harness_registry" \
	bun scripts/codegen-kotlin.ts >/dev/null || exit 1
for pair in "$protocol:$fresh_protocol" "$phone_registry:$fresh_phone_registry" "$integration_registry:$fresh_integration_registry" "$harness_registry:$fresh_harness_registry"; do
	committed=${pair%%:*}
	fresh_file=${pair#*:}
	if ! diff -q "$committed" "$fresh_file" >&2; then
		echo "kotlin-gate: $committed drifted; run bun scripts/codegen-kotlin.ts and commit" >&2
		exit 1
	fi
done

# Fresh regeneration must match.
fixtures=tests/fixtures/wire/kotlin
fresh=$(mktemp -d)
trap 'rm -rf "$fresh" "$fresh_protocol" "$fresh_phone_registry" "$fresh_integration_registry" "$fresh_harness_registry"' EXIT
(cd android && ./gradlew :app:generateWireFixtures -PwireFixturesOut="$fresh" --console=plain) || exit 1
if ! diff -r "$fixtures" "$fresh" >&2; then
	echo "kotlin-gate: $fixtures drifted; run ./gradlew :app:generateWireFixtures from android/ and commit" >&2
	exit 1
fi

cd android || exit 1
# Gradle reports UP-TO-DATE for a task it skipped and for one whose inputs really had not changed,
# so say plainly what this run covered rather than leaving the reader to compare timestamps.
./gradlew :app:testDebugUnitTest --console=plain "$@" || exit 1
echo "kotlin-gate: imports ok, generated Kotlin matches its schemas, wire fixtures match, unit tests pass"
