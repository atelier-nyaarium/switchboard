#!/usr/bin/env bash
#
# Build a variant and install it over adb, stamping a version code the next CI release outranks.

set -euo pipefail
cd "$(dirname "$0")/.."

variant=${1:-debug}
case "$variant" in
debug) task=assembleDebug ;;
release) task=assembleRelease ;;
*)
	echo "usage: scripts/phone-install.sh [debug|release]" >&2
	exit 2
	;;
esac

# shellcheck source=/dev/null
. ~/android-dev/env.sh

package=com.atelier_nyaarium.switchboard
adb get-state >/dev/null
dump=$(adb shell dumpsys package "$package")
installed=$(printf '%s\n' "$dump" | grep -o 'versionCode=[0-9]*' | cut -d= -f2 | sort -n | tail -1 || true)
installed=${installed:-0}

# Empty when unset, unlike get.
run=$(gh run list --workflow main-push.yml --limit 1 --json number --jq '.[0].number // 0')
offset=$(gh variable list --json name,value --jq '.[] | select(.name == "ANDROID_VERSION_OFFSET") | .value')
offset=${offset:-0}

for value in "$installed" "$run" "$offset"; do
	if ! [[ $value =~ ^[0-9]+$ ]]; then
		echo "phone-install: not a whole number: $value" >&2
		exit 1
	fi
done

ci=$((run + offset))
code=$(((installed > ci ? installed : ci) + 1))
# The newest run may still be in flight.
next_offset=$((code - run + 1))

# Reserve first; builds take minutes.
gh variable set ANDROID_VERSION_OFFSET --body "$next_offset"
echo "phone-install: $variant $code, CI stamps from $((code + 1))"

(cd android && ANDROID_VERSION_CODE=$code ./gradlew ":app:$task" --console=plain)
adb install -r "android/app/build/outputs/apk/$variant/switchboard-$variant.apk"
