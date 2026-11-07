import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImportJobRow } from "../src/client/Workspace";

const job = {
  id: "job-1",
  provider: "openai",
  status: "completed",
  summary: JSON.stringify({
    completed: 1,
    conversations: 1,
    objectId: "object-42",
  }),
};

beforeEach(() => vi.stubGlobal("location", { search: "" }));
afterEach(() => vi.unstubAllGlobals());

const render = () =>
  renderToStaticMarkup(<ImportJobRow job={job} onReload={() => {}} />);

it("downloads the original export from the source that ran the import", () => {
  const id = "d".repeat(64);
  vi.stubGlobal("location", { search: `?source=docker:${id}` });
  expect(render()).toContain(
    `href="/api/agent-sources/docker%3A${id}/objects/object-42"`,
  );
});

it("keeps the plain object path on the local workspace", () => {
  expect(render()).toContain('href="/api/objects/object-42"');
});

it("ignores a malformed source instead of routing to it", () => {
  vi.stubGlobal("location", { search: "?source=not a source id" });
  expect(render()).toContain('href="/api/objects/object-42"');
});
