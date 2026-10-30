import { describe, expect, it } from "vitest";
import {
  isRepoPath,
  repoFileKind,
  repoMediaType,
  resolveRepoPath,
} from "../src/shared/pull-requests";

describe("viewing repository files", () => {
  it("chooses how to show a file by its name", () => {
    expect(repoFileKind("README.md")).toBe("markdown");
    expect(repoFileKind("docs/Guide.MARKDOWN")).toBe("markdown");
    expect(repoFileKind("docs/media/loop55-demo.gif")).toBe("image");
    expect(repoFileKind("docs/media/loop55-demo.mp4")).toBe("video");
    expect(repoFileKind("src/app.ts")).toBe("text");
    expect(repoFileKind("Makefile")).toBe("text");
    expect(repoFileKind("site/index.html")).toBe("text");
    expect(repoMediaType("a/b.svg")).toBe("image/svg+xml");
    expect(repoMediaType("a.svg/readme")).toBeUndefined();
    expect(repoMediaType("page.html")).toBeUndefined();
  });

  it("resolves links the way GitHub does, inside the repository only", () => {
    expect(resolveRepoPath("README.md", "docs/media/demo.gif")).toEqual({
      path: "docs/media/demo.gif",
    });
    expect(
      resolveRepoPath("docs/guide/setup.md", "../media/a%20b.png"),
    ).toEqual({
      path: "docs/media/a b.png",
    });
    expect(resolveRepoPath("docs/guide/setup.md", "./next.md#install")).toEqual(
      {
        path: "docs/guide/next.md",
        hash: "install",
      },
    );
    expect(
      resolveRepoPath("docs/guide/setup.md", "/README.md?plain=1"),
    ).toEqual({
      path: "README.md",
    });
    expect(resolveRepoPath("docs/setup.md", "#usage")).toEqual({
      path: "docs/setup.md",
      hash: "usage",
    });
    for (const outside of [
      "https://example.com/a.png",
      "//example.com/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "mailto:a@example.com",
      "../../escape.md",
      "%E0%A4%A",
      "",
    ])
      expect(resolveRepoPath("docs/setup.md", outside)).toBeUndefined();
  });

  it("accepts only plain relative paths", () => {
    expect(isRepoPath("docs/media/demo.gif")).toBe(true);
    for (const path of [
      "",
      "/abs",
      "a//b",
      "a/./b",
      "a/../b",
      "a\\b",
      "a\nb",
      "x".repeat(1001),
    ])
      expect(isRepoPath(path)).toBe(false);
  });
});
