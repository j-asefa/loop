import { z } from "zod";

import { LOOP_REPOSITORY } from "./repository.js";
export const Commit = z.string().regex(/^[0-9a-f]{40}$/);
export const BuildIdentity = z.object({
  id: z.string().min(1).max(100),
  repository: z.literal(LOOP_REPOSITORY).nullable(),
  commit: Commit.nullable(),
  clean: z.boolean(),
  builtAt: z.number().int().nonnegative(),
});
export type BuildIdentity = z.infer<typeof BuildIdentity>;
export const BuildStamp = BuildIdentity.extend({
  ancestors: z.array(Commit).max(10000),
  release: z.string().min(1).max(100),
});
export type BuildStamp = z.infer<typeof BuildStamp>;

// Replaced in both browser and server outputs by the build orchestrator.
declare const __LOOP_BUILD__: unknown;
const parsed = BuildStamp.safeParse(
  typeof __LOOP_BUILD__ === "undefined" ? null : __LOOP_BUILD__,
);
export const runningBuild: BuildStamp = Object.freeze(
  parsed.success
    ? parsed.data
    : {
        id: "development",
        repository: null,
        commit: null,
        clean: false,
        builtAt: 0,
        ancestors: [],
        release: "development",
      },
);
export function publicBuild(build: BuildIdentity): BuildIdentity {
  return {
    id: build.id,
    repository: build.repository,
    commit: build.commit,
    clean: build.clean,
    builtAt: build.builtAt,
  };
}
export function browserNeedsReload(
  loaded: BuildIdentity,
  serving: BuildIdentity,
): boolean | null {
  // Source-mode identity cannot establish either a match or a mismatch.
  if (loaded.id === "development" || serving.id === "development") return null;
  return loaded.id !== serving.id;
}
