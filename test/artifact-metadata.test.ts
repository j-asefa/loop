import { expect, it } from "vitest";
import { ArtifactRoles } from "../src/shared/artifact-role";
import {
  ArtifactMetadataSchemas,
  readArtifactMetadata,
  writeArtifactMetadata,
  artifactMessageId,
  artifactDisplayMetadata,
  type ArtifactMetadata,
} from "../src/shared/artifact-metadata";

const examples = [
  {
    role: "answer",
    metadata: {
      messageId: "message",
      model: "model",
      provider: "openai",
      source: {
        url: "https://example.com",
        title: "Source",
        excerpt: "Excerpt",
      },
    },
  },
  {
    role: "trace",
    metadata: {
      tool: "read",
      connectionId: "connection",
      arguments: { query: "fixture" },
      toolResult: { content: [] },
      messageId: "trace-message",
    },
  },
  {
    role: "file",
    metadata: {
      uploaded: true,
      name: "note.txt",
      mime: "text/plain",
      size: 2,
      provider: "codex",
    },
  },
  { role: "upload", metadata: { upload: true, objectId: "object", size: 0 } },
  {
    role: "import",
    metadata: { origin: "import", provider: "anthropic", rawObjectId: "raw" },
  },
  { role: "snippet", metadata: { snippet: true, edited: true } },
] satisfies ArtifactMetadata[];

it.each(examples)(
  "round-trips $role metadata as text without adding a discriminator to storage",
  (value) => {
    const text = writeArtifactMetadata(value);
    expect(typeof text).toBe("string");
    expect(JSON.parse(text)).toEqual(value.metadata);
    expect(readArtifactMetadata(value.role, text)).toEqual(value);
  },
);
it.each(ArtifactRoles)(
  "rejects undeclared $s fields and safely falls back for client reads",
  (role) => {
    expect(
      ArtifactMetadataSchemas[role].safeParse({ accidentalField: true })
        .success,
    ).toBe(false);
    for (const malformed of [
      "not JSON",
      "null",
      "[]",
      '{"accidentalField":true}',
      '{"edited":"yes"}',
    ]) {
      expect(() => readArtifactMetadata(role, malformed)).toThrow();
      expect(readArtifactMetadata(role, malformed, "fallback")).toEqual({
        role,
        metadata: {},
      });
    }
    expect(readArtifactMetadata(role, writeArtifactMetadata({ role }))).toEqual(
      { role, metadata: {} },
    );
  },
);
it("rejects unknown owned provider and origin values", () => {
  expect(
    ArtifactMetadataSchemas.file.safeParse({ provider: "unknown" }).success,
  ).toBe(false);
  expect(
    ArtifactMetadataSchemas.import.safeParse({ provider: "codex" }).success,
  ).toBe(false);
  expect(
    ArtifactMetadataSchemas.import.safeParse({ origin: "unknown" }).success,
  ).toBe(false);
});
it("keeps role-specific fields correlated at the write boundary", () => {
  expect(() =>
    // @ts-expect-error Snippet metadata cannot be written as a trace.
    writeArtifactMetadata({ role: "trace", metadata: { snippet: true } }),
  ).toThrow();
});
it("projects only display fields belonging to each role", () => {
  expect(artifactMessageId(examples[0])).toBe("message");
  expect(artifactMessageId(examples[1])).toBe("trace-message");
  expect(artifactMessageId(examples[2])).toBeUndefined();
  expect(artifactDisplayMetadata(examples[1])).toMatchObject({
    tool: "read",
    connectionId: "connection",
    arguments: { query: "fixture" },
  });
  expect(artifactDisplayMetadata(examples[2])).toMatchObject({
    name: "note.txt",
    mime: "text/plain",
    size: 2,
    provider: "codex",
  });
});
