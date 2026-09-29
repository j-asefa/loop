# Loop mobile app

An Expo/React Native shell around the web app served by a paired laptop workspace. It owns scanning, secure credential storage, origin-restricted web view loading and reconnect UI. The application screens and workspace logic remain in the server's web app.

For device trust, expiry, tunnels and recovery, use the canonical [pairing guide](../docs/pairing.md). A normal host restart preserves paired devices. A changed Quick Tunnel address requires scanning a new code to discover the new origin; it does not require reinstalling the app. Loopback-only URLs are rejected because a phone cannot reach the computer's localhost.

## Develop

Use Node 24 and the SDK pinned in [package.json](package.json). This is a separate npm package:

```sh
cd mobile
npm ci
npm run typecheck
npm run ios       # macOS with Xcode
# or: npm run android  # Android SDK/emulator or connected device
```

Use a native development build for the full camera/secure-storage/web-view flow. Add native dependencies with `npx expo install PACKAGE` so versions match the installed SDK. `npx expo-doctor` diagnoses configuration/dependency issues. Contributor rules are in [AGENTS.md](AGENTS.md).

The root `npm run test:native` exercises [src/connection.ts](src/connection.ts) against a real Loop host. UI-independent connection logic must stay free of React Native imports.

## Bundle checks

These are CI exports, not installable signed apps:

```sh
npm run typecheck
npx expo export --platform ios --output-dir dist/ios
npx expo export --platform android --output-dir dist/android
```

## Build for installation

[eas.json](eas.json) defines an internal `preview` profile (Android APK) and a `production` profile with automatic version increments. Configure your own app identifiers in [app.json](app.json), link the Expo project and set up platform signing credentials:

```sh
npx eas-cli login
npx eas-cli init
npx eas-cli build --platform android --profile preview
npx eas-cli build --platform ios --profile preview
```

Android's preview link installs the APK. iOS internal distribution requires registered devices and appropriate Apple signing credentials; register devices with `npx eas-cli device:create` before the build.

For a production build and submission:

```sh
npx eas-cli build --platform ios --profile production
npx eas-cli submit --platform ios --profile production
```

Complete TestFlight/store setup in the platform account. An Expo export or successful automated test does not establish physical-device installation or store acceptance. Native projects (`ios/`, `android/`) are generated and ignored; maintain configuration through app.json and config plugins.
