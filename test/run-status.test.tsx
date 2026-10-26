import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { RunStatus } from "../src/client/RunStatus";

it("does not promise missing failure details for older generic errors", () => {
  const html = renderToStaticMarkup(
    <RunStatus
      state="failed"
      empty
      error="The run stopped during agent (Error). Open failure details to inspect the saved progress."
    />,
  );
  expect(html).toContain("A specific cause was not recorded");
  expect(html).toContain("Review any saved progress before retrying");
  expect(html).not.toMatch(/Open failure details|during agent|Check Traces/);
});

it("shows startup cause and recovery guidance without adding a contradictory progress hint", () => {
  const error =
    "Codex did not respond within 30 seconds while reopening this conversation. No prompt was sent. Retry when the execution host is less busy.";
  const html = renderToStaticMarkup(
    <RunStatus state="failed" empty error={error} />,
  );
  expect(html).toContain(error);
  expect(html).not.toContain("No final answer was saved");
});
