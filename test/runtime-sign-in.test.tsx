import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { RuntimeSignIn } from "../src/client/RuntimeSignIn";

function render(name: string, label: string) {
  return renderToStaticMarkup(
    <RuntimeSignIn
      base="/runtimes/auth"
      backend="direct"
      location="loop-dev"
      name={name}
      label={label}
      signedIn={false}
      enabled={false}
      enabling={false}
      enableAction={null}
      onStateChange={() => {}}
      onClose={() => {}}
    />,
  );
}

it("asks Pi and OpenCode for a model provider rather than a harness account", () => {
  for (const [name, label] of [["pi", "Pi"], ["opencode", "OpenCode"]]) {
    const html = render(name, label);
    expect(html).toContain(`Connect a model provider for ${label}`);
    expect(html).toContain("API key");
    expect(html).not.toContain(`Sign in to ${label}`);
  }
});

it("keeps account sign-in copy for harnesses that own an account", () => {
  const html = render("codex", "Codex");
  expect(html).toContain("Sign in to Codex");
  expect(html).not.toContain("model provider");
});
