#!/usr/bin/env bash
# Builds an ad hoc release of the shell and lays it out for over-the-air
# install from the Eddy server:
#
#   <out>/Eddy.ipa
#   <out>/manifest.plist    what itms-services:// reads
#   <out>/index.html        the page a device opens to install
#   <out>/profile-expiry    ISO 8601; the watchdog warns a month before it
#
# <out> is IOS_DIST_PATH, default ~/data/eddy/ios — outside the repo, because
# the ipa's embedded profile carries the team id and every device's UDID. The
# M4 server serves the directory at /ios, tailnet-only like everything else.
#
#   ios/scripts/release-adhoc.sh
#
# Needs Config/Local.xcconfig with DEVELOPMENT_TEAM, Xcode signed in to that
# team, and every target device registered in the developer portal first: an
# ad hoc profile only covers devices that existed when it was generated, so a
# new device means registering it and running this again.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${IOS_DIST_PATH:-$HOME/data/eddy/ios}"
BASE_URL="${EDDY_IOS_BASE_URL:-https://eddyhq.app}"
LOCAL_CONFIG="$PROJECT_DIR/Config/Local.xcconfig"

if [[ ! -f "$LOCAL_CONFIG" ]]; then
  echo "Missing Config/Local.xcconfig — copy Local.xcconfig.example and set DEVELOPMENT_TEAM." >&2
  exit 1
fi

TEAM_ID="$(sed -n 's/^[[:space:]]*DEVELOPMENT_TEAM[[:space:]]*=[[:space:]]*\([A-Z0-9]*\).*/\1/p' "$LOCAL_CONFIG" | head -1)"
if [[ -z "$TEAM_ID" || "$TEAM_ID" == "XXXXXXXXXX" ]]; then
  echo "DEVELOPMENT_TEAM is not set in Config/Local.xcconfig." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/eddy-release.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

# iOS installs over an existing copy more reliably when the build number
# moves, and it says which build a device is running.
BUILD_NUMBER="$(date -u +%Y%m%d%H%M)"

echo "Generating project"
(cd "$PROJECT_DIR" && xcodegen generate --quiet)

echo "Archiving build $BUILD_NUMBER"
xcodebuild archive \
  -project "$PROJECT_DIR/Eddy.xcodeproj" \
  -scheme Eddy \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$WORK_DIR/Eddy.xcarchive" \
  -allowProvisioningUpdates \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  -quiet

# `release-testing` is what Xcode 15.3+ calls ad hoc. The export step is where
# the distribution certificate and the ad hoc profile come in; the archive
# itself is signed for development.
cat > "$WORK_DIR/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>release-testing</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>stripSwiftSymbols</key><true/>
  <key>thinning</key><string>&lt;none&gt;</string>
</dict>
</plist>
EOF

echo "Exporting ad hoc ipa"
xcodebuild -exportArchive \
  -archivePath "$WORK_DIR/Eddy.xcarchive" \
  -exportOptionsPlist "$WORK_DIR/ExportOptions.plist" \
  -exportPath "$WORK_DIR/export" \
  -allowProvisioningUpdates \
  -quiet

IPA="$WORK_DIR/export/Eddy.ipa"
if [[ ! -f "$IPA" ]]; then
  echo "Export produced no Eddy.ipa — see the xcodebuild output above." >&2
  exit 1
fi

unzip -q "$IPA" -d "$WORK_DIR/unpacked"
APP="$WORK_DIR/unpacked/Payload/Eddy.app"
BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw -o - "$APP/Info.plist")"
VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Info.plist")"

security cms -D -i "$APP/embedded.mobileprovision" > "$WORK_DIR/profile.plist" 2>/dev/null
EXPIRY="$(plutil -extract ExpirationDate raw -o - "$WORK_DIR/profile.plist")"
DEVICE_COUNT="$(plutil -extract ProvisionedDevices raw -o - "$WORK_DIR/profile.plist")"

mkdir -p "$OUT_DIR"
cp "$IPA" "$OUT_DIR/Eddy.ipa"
printf '%s\n' "$EXPIRY" > "$OUT_DIR/profile-expiry"

cat > "$OUT_DIR/manifest.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key><string>software-package</string>
          <key>url</key><string>$BASE_URL/ios/Eddy.ipa</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>$BUNDLE_ID</string>
        <key>bundle-version</key><string>$VERSION</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>Eddy</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
EOF

cat > "$OUT_DIR/index.html" <<EOF
<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install Eddy</title>
<style>
  body { font: 17px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 48px 24px;
         background: #111; color: #eee; text-align: center; }
  a.install { display: inline-block; margin: 24px 0; padding: 14px 28px; border-radius: 12px;
              background: #eee; color: #111; font-weight: 600; text-decoration: none; }
  p.meta { color: #999; font-size: 14px; }
</style>
</head>
<body>
<h1>Eddy</h1>
<p>Open this page in Safari on the iPhone or iPad, then tap Install.</p>
<a class="install" href="itms-services://?action=download-manifest&amp;url=$BASE_URL/ios/manifest.plist">Install</a>
<p class="meta">Version $VERSION ($BUILD_NUMBER)</p>
</body>
</html>
EOF

echo
echo "Released Eddy $VERSION ($BUILD_NUMBER) to $OUT_DIR"
echo "  devices in profile: $DEVICE_COUNT"
echo "  profile expires:    $EXPIRY"
echo "  install from:       $BASE_URL/ios/"
