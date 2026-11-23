import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentPicker,
  agentMatches,
  sortAgentsByName,
} from "../src/client/AgentPicker";

describe("agent pickers", () => {
  it("orders agents by name, ignoring case and accents", () => {
    const agents = [
      { id: "4", name: "willow" },
      { id: "3", name: "Acorn" },
      { id: "2", name: "élan" },
      { id: "1", name: "agent10" },
      { id: "5", name: "agent9" },
      { id: "6", name: "birch" },
    ];
    expect(sortAgentsByName(agents).map((agent) => agent.name)).toEqual([
      "Acorn",
      "agent9",
      "agent10",
      "birch",
      "élan",
      "willow",
    ]);
    // The input order is left alone for callers that still need it.
    expect(agents[0].name).toBe("willow");
  });

  it("matches a typed name or detail with or without @", () => {
    expect(agentMatches("", { name: "Acorn" })).toBe(true);
    expect(agentMatches("@ACO", { name: "Acorn" })).toBe(true);
    expect(agentMatches(" opus ", { name: "Acorn", detail: "Opus 5.5" })).toBe(
      true,
    );
    expect(agentMatches("birch", { name: "Acorn", detail: "Opus" })).toBe(
      false,
    );
  });

  it("shows the chosen agent, an extra or the placeholder on the trigger", () => {
    const render = (value: string) =>
      renderToStaticMarkup(
        <AgentPicker
          label="Agent recipient"
          value={value}
          onChange={() => {}}
          extras={[{ value: "__route__", label: "Let Loop choose" }]}
          agents={[{ value: "a", name: "Acorn", detail: "Opus" }]}
        />,
      );
    expect(render("a")).toContain("@Acorn · Opus");
    expect(render("a")).toContain('aria-label="Agent recipient"');
    expect(render("a")).toContain('value="a"');
    expect(render("__route__")).toContain("Let Loop choose");
    expect(render("")).toContain("Choose an agent");
  });
});
