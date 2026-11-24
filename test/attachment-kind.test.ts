import { describe, expect, it } from "vitest";
import {
  attachmentKind,
  attachmentSize,
  attachmentThumbnail,
} from "../src/client/attachmentKind";

describe("attachment tiles", () => {
  it("names a published file's kind", () => {
    expect(attachmentKind("image/png")).toBe("Image");
    expect(attachmentKind("text/html; charset=utf-8")).toBe("Web page");
    expect(attachmentKind("application/pdf")).toBe("PDF");
    expect(attachmentKind("text/plain", "notes.md")).toBe("Markdown");
    expect(attachmentKind("application/json")).toBe("Text");
    expect(attachmentKind("application/zip")).toBe("File");
  });

  it("shows sizes and thumbnails only raster images", () => {
    expect(attachmentSize(512)).toBe("512 B");
    expect(attachmentSize(12_400)).toBe("12 KB");
    expect(attachmentSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(attachmentThumbnail("image/jpeg")).toBe(true);
    // An SVG can carry script and is previewed in its own sandbox instead.
    expect(attachmentThumbnail("image/svg+xml")).toBe(false);
    expect(attachmentThumbnail("text/html")).toBe(false);
  });
});

describe("Loop file addresses", () => {
  it("accepts only artifact files and objects, here or on an agent source", async () => {
    const { isLoopFilePath } = await import("../src/client/loopFilePaths");
    expect(isLoopFilePath("/api/artifacts/a1/file")).toBe(true);
    expect(isLoopFilePath("/api/artifacts/a1/file?version=2")).toBe(true);
    expect(isLoopFilePath("/api/agent-sources/s1/objects/o1")).toBe(true);
    for (const url of [
      "https://tracker.example/x.png",
      "//tracker.example/x.png",
      "/api/artifacts/a1",
      "/api/conversations/c1",
      "data:image/png;base64,AA==",
    ])
      expect(isLoopFilePath(url)).toBe(false);
  });
});
