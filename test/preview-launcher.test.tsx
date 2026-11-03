import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { previewEnvironment } from "../src/preview-cli";
import { PreviewBanner } from "../src/client/PreviewBanner";

it("removes inherited production state, services, Git overrides and fixture switches from production previews", () => {
  const inherited = {
    HOME: "/home/person",
    PATH: "/bin",
    HTTPS_PROXY: "https://proxy.example",
    NODE_ENV: "production",
    LOOP_HOME: "/live",
    LOOP_DATA_DIR: "/live/workspace",
    LOOP_ENCRYPTION_KEY: "live-key",
    LOOP_CONNECTION_DIR: "/live/connection",
    LOOP_CONNECTION_MANAGED: "external",
    LOOP_SERVICE: "systemd",
    LOOP_RUNTIME_URL: "https://runtime.example",
    LOOP_TEST_CLOUDFLARED: "/fixture",
    BETTER_AUTH_SECRET: "live-auth",
    GIT_WORK_TREE: "/live/checkout",
    NODE_OPTIONS: "--require=/live/preload.cjs",
    PORT: "3000",
    OPENAI_API_KEY: "live-api-key",
  };
  const design = previewEnvironment(inherited, "design");
  expect(design).toEqual({
    HOME: inherited.HOME,
    PATH: inherited.PATH,
    HTTPS_PROXY: inherited.HTTPS_PROXY,
    NODE_ENV: "production",
  });
  expect(previewEnvironment(inherited, "working").OPENAI_API_KEY).toBe(
    "live-api-key",
  );
});

it("labels previews without putting build details or implementation language in the main message", () => {
  expect(renderToStaticMarkup(<PreviewBanner />)).toBe("");
  const html = renderToStaticMarkup(
    <PreviewBanner
      preview={{
        name: "posts",
        mode: "design",
        build: {
          id: "build-1234",
          branch: "preview/posts",
          commit: "a".repeat(40),
          dirty: true,
          builtAt: "2026-10-19T07:00:00Z",
          sourceHash: "b".repeat(64),
          artifactHash: "c".repeat(64),
        },
      }}
    />,
  );
  expect(html).toContain("Preview · posts");
  expect(html).toContain("Sample data · Simulated replies");
  expect(html).toContain("<details>");
  expect(html).toContain("Includes local edits");
  expect(html).not.toContain("b".repeat(64));
});
