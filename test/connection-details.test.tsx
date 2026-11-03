import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConnectionDetails } from "../src/client/ConnectionDetails";
import type { Connection } from "../src/shared/types";

function render(metadata: string) {
  return renderToStaticMarkup(
    <ConnectionDetails
      connection={{ metadata, status: "connected" } as Connection}
    />,
  );
}

it("does not infer billing from connection status or incomplete metadata", () => {
  for (const metadata of [
    "invalid",
    "null",
    "[]",
    "{}",
    JSON.stringify({ authMode: "subscription" }),
    JSON.stringify({ billing: " " }),
    JSON.stringify({ billing: { description: "" } }),
  ]) {
    const html = render(metadata);
    expect(html).toContain("Billing not reported");
    expect(html).not.toContain("API-billed");
    expect(html).not.toContain("subscription allowance");
  }
});

it("shows reported billing and location without claiming a live sign-in check", () => {
  const html = render(
    JSON.stringify({
      loopHarness: "codex",
      location: "docker",
      billing: { description: "Existing provider billing" },
    }),
  );
  expect(html).toContain("Docker");
  expect(html).toContain("Existing provider billing");
  expect(html).toContain("not a live sign-in or runtime");
  expect(
    render(JSON.stringify({ loopHarness: "pi", billing: "Existing billing" })),
  ).toContain("This computer");
});

it("shows the computer name for a legacy connection projected from its source", () => {
  const html = renderToStaticMarkup(
    <ConnectionDetails
      connection={
        {
          metadata: JSON.stringify({
            location: "laptop",
            environmentName: "This laptop",
          }),
          status: "connected",
          executionEnvironment: "Office Mac",
        } as Connection & { executionEnvironment: string }
      }
    />,
  );
  expect(html).toContain("Office Mac");
  expect(html).not.toContain("This laptop");
});
