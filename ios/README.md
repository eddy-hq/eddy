# Eddy iOS shell

A thin native wrapper around the PWA at `https://eddyhq.app`. Not a second
client — see `docs/adr/0013-native-ios-is-a-thin-shell-with-apns-push.md`
and brief §21. Stages 1 (shell foundation) and 2 (share extension + App
Intent) are built; signing, OTA distribution and APNs are stages 3–5.

## Layout

`project.yml` is the source of truth. `Eddy.xcodeproj` is generated and
gitignored — never edit project settings in Xcode's UI, edit `project.yml` and
regenerate. No third-party packages.

Four targets:

- **`Eddy`** — the app: web view shell, setup, fallback screen, App Intent.
- **`EddyShare`** — the share extension (`app.eddyhq.Eddy.Share`), embedded in
  the app.
- **`EddyTests`** — unit tests, hosted by the app. The `Eddy` scheme runs them.
- **`EddyUITests`** — one XCUITest that drives Safari's share sheet. It has its
  own scheme and is deliberately not in the `Eddy` scheme's test action: it
  takes half a minute and needs a specially-built app (see *Sharing*).

`Shared/` compiles into both `Eddy` and `EddyShare`: config, identity,
UUID validation, logging, the request client and the share-input rules. Not a
framework and not a package — two small targets sharing a dozen files don't
need a module boundary, and `@testable import Eddy` keeps reaching all of it.
Anything the extension needs belongs in `Shared/`; anything only the app can
use (web view, routing, shell state) stays under `Eddy/`.

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
Simulator builds need no such file. That one setting is also all a device build
needs for the shared keychain: `$(AppIdentifierPrefix)` then resolves to the
team prefix in both targets' entitlements and Info.plists (see *Keychain access
group*), so the app and the extension land on the same group with nothing else
to fill in.

## Releasing to the family's devices

Ad hoc, not TestFlight (ADR-0013). One script builds, signs and publishes:

```sh
ios/scripts/release-adhoc.sh
```

It writes `Eddy.ipa`, `manifest.plist`, an install page and `profile-expiry`
to `~/data/eddy/ios/` (`IOS_DIST_PATH`), which the M4 server serves at `/ios`.
On each device, with Tailscale up, open `https://eddyhq.app/ios/` in Safari and
tap Install. No deploy is needed after a release — the server reads the
directory as it is.

Before the first run:

1. `Config/Local.xcconfig` has `DEVELOPMENT_TEAM`, and Xcode is signed in to
   that team (Settings → Accounts).
2. Every device is registered in the developer portal (Devices → +, by UDID).
   An ad hoc profile only covers devices that existed when it was generated,
   so **a new device means registering it and running the script again**. The
   script prints how many devices the profile covers — check it matches.
3. iOS 16+ wants Developer Mode on for an ad hoc build: Settings → Privacy &
   Security → Developer Mode, which only appears after an install has been
   attempted or the device has been connected to Xcode. On the boys' devices,
   Screen Time's *Installing Apps* must be allowed for the install itself.

The archive is signed for development and re-signed for distribution at
export; that is why Release names a development identity in `project.yml`.
The build number is the UTC timestamp of the run, shown on the install page.

The profile lasts twelve months and the app stops launching the day it lapses.
The watchdog reads `profile-expiry` and writes an `ALERT` line daily from
thirty days out; the fix is to run the script again and reinstall on each
device. Installing over the top keeps the keychain identity, so nobody has to
pair again.

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

In DEBUG builds, a trailing `-eddyUserId <uuid>` on `simctl launch` pairs the
device so the setup screen is skipped — `simctl launch` has no `--args` flag,
everything after the bundle id is argv:

```
xcrun simctl launch booted app.eddyhq.Eddy -eddyUserId <uuid>
```

It writes through to the real shared keychain, not an in-memory store: the
share extension is a separate process and can only see what is actually there.
So it sticks — later launches with no argument stay paired, and the hidden
reset gesture (or a reinstall) is what undoes it.

`-eddyBaseURL <url>` (DEBUG only) points the build at another host, which is
how the unreachable screen gets exercised without unplugging the tailnet:

```
xcrun simctl launch booted app.eddyhq.Eddy \
  -eddyUserId <uuid> -eddyBaseURL https://eddy-offline.invalid
```

That flag is the app only. To point the **share extension** somewhere
harmless, override the build setting instead, which lands in both Info.plists:

