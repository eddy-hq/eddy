#!/usr/bin/env bash
# Drives Safari's share sheet, taps Eddy and checks the card — without the
# extension being able to reach the real Eddy.
#
# The offline guard and the offline build setting come from the one variable
# below on purpose. When they were two arguments on two lines of a README
# command, dropping the build setting left the guard still passing and the
# extension would have posted a real request as whoever's id was supplied.
#
#   ios/scripts/uitest-share-offline.sh [user-uuid] [derived-data-path]
#
# The uuid is only ever a keychain value on the simulator; pass a fabricated
# one, it never reaches a server.

set -euo pipefail

OFFLINE_BASE_URL="https://eddy-offline.invalid"

USER_ID="${1:-$(uuidgen | tr '[:upper:]' '[:lower:]')}"
DERIVED_DATA="${2:-${TMPDIR:-/tmp}/eddy-ios-dd}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Offline share-sheet test"
echo "  base URL:     $OFFLINE_BASE_URL"
echo "  derived data: $DERIVED_DATA"

TEST_RUNNER_EDDY_TEST_USER_ID="$USER_ID" \
TEST_RUNNER_EDDY_TEST_OFFLINE=1 \
exec xcodebuild test \
  -project "$PROJECT_DIR/Eddy.xcodeproj" \
  -scheme EddyUITests \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath "$DERIVED_DATA" \
  EDDY_BASE_URL="$OFFLINE_BASE_URL"
