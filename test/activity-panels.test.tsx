import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PlanPanel,
  FileChangePanel,
  CommandOutputPanel,
} from "../src/client/ActivityPanels";

describe("shared activity panels", () => {
  it("escapes hostile paths, commands, plans and output without generating links", () => {
    const attack = '<img src=x onerror="alert(1)">';
    const html = renderToStaticMarkup(
      <>
        <PlanPanel steps={[{ id: "a", text: attack, status: "pending" }]} />
        <FileChangePanel path={attack} patch={"+" + attack} state="proposed" />
        <CommandOutputPanel command={attack} text={attack} state="running" />
      </>,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).toContain("&lt;img");
    expect(html).toContain('tabindex="0"');
  });
  it("labels absent vs empty file content and reported execution state", () => {
    const html = renderToStaticMarkup(
      <FileChangePanel path="empty" before={null} after="" state="proposed" />,
    );
    expect(html).toContain("new file");
    expect(html).toContain("proposed");
    expect(html).not.toContain("Diff content was not supplied");
  });
  it("bounds command rendering and does not invent an exit code", () => {
    const html = renderToStaticMarkup(
      <CommandOutputPanel
        text={"x".repeat(100000) + "THE TAIL"}
        state="completed"
      />,
    );
    expect(html.length).toBeLessThan(50000);
    expect(html).toContain("THE TAIL");
    expect(html).toContain("Output truncated");
    expect(html).toContain("Exit code not supplied");
  });
  it("distinguishes a zero exit code from absent or null status", () => {
    expect(
      renderToStaticMarkup(
        <CommandOutputPanel text="ok" state="completed" exitCode={0} />,
      ),
    ).toContain("Exit code: 0");
  });
});
