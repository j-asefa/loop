import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  piInstructionSources,
  piPackageEntries,
  piProjectResources,
  piSavedTrust,
  settingsHash,
  updatePiPackageFilters,
} from "../src/server/pi-customization-files";
import { expandPiPrompt, piPromptBody } from "../src/server/pi-prompt-preview";
import { piErrorLine, runPi } from "../src/server/pi-run";
import {
  inspectPiPackage,
  previousPiPackageSource,
} from "../src/server/pi-package-inspect";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loop55-pi-custom-"));
  roots.push(root);
  const agent = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(agent);
  mkdirSync(join(project, ".pi"), { recursive: true });
  return { agent, project };
}

it("separates configured package filters from loaded state and rejects stale edits", () => {
  const { agent, project } = fixture();
  const path = join(agent, "settings.json");
  writeFileSync(
    path,
    JSON.stringify({
      theme: "dark",
      packages: ["npm:example", { source: "git:example", skills: [] }],
    }),
  );
  expect(piPackageEntries(agent, project)).toEqual([
    { source: "npm:example", scope: "user", filters: {} },
    { source: "git:example", scope: "user", filters: { skills: [] } },
  ]);
  const hash = settingsHash(path);
  updatePiPackageFilters(
    path,
    "npm:example",
    { extensions: [], prompts: ["prompts/review.md"] },
    hash,
  );
  const changed = JSON.parse(readFileSync(path, "utf8"));
  expect(changed.theme).toBe("dark");
  expect(changed.packages[0]).toEqual({
    source: "npm:example",
    extensions: [],
    prompts: ["prompts/review.md"],
  });
  expect(() => updatePiPackageFilters(path, "npm:example", {}, hash)).toThrow(
    /changed/,
  );
});

it("shows project trust resources and effective instruction origins", () => {
  const { agent, project } = fixture();
  writeFileSync(join(agent, "SYSTEM.md"), "personal");
  writeFileSync(join(project, ".pi", "SYSTEM.md"), "project");
  writeFileSync(join(project, "AGENTS.md"), "context");
  const resources = piProjectResources(project);
  expect(resources.paths.map((item) => item.path)).toContain(
    join(project, ".pi", "SYSTEM.md"),
  );
  expect(
    piInstructionSources(agent, project, false)
      .filter((item) => item.effective)
      .map((item) => item.path),
  ).toEqual([join(agent, "SYSTEM.md"), join(project, "AGENTS.md")]);
  expect(
    piInstructionSources(agent, project, true)
      .filter((item) => item.effective)
      .map((item) => item.path),
  ).toEqual([join(project, ".pi", "SYSTEM.md"), join(project, "AGENTS.md")]);
});

it("asks for trust again after any change below a trusted resource", () => {
  const { project } = fixture();
  const tools = join(project, ".pi", "extensions", "tools");
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, "index.ts"), "export default 1;");
  const print = () => piProjectResources(project).fingerprint;
  const trusted = print();
  expect(print()).toBe(trusted);
  // Editing a nested file (same size, later time) is a change.
  writeFileSync(join(tools, "index.ts"), "export default 2;");
  const later = new Date(Date.now() + 5000);
  utimesSync(join(tools, "index.ts"), later, later);
  const edited = print();
  expect(edited).not.toBe(trusted);
  // So is adding one.
  writeFileSync(join(tools, "extra.ts"), "export {};");
  const added = print();
  expect(added).not.toBe(edited);
  // A symlinked skills folder is fingerprinted by what it points at.
  const shared = join(project, "..", "shared-skills");
  mkdirSync(join(shared, "review"), { recursive: true });
  writeFileSync(join(shared, "review", "SKILL.md"), "v1");
  symlinkSync(shared, join(project, ".pi", "skills"));
  const linked = print();
  writeFileSync(join(shared, "review", "SKILL.md"), "v2 with more text");
  expect(print()).not.toBe(linked);
  // A symlink loop finishes.
  symlinkSync("..", join(shared, "review", "loop55"));
  expect(print()).toMatch(/^[a-f0-9]{64}$/);
});

it("recognizes an existing Pi trust decision inherited from a parent", () => {
  const { agent, project } = fixture();
  const parent = join(project, "..");
  writeFileSync(join(agent, "trust.json"), JSON.stringify({ [parent]: true }));
  expect(piSavedTrust(agent, project)).toEqual({
    trusted: true,
    decision: "trusted in Pi",
  });
  writeFileSync(join(agent, "trust.json"), "{}");
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({ defaultProjectTrust: "never" }),
  );
  expect(piSavedTrust(agent, project)).toEqual({
    trusted: false,
    decision: "declined by Pi default",
  });
});

it("previews Pi positional defaults, quoted arguments and slices", () => {
  const body = piPromptBody(
    "---\ndescription: Review\n---\nFocus ${1:-correctness}; rest ${@:2}; all $ARGUMENTS; second $2",
  );
  expect(expandPiPrompt(body, '"API compatibility" security')).toBe(
    "Focus API compatibility; rest security; all API compatibility security; second security",
  );
  expect(expandPiPrompt("${1:-safe} $@", "")).toBe("safe ");
});

it("reads prompt bodies the way Pi's extractFrontmatter does", () => {
  expect(piPromptBody("\uFEFF---\ndescription: x\n---\nBody")).toBe("Body");
  expect(piPromptBody("---\ndescription: x\n---")).toBe("");
  expect(
    piPromptBody(
      "---\r\ndescription: x\r\n---\r\n\r\nLine one\r\nLine two\r\n",
    ),
  ).toBe("Line one\nLine two");
  expect(piPromptBody("No frontmatter\r\n")).toBe("No frontmatter\n");
});

it("runs Pi package commands past a large output and reports Pi's error line", async () => {
  const noisy = `process.stdout.write("x".repeat(65536)); process.stderr.write("w".repeat(65536) + "\\n");`;
  await expect(
    runPi(process.execPath, ["-e", noisy], { cwd: tmpdir() }),
  ).resolves.toBeUndefined();
  await expect(
    runPi(
      process.execPath,
      [
        "-e",
        `console.error("npm warn deprecated"); console.error("Error: Path does not exist: /p/foo"); process.exit(1)`,
      ],
      { cwd: tmpdir() },
    ),
  ).rejects.toThrow("Error: Path does not exist: /p/foo");
  expect(
    piErrorLine("Error: clone https://user:token@example.com/r.git failed"),
  ).toBe("Error: clone https://example.com/r.git failed");
});

it("inspects a local package without executing it and records an npm recovery pin", async () => {
  const { agent, project } = fixture();
  const local = join(project, ".pi", "review");
  mkdirSync(join(local, "prompts"), { recursive: true });
  writeFileSync(
    join(local, "package.json"),
    JSON.stringify({ name: "review", pi: { prompts: ["prompts/review.md"] } }),
  );
  writeFileSync(join(local, "prompts", "review.md"), "Review");
  const inspected = await inspectPiPackage("./review", project);
  expect(inspected.inspected).toBe(true);
  expect(inspected.resources.prompts).toEqual(["prompts/review.md"]);
  const installed = join(agent, "npm", "node_modules", "review");
  mkdirSync(installed, { recursive: true });
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({ version: "1.2.3" }),
  );
  expect(previousPiPackageSource("npm:review", "user", agent, project)).toBe(
    "npm:review@1.2.3",
  );
});
