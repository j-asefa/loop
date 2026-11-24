import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CardBody } from "../src/client/ContentCard";
import type { Card } from "../src/shared/cards";

const file = (overrides: Partial<Card["attachments"][number]>) =>
  ({
    id: "a1",
    name: "chart.png",
    mime: "image/png",
    size: 12_400,
    href: "/?artifact=a1",
    download: "/api/artifacts/a1/file",
    availability: "sealed",
    ...overrides,
  }) as Card["attachments"][number];
const render = (attachments: Card["attachments"]) =>
  renderToStaticMarkup(
    <CardBody
      card={
        {
          type: "message",
          content: "Done.",
          attachments,
        } as unknown as Card
      }
      compact
    />,
  );

describe("published file tiles", () => {
  it("shows a thumbnail only for a small image at a Loop file address", () => {
    const html = render([file({})]);
    expect(html).toContain('src="/api/artifacts/a1/file"');
    expect(html).toContain('aria-label="Preview chart.png as published"');
    expect(html).toContain("Image · 12 KB");
    for (const other of [
      file({ download: "https://tracker.example/x.png" }),
      file({ size: 20 * 1024 * 1024 }),
      file({ mime: "image/svg+xml", name: "logo.svg" }),
    ]) {
      const tile = render([other]);
      expect(tile).not.toContain("<img");
      expect(tile).toContain("attachment-tile");
    }
  });

  it("keeps unavailable files as a row without stray text", () => {
    vi.stubGlobal("location", { origin: "http://localhost" });
    const html = render([
      file({ download: null, availability: "unavailable" }),
    ]);
    expect(html).toContain("Published version unavailable");
    expect(html).not.toContain("Never open");
    expect(html).not.toContain("attachment-tile");
    vi.unstubAllGlobals();
  });
});
