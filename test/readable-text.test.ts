import { expect, it } from "vitest";
import {
  createReadableText,
  readableAuthor,
  readableText,
} from "../src/shared/readable-text";

const agent = "3dd35f59-14de-44cb-9914-d991edfc28ce";
const thread = "2c20ef58-0ba2-4ef6-b87c-a74e724432f5";

it("resolves names only from the supplied workspace, including mentions and code spans", () => {
  const local = createReadableText([{ id: agent, name: "forest" }]);
  const linked = createReadableText([{ id: agent, name: "venus" }]);
  const text = `Ask @${agent} to finish the review with \`${agent}\`.`;
  expect(local(text)).toBe("Ask @forest to finish the review with @forest.");
  expect(linked(text)).toBe("Ask @venus to finish the review with @venus.");
  expect(createReadableText()(text)).not.toContain(agent);
  expect(readableAuthor(agent, [{ id: agent, name: "forest" }])).toBe(
    "@forest",
  );
  expect(readableAuthor(thread)).toBe("an agent");
  expect(readableAuthor("owner")).toBe("you");
  expect(readableAuthor("octocat")).toBe("octocat");
});

it("describes internal references without exposing their tokens", () => {
  const text = `Agent ${agent} reviewed thread \`${thread}\`, snapshot ${thread}, res_${thread}, loop/agent-${"ab12".repeat(16)}, /repo/.git/loop-agent-worktrees/${"cd34".repeat(16)} at c96cd311.`;
  const display = readableText(text);
  for (const token of [
    agent,
    thread,
    "res_",
    "loop/agent-",
    "loop-agent-worktrees",
    "c96cd311",
  ])
    expect(display).not.toContain(token);
  expect(display).toContain("the conversation");
  expect(display).toContain("the agent’s workspace");
  expect(readableText(display)).toBe(display);
});

it("removes data URLs and long or line-wrapped encoded payloads while retaining the surrounding summary", () => {
  const payload = Buffer.from(
    "a binary attachment repeated many times ".repeat(3000),
  ).toString("base64");
  const wrapped = payload.match(/.{1,64}/g)!.join("\n");
  for (const data of [payload, wrapped, `data:image/png;base64,${payload}`]) {
    const display = readableText(
      `Review the attached screenshot: ${data}\nThen confirm the layout.`,
    );
    expect(display).toContain("Review the attached screenshot:");
    expect(display).toContain("Then confirm the layout.");
    expect(display).not.toContain(payload.slice(0, 40));
    expect(display.length).toBeLessThan(120);
  }
});

it("preserves human descriptions, product names, short numbers, paths and ordinary links", () => {
  const text =
    "Ask @forest to check src/client/ProjectBrief.tsx on feature/readable-briefs. Use GPT-5.4, keep 2026-10-16 and 140 characters, then open https://example.com/docs/briefs.";
  expect(readableText(text)).toBe(text);
});
