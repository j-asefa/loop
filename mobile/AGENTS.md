# Mobile contributor guide

Read [the root contributor guide](../AGENTS.md) for repository-wide rules, [README.md](README.md) for app commands, and [pairing](../docs/pairing.md) when changing connection behavior.

Before touching Expo, EAS or React Native APIs, read the installed versions in [package.json](package.json), then verify installed types or the matching versioned official documentation. Use `npx expo install PACKAGE` for SDK-compatible native dependencies.

| Area                                                | Source                                                       |
| --------------------------------------------------- | ------------------------------------------------------------ |
| Screen state machine                                | [App.tsx](App.tsx)                                           |
| Pairing and health protocol, imported by root tests | [src/connection.ts](src/connection.ts)                       |
| Secure pairing storage                              | [src/storage.ts](src/storage.ts)                             |
| Scanner and native UI                               | [src/Scanner.tsx](src/Scanner.tsx), [src/ui.tsx](src/ui.tsx) |

Keep connection logic free of React Native imports. Preserve origin-restricted web view loads, origin-checked messages and tokens outside page scripts. Configure generated native projects through app.json/plugins. Validate with the relevant root connection tests, mobile typecheck and platform exports described in the README; changes to native behavior also need a device/development build check.