```
xcodebuild build … EDDY_BASE_URL=https://eddy-offline.invalid
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

### Keychain access group

The app and the share extension share one keychain item — the userId the app
stored at setup. Both targets carry a `keychain-access-groups` entitlement of
`$(AppIdentifierPrefix)app.eddyhq.Eddy.shared` and surface the same string
through their Info.plist as `EddyKeychainAccessGroup`;
`KeychainAccessGroup.resolve` reads it back and `KeychainIdentityStore` passes
it as `kSecAttrAccessGroup`.

The team prefix is never written down. `$(AppIdentifierPrefix)` resolves at
build time — to the team id when one is available, and to nothing on a machine
with no Apple account, which leaves the bare group. On the simulator either is
fine; its keychain doesn't enforce groups.

On a device the bare form is not fine, and the resolver refuses it. The
entitlement is only ever granted as `TEAMID.app.eddyhq.Eddy.shared`, so asking
for the unprefixed string would fail every `SecItem` call with
`errSecMissingEntitlement` — which `load()` can only report as "no identity",
leaving a device stuck on the setup screen with nothing in the UI to explain
it. A device build that resolves an unprefixed group (or an unexpanded
`$(...)`) logs an error and passes no `kSecAttrAccessGroup` at all, which lands
on the entitlement's *first* group — the shared one, since that is the only
entry either target lists. So the app keeps working and the log says which
build setting didn't arrive.

One simulator quirk worth knowing while testing: an item in the shared group
**survives uninstalling the app**, so a simulator that was paired once comes
back paired after a reinstall. Use the hidden reset gesture, or erase the
device, when you actually want it unpaired.

## Sharing

`EddyShare` is the share extension — the replacement for the Shortcut (§5).

- **What activates it:** one web URL, or text with a link in it. The
  activation rule is a dictionary, not `TRUEPREDICATE`: Eddy has nothing to do
  with a photo or a file and shouldn't clutter those share sheets.
- **What it sends:** whatever was shared, verbatim, as
  `POST /requests {url, userId}`. The server resolves short links, extracts
  the first http(s) URL out of share text and decides whether it's something
  Eddy can fetch — the client never re-implements that, and never invents copy
  for a case the server already explained.
- **What it shows:** a small card. Sending, then the server's own `message`,
  then it dismisses itself after ~1.5s so the person is back in the app they
  shared from. It never opens a URL and never opens Eddy. Every state has a
  way out, sending included — a provider that never answers would otherwise
  leave a spinner with no affordance, so each attachment load is bounded at
  five seconds too.
- **When it can't:** the card stays up with a Close button. A 400/404 shows
  the server's wording; an unreachable host points at Tailscale; an unpaired
  device says to open Eddy first; nothing shareable says so. All of that copy
  lives in `ShareFailure`, which the App Intent throws from too.

The **App Intent** ("Add to Eddy") is the same request over the same identity,
for anyone who preferred the Shortcut. `openAppWhenRun` is false and an
`AppShortcutsProvider` puts it in Shortcuts with no setup — confirmed on the
simulator: Shortcuts lists an **Eddy** section with an **Add to Eddy** tile
without anyone building a shortcut. `AppIntents.framework` is linked explicitly
in `project.yml` — without it the metadata processor finds no dependency, skips
extraction, and the action never appears. Its `link` parameter is optional and
`perform` asks for a value when it's missing: a free-text parameter can't be
carried by a spoken phrase, so a required one would leave the App Shortcut with
nowhere to get one.

### Trying the share extension in the simulator

Never against the live server — a share is a real request. Build the app
pointed at an unroutable host, so a tap proves the plumbing and sends nothing:

```sh
ios/scripts/uitest-share-offline.sh            # fabricates a uuid
ios/scripts/uitest-share-offline.sh <uuid> <derived-data-path>
```

The test pairs the app with `-eddyUserId`, opens a YouTube page in Safari,
goes **More → Share**, taps **Eddy**, and expects the card to say *Can't reach
Eddy*. That wording is the proof: the extension only gets as far as the network
once it has read the app's keychain item — an unpaired device says *This device
isn't connected* instead.

Use the script rather than an assembled `xcodebuild` line. The test's
`EDDY_TEST_OFFLINE=1` guard is the operator *declaring* the build is offline —
the test process can't read the app's `EddyBaseURL` and so cannot check. Set
the flag with the `EDDY_BASE_URL` override missing and tapping Eddy posts a
real request as whatever id was passed in. The script sets both from one
variable so they can't come apart.

By hand, the same thing without the test: install the app, launch it once with
`-eddyUserId`, then share a page from Safari.

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

- The app icon source is `design/icon/AppIcon.svg`; the catalogue holds a flattened 1024px PNG of it.
- No "Open Tailscale" button on the fallback screen: Tailscale publishes no
  documented iOS URL scheme, so there is nothing safe to link to.
- Deep links are unit-tested and the `eddy://` type is registered, but the
  tap-through has never been confirmed by hand: `simctl openurl` raises an
  "Open in Eddy?" confirmation that can't be dismissed without a human. Tap
  **Open** once on the simulator to close that gap.
- Sharing is proven on a device (2026-09-19, cable install): the YouTube
  app's share — text with a link in it, not a URL attachment — reaches the
  extension and the request lands, which also proves the app and the extension
  read the same keychain item under a real team prefix. On the simulator the
  same path was watched from Safari against the live server, for both a
  duplicate of a video already held and a genuinely new request.
- **The App Intent has never run.** It is in Shortcuts, correctly, but tapping
  its tile in the simulator answers "Unable to run App Shortcut" with nothing
  useful in the logs. Two candidates, neither confirmed: App Shortcuts often
  fail to launch their host app in the simulator, or something about the
  intent itself is wrong. Making `link` optional (the documented shape for a
  parameter an App Shortcut can't be given) did not change it. Try it on a
  device before assuming the code is at fault.
- **The release script has never produced an ipa.** It was written without a
  team id to hand, so the archive, the export and an install on a device are
  all unproven. APNs is stages 4–5. Nothing in the repo carries a team id —
  `Local.xcconfig` stays gitignored and is still the only place
  `DEVELOPMENT_TEAM` lives.
- Every simulator build prints one `appintentsmetadataprocessor` notice —
  "Metadata extraction skipped. No AppIntents.framework dependency found" —
  for the `EddyShare` target, which has no App Intents and needs none.
  `ENABLE_APP_INTENTS_METADATA_PROCESSOR = NO` does not stop the task running
  under Xcode 26. It is Xcode's noise, not a Swift warning.
- No offline queueing: a share made with Tailscale down is lost, and the card
  says so rather than pretending. No `navigator.share` bridge for the web
  view either — the PWA's share tile is `canShare`-gated and hides itself.
