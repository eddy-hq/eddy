# Eddy iOS shell

A thin native wrapper around the PWA at `https://eddyhq.app`. Not a second
client — see `docs/adr/0013-native-ios-is-a-thin-shell-apns-replaces-ntfy.md`
and brief §21. This is **stage 1**: shell foundation only.

## Layout

`project.yml` is the source of truth. `Eddy.xcodeproj` is generated and
gitignored — never edit project settings in Xcode's UI, edit `project.yml` and
regenerate. No third-party packages.

## Setup

```sh
brew install xcodegen          # once
cd ios && xcodegen generate
```

For a **device** build, copy the config and fill in your team id:

```sh
cp Config/Local.xcconfig.example Config/Local.xcconfig
```

`Local.xcconfig` is gitignored and is the only place `DEVELOPMENT_TEAM` lives.
Simulator builds need no such file.

## Build, test, run

```sh
DD=/tmp/eddy-ios-dd   # anywhere outside the repo

xcodebuild build \
  -project ios/Eddy.xcodeproj -scheme Eddy \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath "$DD"

xcodebuild test \
  -project ios/Eddy.xcodeproj -scheme Eddy \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath "$DD"

xcrun simctl install booted "$DD/Build/Products/Debug-iphonesimulator/Eddy.app"
xcrun simctl launch booted app.eddyhq.Eddy
```

The simulator reaches `eddyhq.app` through the Mac's own tailnet connection.

In DEBUG builds, a trailing `-eddyUserId <uuid>` on `simctl launch` seeds an
in-memory identity so the setup screen is skipped — `simctl launch` has no
`--args` flag, everything after the bundle id is argv:

```
xcrun simctl launch booted app.eddyhq.Eddy -eddyUserId <uuid>
```

`-eddyBaseURL <url>` (DEBUG only) points the build at another host, which is
how the unreachable screen gets exercised without unplugging the tailnet:

```
xcrun simctl launch booted app.eddyhq.Eddy \
  -eddyUserId <uuid> -eddyBaseURL https://eddy-offline.invalid
```

Deep links: `xcrun simctl openurl booted 'eddy://watch/abc'`. iOS raises an
"Open in Eddy?" confirmation for a scheme opened from outside the app, which
needs a tap on the device.

## Configuration

`EDDY_BASE_URL` in `Config/Shared.xcconfig` surfaces through Info.plist as
`EddyBaseURL`. Another household points it at their own host by overriding it
in `Local.xcconfig`. xcconfig strips `//` as a comment even inside a value, so
the scheme separator is spliced in via `$(EDDY_URL_SLASH)` — copy the commented
example rather than typing the URL directly.

An `http` base URL is accepted by `AppConfig`, but App Transport Security
blocks cleartext to a named host and the shipped Info.plist carries no ATS
exception — a household on plain http has to add an `NSExceptionDomains` entry
for their own host. Without one every load fails immediately with a clear
"can't be reached" screen rather than hanging, because the classifier treats
the ATS refusal as a network failure.

## How it behaves

- **The web view is not a browser.** Main-frame navigation is allowed only to
  the configured origin. A tapped off-site link opens in Safari; a scripted one
  is dropped. `target="_blank"` on-origin loads in the same web view — the
  shell never has a second one. `WebNavigationPolicy` decides all of this and
  is unit-tested.
- **Identity** is a `?userId=` the shell appends to every URL *it* loads. The
  PWA re-appends it itself on internal navigation; the shell does not patch
  `history` or otherwise work around the web app.
- **Disconnecting a device:** hold **two fingers anywhere on the screen for two
  seconds**, then confirm. Deliberately obscure so it doesn't collide with the
  PWA's bottom nav (a corner tap target would sit on top of a nav tab) and a
  kid won't find it by accident. Not a security boundary. The fallback screen
  also has a plain "Use a different link" button, since the gesture lives on
  the web view.
- **Unreachable** means a network-class failure or a first load that hasn't
  answered in 20 seconds. An HTTP error page from Eddy itself is not
  unreachable. Returning to the foreground retries automatically.

## Not done yet

- The app icon is an empty placeholder asset.
- No "Open Tailscale" button on the fallback screen: Tailscale publishes no
  documented iOS URL scheme, so there is nothing safe to link to.
- Deep links are unit-tested and the `eddy://` type is registered, but the
  tap-through has never been confirmed by hand: `simctl openurl` raises an
  "Open in Eddy?" confirmation that can't be dismissed without a human. Tap
  **Open** once on the simulator to close that gap.
- Share extension, App Intent, APNs and signing are stages 2–5.
