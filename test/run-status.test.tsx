import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { RunStatus } from "../src/client/RunStatus";

it("shows startup cause and recovery guidance without adding a contradictory progress hint", () => {
  const error =
    "Codex did not respond within 30 seconds while reopening this conversation. No prompt was sent. Retry when the execution host is less busy.";
  const html = renderToStaticMarkup(
    <RunStatus state="failed" empty error={error} />,
  );
  expect(html).toContain(error);
  expect(html).not.toContain("No final answer was saved");
});
