import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export function gitProject(directory: string) {
  const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
  git("init");
  writeFileSync(join(directory, "tracked.txt"), "committed");
  git("add", "tracked.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "initial");
  return git;
}
