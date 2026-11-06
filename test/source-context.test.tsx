import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import {
  SourceProvider,
  useSourceCapabilities,
  useSourcePath,
  useSourceRoute,
} from "../src/client/SourceContext";
import { workspaceCapabilities } from "../src/shared/capabilities";
import { workspaceApi } from "../src/shared/workspace-api";
import {
  routeSourceId,
  setShellSource,
  executionSourceId,
  initializeShellSource,
} from "../src/client/sourceRouting";
import { loopFileUrl } from "../src/client/FilePreview";
import { RichText } from "../src/client/components";
import { PublishedFile } from "../src/client/PublishedFiles";
import { PersonalDecisions } from "../src/client/PersonalDecisions";

const server = { ...workspaceCapabilities(), pairedDevices: false };
afterEach(() => {
  setShellSource("");
  vi.unstubAllGlobals();
});

it.each(["approval", "answer"] as const)(
  "explains unavailable %s history on an older connected source",
  (kind) => {
    const html = renderToStaticMarkup(
      <SourceProvider
        sourceId="docker:older"
        capabilities={{ ...server, personalDecisions: undefined }}
      >
        <PersonalDecisions kind={kind} onConversation={() => {}} />
      </SourceProvider>,
    );
    expect(html).toContain("Decision history unavailable");
    expect(html).toContain("Update Loop on that workspace");
    expect(html).not.toContain("Loading history");
  },
);

it("binds conversation actions and file URLs to their source across later navigation", async () => {
  vi.stubGlobal("location", {
    search: "",
    href: "https://loop.test/",
    origin: "https://loop.test",
  });
  setShellSource("");
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => ({
    ok: true,
    redirected: false,
    json: async () =>
      _path.includes("/native/decisions/")
        ? { state: "resolved" }
        : _path.includes("/connections/")
          ? { models: [] }
          : { ok: true },
  }));
  vi.stubGlobal("fetch", fetch);
  let typed!: ReturnType<typeof useSourceRoute>;
  function Controls() {
    typed = useSourceRoute();
    const path = useSourcePath();
    const capabilities = useSourceCapabilities();
    return (
      <a href={path("/api/artifacts/same/file")}>
        {String(capabilities.pairedDevices)}
      </a>
    );
  }
  const html = renderToStaticMarkup(
    <SourceProvider sourceId="docker:alpha" capabilities={server}>
      <Controls />
    </SourceProvider>,
  );
  const remoteTypedAction = typed;
  expect(html).toContain(
    "/api/agent-sources/docker%3Aalpha/artifacts/same/file",
  );
  renderToStaticMarkup(
    <SourceProvider sourceId="docker:beta" capabilities={server}>
      <Controls />
    </SourceProvider>,
  );
  vi.stubGlobal("location", {
    search: "?source=docker:beta",
    href: "https://loop.test/?source=docker:beta",
  });
  await remoteTypedAction(workspaceApi.runAction, {
    params: { id: "same", action: "cancel" },
    body: {},
  });
  expect(fetch.mock.calls[0][0]).toBe(
    "/api/agent-sources/docker%3Aalpha/runs/same/cancel",
  );
  await typed(workspaceApi.connectionRefresh, {
    params: { id: "same" },
    body: { generation: 4, decision: "approve" },
  });
  expect(fetch.mock.calls[1][0]).toBe(
    "/api/agent-sources/docker%3Abeta/connections/same/refresh",
  );
  const input = {
    params: { id: "same" },
    body: {
      commandId: "f7719a2b-dea1-4c80-8c5f-de7c503cab12",
      answer: { choice: "allow" },
    },
  };
  await remoteTypedAction(workspaceApi.nativeAnswer, input);
  await typed(workspaceApi.nativeAnswer, input);
  expect(fetch.mock.calls.slice(2).map((call) => call[0])).toEqual([
    "/api/agent-sources/docker%3Aalpha/native/decisions/same",
    "/api/agent-sources/docker%3Abeta/native/decisions/same",
  ]);
  expect(executionSourceId()).toBe("");
  expect(routeSourceId()).toBe("docker:beta");
});

it("scopes transcript download links without rewriting external links", () => {
  vi.stubGlobal("location", {
    search: "",
    href: "https://loop.test/",
    origin: "https://loop.test",
  });
  const html = renderToStaticMarkup(
    <SourceProvider sourceId="docker:alpha" capabilities={server}>
      <RichText content="[File](/api/objects/same) [External](https://example.com/page)" />
    </SourceProvider>,
  );
  expect(html).toContain(
    'href="/api/agent-sources/docker%3Aalpha/objects/same"',
  );
  expect(html).toContain('href="https://example.com/page"');
});

it("keeps thread file summaries download-free while retaining source-scoped previews elsewhere", () => {
  const item = {
    id: "image-file",
    title: "Design",
    metadata: JSON.stringify({
      name: "design.png",
      mime: "image/png",
      size: 5_000_000,
    }),
  };
  const render = (previewImages?: boolean) =>
    renderToStaticMarkup(
      <SourceProvider sourceId="docker:alpha" capabilities={server}>
        <PublishedFile
          item={item}
          preview={false}
          previewImages={previewImages}
        />
      </SourceProvider>,
    );
  const summary = render(false);
  expect(summary).toContain('aria-label="Preview design.png"');
  expect(summary).toContain("4.8 MB");
  expect(summary).not.toContain("<img");
  expect(summary).not.toContain("src=");
  expect(render()).toContain(
    'src="/api/agent-sources/docker%3Aalpha/artifacts/image-file/file?preview=1"',
  );
});

it("recognizes source-qualified files for sandboxed HTML previews", () => {
  vi.stubGlobal("location", {
    href: "https://loop.test/",
    origin: "https://loop.test",
  });
  expect(
    loopFileUrl(
      "/api/agent-sources/docker%3Aalpha/objects/report?preview=html",
    ),
  ).toBe("/api/agent-sources/docker%3Aalpha/objects/report?preview=html");
  expect(
    loopFileUrl("https://elsewhere.test/api/objects/report"),
  ).toBeUndefined();
});

it.each(["", "docker:alpha"])(
  "rebases a source-qualified Markdown file into its thread source %s",
  (source) => {
    vi.stubGlobal("location", {
      href: "https://loop.test/",
      origin: "https://loop.test",
    });
    const html = renderToStaticMarkup(
      <SourceProvider sourceId={source} capabilities={server}>
        <RichText content="[File](/api/agent-sources/docker%3Aother/objects/same)" />
      </SourceProvider>,
    );
    expect(html).not.toContain("docker%3Aother");
    expect(html).toContain(
      source
        ? "/api/agent-sources/docker%3Aalpha/objects/same"
        : 'href="/api/objects/same"',
    );
  },
);

it("restores the shell source on reload while keeping fresh thread links local", () => {
  vi.stubGlobal("location", { search: "?source=docker:alpha" });
  const history = {
    state: null as any,
    replaceState(state: any) {
      this.state = state;
    },
  };
  vi.stubGlobal("history", history);
  initializeShellSource();
  expect(executionSourceId()).toBe("docker:alpha");
  vi.stubGlobal("location", {
    search: "?source=docker:beta&conversation=thread",
  });
  initializeShellSource();
  expect(executionSourceId()).toBe("docker:alpha");
  history.state = null;
  initializeShellSource();
  expect(executionSourceId()).toBe("");
});
