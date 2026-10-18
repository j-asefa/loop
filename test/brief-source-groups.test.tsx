import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BriefSourceGroups } from "../src/client/BriefSourceGroups";
import type { BriefSource } from "../src/shared/briefs";

it("shows one conversation heading for distinct records and preserves their exact destinations", () => {
  const base: BriefSource = {
    ref: "request",
    kind: "message",
    owner_message: true,
    title: "Why do agents show the same diff?",
    conversation: "thread",
    message: "request",
    artifact: null,
    at: 0,
    excerpt: "Original request",
  };
  const sources = {
    request: base,
    response: {
      ...base,
      ref: "response",
      kind: "result" as const,
      owner_message: false,
      message: "answer",
      excerpt: "Agent answer",
    },
    changes: {
      ...base,
      ref: "changes",
      kind: "checkout" as const,
      owner_message: false,
      run: "run",
      message: "answer",
      excerpt: "Changed files",
    },
  };
  const html = renderToStaticMarkup(
    <BriefSourceGroups
      cites={["request", "response", "changes", "request"].map((ref) => ({
        ref,
      }))}
      sources={sources}
      workspace="docker:one"
      readable={(s) => s}
    />,
  );
  expect(html.match(/<h4>/g)).toHaveLength(1);
  expect(html.match(/<article/g)).toHaveLength(3);
  for (const text of [
    base.title,
    "Your request",
    "Agent’s response",
    "Recorded changes",
    "Original request",
    "Agent answer",
    "Changed files",
  ])
    expect(html).toContain(text);
  for (const destination of [
    "message=request",
    "message=answer",
    "message=answer&amp;checkout=run",
  ])
    expect(html).toContain(
      `source=docker%3Aone&amp;conversation=thread&amp;${destination}`,
    );
  expect(html).toContain('dateTime="1970-01-01T00:00:00.000Z"');
});

it("keeps same-named conversations and standalone artifacts separate, with missing sources visible", () => {
  const base: BriefSource = {
    ref: "a",
    title: "Same title",
    conversation: "a",
    message: null,
    artifact: null,
    at: null,
    excerpt: "Source",
  };
  const html = renderToStaticMarkup(
    <BriefSourceGroups
      cites={["a", "b", "file", "missing"].map((ref) => ({ ref }))}
      sources={{
        a: base,
        b: { ...base, ref: "b", conversation: "b" },
        file: { ...base, ref: "file", conversation: null, artifact: "file" },
      }}
      workspace=""
      readable={(s) => s}
    />,
  );
  expect(html.match(/<h4>Same title/g)).toHaveLength(3);
  expect(html).toContain("conversation=a");
  expect(html).toContain("conversation=b");
  expect(html).toContain("artifact=file");
  expect(html).toContain("Open source thread");
  expect(html).toContain("Open published result");
  expect(html).toContain("This source is no longer available in this project.");
  expect(html).not.toContain("<time");
  expect(html).not.toContain("Your request");
});
