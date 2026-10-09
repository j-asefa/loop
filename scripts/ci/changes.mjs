import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const jobs = ["code", "containers", "companion", "native", "service"];
const all = () => Object.fromEntries(jobs.map((name) => [name, true]));
// Exclusions, not a list of every sensitive path: new/unknown inputs run all jobs.
// These paths contain presentation or standalone test code, not shipped native
// or service inputs. Server/shared/root modules deliberately fall through.
export function classify(paths) {
  const selected = Object.fromEntries(jobs.map((name) => [name, false]));
  for (const path of paths) {
    if (/\.md$/.test(path)) continue;
    selected.code = true;
    if (/^src\/client\//.test(path)) continue;
    if (/^test\//.test(path)) {
      // Root tests always run. Test helpers may also drive deployment smokes.
      if (!/^test\/[^/]+\.(?:node\.)?test\.[cm]?[jt]sx?$/.test(path))
        return all();
      continue;
    }
    if (/^scripts\/helpers\//.test(path)) return all();
    // Deployment-only definitions have bounded consumers. Their shared source
    // still falls through to full coverage, including newly introduced imports.
    const targets = {
      Dockerfile: ["containers"],
      "Dockerfile.runtime": ["containers"],
      "Dockerfile.runtime-broker": ["containers"],
      "Dockerfile.mcp": ["containers"],
      "compose.yaml": ["containers"],
      "Dockerfile.companion": ["companion"],
      "Dockerfile.connection": ["companion", "service"],
      "compose.companion.yaml": ["companion"],
      "scripts/compose-smoke.mjs": ["containers"],
      "scripts/compose-companion-smoke.mjs": ["companion"],
      "scripts/service-lifecycle-smoke.mjs": ["service"],
      "scripts/native-transport-smoke.mjs": ["native"],
    };
    if (targets[path]) {
      for (const name of targets[path]) selected[name] = true;
      continue;
    }
    // Runtime files are shared by native/companion provisioning; default all.
    return all();
  }
  return selected;
}

export function changedPaths(base, head = "HEAD", cwd = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(base))
    throw new Error("Expected a full base commit SHA");
  // --no-renames yields both deleted and added names, including cross-boundary
  // moves. NUL delimiters preserve whitespace/newlines. Triple-dot covers the PR.
  return execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"],
    { cwd, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
}
export function selection(eventName, event, diff = changedPaths) {
  if (eventName !== "pull_request") return all();
  try {
    return classify(diff(event.pull_request.base.sha));
  } catch (error) {
    console.error(
      `Cannot safely classify changes; running all checks: ${error.message}`,
    );
    return all();
  }
}
export function browserImage(lock) {
  const version = lock.packages?.["node_modules/playwright-core"]?.version;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ""))
    throw new Error("Expected a stable locked Playwright version");
  for (const name of ["playwright", "@playwright/test"]) {
    if (lock.packages?.[`node_modules/${name}`]?.version !== version)
      throw new Error("Playwright versions must match");
  }
  return `mcr.microsoft.com/playwright:v${version}-noble`;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const selected = selection(process.env.GITHUB_EVENT_NAME, event);
  const output = {
    ...selected,
    browser_image: browserImage(
      JSON.parse(readFileSync("package-lock.json", "utf8")),
    ),
  };
  for (const [key, value] of Object.entries(output)) {
    console.log(`${key}=${value}`);
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}
