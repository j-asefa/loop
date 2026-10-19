import { z } from "zod";

export const LOOP_REPOSITORY = "github.com/j-asefa/loop";
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
export function loopRepository(url: string): typeof LOOP_REPOSITORY | null {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)j-asefa\/loop(?:\.git)?\/?$/i.test(
    url.trim(),
  )
    ? LOOP_REPOSITORY
    : null;
}
export type BuildComparison = "included" | "predates" | "unknown";
export function compareBuild(
  build: BuildStamp,
  target: { repository: string; commit: string; ancestors: string[] },
): BuildComparison {
  if (!build.clean || !build.commit || build.repository !== target.repository)
    return "unknown";
  if (build.commit === target.commit || build.ancestors.includes(target.commit))
    return "included";
  if (target.ancestors.includes(build.commit)) return "predates";
  return "unknown";
}
export const DeploymentObservation = z.object({
  ref: z.string(),
  checkout: z.string(),
  run: z.string(),
  conversation: z.string(),
  title: z.string(),
  commit: Commit,
  status: z.enum(["included", "predates", "unknown"]),
  reason: z.string(),
  observedAt: z.number(),
  validUntil: z.number(),
  current: z.boolean(),
});
export type DeploymentObservation = z.infer<typeof DeploymentObservation>;
export const buildLabels: Record<BuildComparison, string> = {
  included: "Change commit included",
  predates: "Running build predates change",
  unknown: "Update status unknown",
};
export function browserNeedsReload(
  loaded: BuildIdentity,
  serving: BuildIdentity,
) {
  return (
    loaded.id !== "development" &&
    serving.id !== "development" &&
    loaded.id !== serving.id
  );
}
