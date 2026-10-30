import { z } from "zod";

export const LOOP55_REPOSITORY = "github.com/j-asefa/loop";
export const Commit = z.string().regex(/^[0-9a-f]{40}$/);
export const BuildIdentity = z.object({
  id: z.string().min(1).max(100),
  repository: z.literal(LOOP55_REPOSITORY).nullable(),
  commit: Commit.nullable(),
  clean: z.boolean(),
  builtAt: z.number().int().nonnegative(),
});
export type BuildIdentity = z.infer<typeof BuildIdentity>;
export const BuildStamp = BuildIdentity.extend({
  ancestors: z.array(Commit).max(10000),
});
export type BuildStamp = z.infer<typeof BuildStamp>;

// Replaced in both browser and server outputs by the build orchestrator.
declare const __LOOP55_BUILD__: unknown;
const parsed = BuildStamp.safeParse(
  typeof __LOOP55_BUILD__ === "undefined" ? null : __LOOP55_BUILD__,
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
export function loop55Repository(url: string): typeof LOOP55_REPOSITORY | null {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)j-asefa\/loop(?:\.git)?\/?$/i.test(
    url.trim(),
  )
    ? LOOP55_REPOSITORY
    : null;
}
export function browserNeedsReload(
  loaded: BuildIdentity,
  serving: BuildIdentity,
): boolean | null {
  // Source-mode identity cannot establish either a match or a mismatch.
  if (loaded.id === "development" || serving.id === "development") return null;
  return loaded.id !== serving.id;
}
