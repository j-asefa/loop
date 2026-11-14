import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Harness, RuntimeHarness } from "./shared/harnesses.js";
import { TunnelMode, tunnelModeFromFlags } from "./connection.js";
import { PROCESS_FILES } from "./process-records.js";
import { atomic } from "./state.js";
import { selectedHarnesses } from "./start-selection.js";

/** The launch value shared by persistence and process boundaries. */
export const LaunchRecord = z.discriminatedUnion("kind", [
  z.strictObject({
    schema: z.literal(1),
    kind: z.literal("workspace"),
    action: z.enum(["start", ...Harness.options]),
    project: z.string().optional(),
    executable: z.string().optional(),
    billing: z.enum(["subscription", "existing"]).optional(),
    acpArgs: z.array(z.string()).optional(),
    providers: z.array(RuntimeHarness).optional(),
    localOnly: z.boolean().optional(),
    publicUrl: z.string().optional(),
    tunnelName: z.string().optional(),
    tunnelConfig: z.string().optional(),
    fleet: z.boolean().optional(),
  }),
  z.strictObject({
    schema: z.literal(1),
    kind: z.literal("connection"),
    dir: z.string(),
    root: z.string().optional(),
    release: z.string().optional(),
    log: z.boolean().optional(),
    mode: TunnelMode,
  }),
]);
export type LaunchRecord = z.infer<typeof LaunchRecord>;
export type WorkspaceLaunch = Extract<LaunchRecord, { kind: "workspace" }>;
export type ConnectionLaunch = Extract<LaunchRecord, { kind: "connection" }>;
export const defaultLaunch: WorkspaceLaunch = {
  schema: 1,
  kind: "workspace",
  action: "start",
};

export async function readLaunch(
  dir: string,
): Promise<WorkspaceLaunch | undefined> {
  const saved = await readFile(join(dir, PROCESS_FILES.launch), "utf8")
    .then(JSON.parse)
    .catch(() => undefined);
  const parsed = LaunchRecord.safeParse(saved);
  return parsed.success && parsed.data.kind === "workspace"
    ? parsed.data
    : undefined;
}
export function writeLaunch(dir: string, launch: WorkspaceLaunch) {
  atomic(join(dir, PROCESS_FILES.launch), LaunchRecord.parse(launch));
}
export function tunnelArguments(mode: TunnelMode) {
  return mode.kind === "named"
    ? [
        "--tunnel-name",
        mode.name,
        "--public-url",
        mode.origin,
        ...(mode.config ? ["--tunnel-config", mode.config] : []),
      ]
    : [];
}

/** OS process/unit arguments are derived here, never stored as launch state. */
export function launchArguments(
  launch: LaunchRecord,
  resume?: string,
): string[] {
  if (launch.kind === "connection")
    return [
      "--dir",
      launch.dir,
      ...(launch.root !== undefined ? ["--root", launch.root] : []),
      ...(launch.release !== undefined ? ["--release", launch.release] : []),
      ...(launch.log ? ["--log"] : []),
      ...tunnelArguments(launch.mode),
    ];
  return [
    launch.action,
    ...(launch.project !== undefined ? ["--project", launch.project] : []),
    ...(launch.executable !== undefined
      ? ["--executable", launch.executable]
      : []),
    ...(launch.billing !== undefined ? ["--billing", launch.billing] : []),
    ...(launch.acpArgs ?? []).map((arg) => "--acp-arg=" + arg),
    ...(launch.providers !== undefined
      ? ["--providers", launch.providers.join(",")]
      : []),
    ...(launch.localOnly ? ["--local-only"] : []),
    ...(launch.publicUrl !== undefined
      ? ["--public-url", launch.publicUrl]
      : []),
    ...(launch.tunnelName !== undefined
      ? ["--tunnel-name", launch.tunnelName]
      : []),
    ...(launch.tunnelConfig !== undefined
      ? ["--tunnel-config", launch.tunnelConfig]
      : []),
    ...(launch.fleet ? ["--fleet"] : []),
    ...(resume ? ["--resume", resume] : []),
  ];
}

export function parseLaunchArguments(
  kind: "workspace",
  args: string[],
): { launch: WorkspaceLaunch; resume?: string };
export function parseLaunchArguments(
  kind: "connection",
  args: string[],
): { launch: ConnectionLaunch };
export function parseLaunchArguments(
  kind: LaunchRecord["kind"],
  args: string[],
): { launch: LaunchRecord; resume?: string } {
  if (kind === "connection") {
    const { values } = parseArgs({
      args,
      options: {
        dir: { type: "string" },
        root: { type: "string" },
        release: { type: "string" },
        "tunnel-name": { type: "string" },
        "public-url": { type: "string" },
        "tunnel-config": { type: "string" },
        log: { type: "boolean" },
      },
    });
    if (!values.dir) throw new Error("--dir is required");
    return {
      launch: LaunchRecord.parse({
        schema: 1,
        kind,
        dir: values.dir,
        root: values.root,
        release: values.release,
        log: values.log,
        mode: tunnelModeFromFlags(values),
      }),
    };
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      executable: { type: "string" },
      billing: { type: "string" },
      "acp-arg": { type: "string", multiple: true },
      providers: { type: "string" },
      "local-only": { type: "boolean" },
      "public-url": { type: "string" },
      "tunnel-name": { type: "string" },
      "tunnel-config": { type: "string" },
      fleet: { type: "boolean" },
      resume: { type: "string" },
    },
  });
  if (positionals.length > 1)
    throw new Error("Unknown command. See loop --help.");
  return {
    launch: LaunchRecord.parse({
      schema: 1,
      kind,
      action: positionals[0] ?? "start",
      project: values.project,
      executable: values.executable,
      billing: values.billing,
      acpArgs: values["acp-arg"],
      providers:
        values.providers === undefined
          ? undefined
          : selectedHarnesses(values.providers),
      localOnly: values["local-only"],
      publicUrl: values["public-url"],
      tunnelName: values["tunnel-name"],
      tunnelConfig: values["tunnel-config"],
      fleet: values.fleet,
    }),
    resume: values.resume,
  };
}

/** Adapt the child's decoded launch to the same start path as user options. */
export function launchCommandLine({
  launch,
  resume,
}: {
  launch: WorkspaceLaunch;
  resume?: string;
}) {
  return {
    positionals: [launch.action],
    values: {
      project: launch.project,
      executable: launch.executable,
      billing: launch.billing,
      "acp-arg": launch.acpArgs,
      providers: launch.providers?.join(","),
      "local-only": launch.localOnly,
      "public-url": launch.publicUrl,
      "tunnel-name": launch.tunnelName,
      "tunnel-config": launch.tunnelConfig,
      fleet: launch.fleet,
      resume,
    },
  };
}
