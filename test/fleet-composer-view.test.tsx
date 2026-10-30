import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderApp } from "../src/client/app/AppView";
import type { AppViewProps } from "../src/client/app/AppViewProps";
import { fleetOperationReason } from "../src/client/fleetCapabilities";
import { profileCapabilities } from "../src/shared/capabilities";
import { workspaceApi } from "../src/shared/workspace-api";

// Keep the actual AppView -> composer path. Navigation and thread loading are
// outside this control-state regression; the conversation displays its composer.
vi.mock("../src/client/app/AppPages", () => ({ renderAppPages: () => null }));
vi.mock("../src/client/Conversation", () => ({
  Conversation: ({ composer }: { composer: ReactNode }) => composer,
}));

const peer = "peer:m_" + "1".repeat(64);
afterEach(() => vi.unstubAllGlobals());

it.each(["read-only", "unavailable", "writable"])(
  "renders the peer conversation's %s send controls through AppView",
  (mode) => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { onLine: true });
    const capabilities = {
      ...profileCapabilities("companion"),
      fleet: {
        version: 1 as const,
        machineId:
          mode === "unavailable" ? "m_" + "2".repeat(64) : peer.slice(5),
        reads: [],
        actions: mode === "writable" ? ["submit"] : [],
        files: false,
        events: false,
      },
    };
    const composerUnavailable = fleetOperationReason(
      peer,
      capabilities,
      workspaceApi.submit,
    );
    const agent = {
      id: "fixture-agent",
      name: "Fixture",
      provider: "codex",
      model: "fixture-model",
    };
    const data = { agents: [agent], connections: [], folders: [], teams: [] };
    const props = {
      session: { user: { id: "fixture-owner" } },
      bootstrapOwner: "fixture-owner",
      displayName: "Fixture owner",
      data,
      unified: { agents: [agent], sources: [] },
      composerData: data,
      threadData: data,
      threadSource: { capabilities },
      conversation: "fixture-conversation",
      conversationSource: peer,
      conversationTarget: { agentId: agent.id, title: "Fixture thread" },
      activeAgent: agent,
      selected: agent.id,
      availableAgents: [agent],
      tab: "feed",
      draft: "A message ready to send",
      composerExpanded: true,
      composerUnavailable,
      attachments: [],
      runs: [],
      items: [],
      teamSelection: [],
      scheduleAt: null,
      setDraft: () => {},
      send: async () => {},
    } as unknown as AppViewProps;
    const html = renderToStaticMarkup(renderApp(props));
    const composer = html.match(
      /<div class="composer-body">([\s\S]*?)<div class="composer-actions">/,
    )?.[1];
    expect(composer).toBeDefined();
    const button = composer?.match(
      /<button[^>]*aria-label="Send reply"[^>]*>/,
    )?.[0];
    expect(button).toBeDefined();
    if (mode === "writable") {
      expect(composerUnavailable).toBeUndefined();
      expect(button).not.toContain("disabled");
      expect(composer).not.toContain("This machine");
    } else {
      expect(composerUnavailable).toBeTruthy();
      expect(button).toContain('disabled=""');
      expect(composer).toMatch(/role="status">This machine/);
      expect(composer).toContain(
        mode === "read-only" ? "does not allow" : "unavailable",
      );
    }
  },
);
