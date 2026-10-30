import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { NativeConnections } from "../src/client/NativeConnections";
import { SettingsHome } from "../src/client/SettingsHome";
import type { Connection } from "../src/shared/types";

vi.mock("../src/client/ConnectionNotice", () => ({
  ConnectionNotice: () => null,
}));

it("exposes every connection counted by the settings badge before the tabs", () => {
  const connections: Connection[] = [
    {
      id: "api",
      provider: "openai",
      label: "Old API",
      status: "needs_reconnect",
      models: "[]",
      metadata: "{}",
    },
    {
      id: "native",
      provider: "openai",
      label: "Saved Codex",
      status: "needs_sign_in",
      models: "[]",
      metadata: '{"loop55Harness":"codex"}',
    },
    {
      id: "ready",
      provider: "openai",
      label: "Ready API",
      status: "connected",
      models: "[]",
      metadata: "{}",
    },
  ];
  const home = renderToStaticMarkup(
    <SettingsHome
      open={() => {}}
      theme="system"
      onTheme={() => {}}
      connections={connections}
    />,
  );
  expect(home).toContain("2 need attention");
  const html = renderToStaticMarkup(
    <NativeConnections
      connections={connections}
      onChange={async () => {}}
      onClose={() => {}}
    />,
  );
  const attention = html.slice(
    html.indexOf('aria-label="Connections needing attention"'),
    html.indexOf('aria-label="Connection type"'),
  );
  expect(attention).toContain("Old API");
  expect(attention).toContain("needs reconnect");
  expect(attention).toContain("Open Loop55 runtime API");
  expect(attention).toContain("Saved Codex");
  expect(attention).toContain("needs sign in");
  expect(attention).toContain("Open Harnesses");
  expect(attention).toContain("Refresh Saved Codex");
  expect(attention).not.toContain("Ready API");
});
