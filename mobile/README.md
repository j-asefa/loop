# Loop app

The standalone phone app for a Loop workspace running on your computer. Install it once; it keeps its icon and pairing across Quick Tunnel address changes, so you never re-add a web page to your home screen.

It is a thin native shell around the same web app `loop` serves. The shell owns the things a home-screen web app can't:

- **One install, whatever the address.** The app's identity doesn't depend on the tunnel URL it is currently showing.
- **Pairing in the app.** It scans the code from `loop pair` with the camera and pairs with a bearer credential (`POST /pair` with `credential: "bearer"`). The token is kept in the iOS Keychain / Android Keystore (`expo-secure-store`, this device only, excluded from backups).
- **Reconnecting.** It checks `GET /session` every 15 seconds while open and whenever it returns to the foreground. If your computer stays unreachable (it is asleep, offline, or Loop restarted with a new Quick Tunnel address), the app shows **Can't reach your computer**. Run `loop pair` on the computer and tap **Scan new code**; the app pairs with the new address and reloads itself. Each scan is a fresh pairing, so it creates a new entry in Settings → This computer; an address change already revoked the old one. If the device is revoked, its pairing expires, or Loop restarts at the same `--public-url` address (paired devices don't survive a restart), the app asks you to pair again.
- **Web view hand-off.** The web view opens `/session/open` once with the bearer token. The host sets its usual HttpOnly cookie, and the unmodified web app works from there. Only the paired workspace loads inside the app; other links open in the system browser.

Reconnecting is deliberately a manual, in-person scan: nothing lets a remote service point a paired phone at a different address.

A Quick Tunnel code (`https://….trycloudflare.com`) or `--public-url` HTTPS origin works. `--local-only` codes (`http://127.0.0.1…`) can't be reached from a phone and are rejected. With `--public-url`, the address never changes, so the app only needs re-pairing after a revocation, expiry (7 days) or restart.

## Develop

This is a separate package from the `loop` CLI; the repository root's `npm test`, `npm run check` and packaging ignore it. Node 22.19+.

```sh
cd mobile
npm ci
npx tsc --noEmit
npx expo-doctor
```

Camera, secure storage and the web view are native modules, so Expo Go is not enough to run the full app. Use a development build (`npx expo run:ios` / `npx expo run:android` with Xcode or Android Studio), or an EAS build (below). Add dependencies with `npx expo install`, which picks versions compatible with this Expo SDK.

`src/connection.ts` holds the pairing and health-check protocol with no React Native imports. `test/mobile-connection.test.ts` in the repository root runs it against a real Loop host, so a server change that would break the app fails `npm run test:native`.

## Build and install (internal distribution)

Builds use [EAS](https://docs.expo.dev/eas/) and are distributed privately; nothing is published to a public store listing. You need an Expo account, plus an Apple Developer account for iOS.

1. Change `ios.bundleIdentifier` and `android.package` in `app.json` if you want your own identifiers.
2. `npx eas-cli@latest login`, then `npx eas-cli@latest init` to link the project.

**iPhone (TestFlight internal testing, no App Review):**

```sh
npx eas-cli@latest build --platform ios --profile production
npx eas-cli@latest submit --platform ios
```

Then add yourself as an internal tester in App Store Connect → TestFlight and install from the TestFlight app. Later builds arrive as TestFlight updates.

Alternatively, `--profile preview` builds an ad-hoc IPA for devices registered with `npx eas-cli@latest device:create`.

**Android (APK):**

```sh
npx eas-cli@latest build --platform android --profile preview
```

Open the build link on the phone and install the APK (allow installs from that source when prompted).

Moving to a public store listing later uses the same builds and a different distribution channel; nothing in the app assumes internal distribution.
