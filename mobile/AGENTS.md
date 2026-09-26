This is the Loop app: an Expo/React Native shell around the web app served by the `loop` CLI. See README.md for what the shell owns and how pairing and reconnecting work.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Check the installed type definitions in `node_modules`, or fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`.
3. For anything else, fetch https://docs.expo.dev/llms.txt and follow its links to the specific page you need.

## Commands

```bash
npx expo install <package>  # ALWAYS use instead of npm install — resolves SDK-compatible versions
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo export --platform ios   # confirm the app bundles (also android)
```

From the repository root, `npm run test:native` runs `src/connection.ts` against a real Loop host.

## Structure

- `App.tsx`: the screen state machine (welcome, scanner, pairing, web view, can't reach, signed out). There is no router; keep it that way unless the app grows real screens.
- `src/connection.ts`: pairing and health-check protocol. Keep it free of React Native imports; the root test suite imports it.
- `src/storage.ts`: the pairing record in secure storage.
- `src/Scanner.tsx`, `src/ui.tsx`: camera scanner and shared native UI, using the web app's light color tokens.

## Rules

- `ios/` and `android/` are generated (Continuous Native Generation) and ignored. Configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. Camera, secure storage and the web view need a development build: `npx expo run:ios|android`, or an EAS build.
- Security: only the paired origin may load inside the web view, messages are accepted only from that origin, and the bearer token never enters the web page. Keep those properties.
