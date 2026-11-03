import * as projectPathsQueries from "./sql/project-paths.js";
import * as connectionsQueries from "./sql/connections.js";
import * as harnessesQueries from "./sql/harnesses.js";
import * as runsQueries from "./sql/runs.js";
import { ExecutionRefused } from "./execution-refusal.js";
import { discover } from "../host-control.js";
import { upgradeLauncher } from "../harness-upgrades.js";
import { hostEnvironmentName } from "./execution-location.js";
import { db } from "./db.js";
import { owned, Problem } from "./domain.js";
import { nativeSessions, OWNER } from "./native-sessions.js";
import { nativeSignIns } from "./native-auth.js";
import { providerChangeInProgress } from "./native-provider-locks.js";
import { harnessUpgrades as upgrades } from "./harness-upgrades.js";
import {
  RuntimeHarness,
  type ExecutionInput,
} from "../shared/execution-authority.js";
import type { Harness } from "../protocol.js";

const savedRegistration = (name: Harness) =>
  nativeSessions.registrations().some((r) => r.name === name)
    ? nativeSessions.registration(name)
    : undefined;

export async function authOptions({
  name,
  projectId,
}: ExecutionInput<"auth.catalog">) {
  owned("folders", projectId, OWNER);
  const project = projectPathsQueries.path(db, projectId) as
    { path: string } | undefined;
  if (!project)
    throw new ExecutionRefused(
      422,
      "Choose a project directory on this computer.",
    );
  const saved = savedRegistration(name);
  const probe = await discover(name, saved?.executable);
  if (!probe.installed || !probe.supported)
    throw new ExecutionRefused(409, probe.help);
  return {
    name,
    executable: probe.executable!,
    version: probe.version!,
    project: saved?.project || project.path,
  };
}

// Probes, sign-ins and upgrade holds now belong to the same authority as claims.
const probes = new Map<
  string,
  { at: number; probe: ReturnType<typeof discover> }
>();
function recentDiscover(name: Harness, executable?: string, fresh = false) {
  const key = name + "\0" + (executable ?? ""),
    hit = probes.get(key);
  if (!fresh && hit && Date.now() - hit.at < 10_000) return hit.probe;
  const probe = discover(name, executable);
  probes.set(key, { at: Date.now(), probe });
  probe.catch(() => probes.delete(key));
  return probe;
}
export async function runtimeList({
  fresh,
  cachedOnly,
}: ExecutionInput<"runtime.list">) {
  const registered = nativeSessions.registrations();
  const runtimes = await Promise.all(
    RuntimeHarness.options.map(async (name) => {
      const enabled = registered.find((r) => r.name === name);
      const saved = enabled ? nativeSessions.registration(name) : undefined;
      const probe = cachedOnly
        ? {
            installed: !!saved,
            supported: !!saved,
            version: saved?.version,
            help: saved
              ? "Previously enabled on this computer."
              : "Not registered on this computer.",
          }
        : await recentDiscover(name, saved?.executable, fresh);
      return {
        name,
        backend: "direct",
        installed: probe.installed,
        available: !!(probe.installed && probe.supported),
        version: probe.installed ? probe.version : undefined,
        help: probe.help,
        enabled:
          !!enabled &&
          connectionsQueries.connectedExists(db, "native-" + name, OWNER) !=
            null,
        authentication: enabled ? "previously_verified" : "unknown",
        billing: saved?.billing,
        project: saved?.project,
      };
    }),
  );
  return { computer: hostEnvironmentName(), online: true, runtimes };
}
export async function upgradeStatus({
  name,
  check,
}: ExecutionInput<"upgrade.status">) {
  const probe = await discover(name, savedRegistration(name)?.executable);
  const release =
    check && probe.installed
      ? await upgrades.check(name, probe.executable!)
      : {};
  return {
    ...release,
    upgrade: upgrades.status(name),
    ...(probe.installed
      ? upgrades.availability(name, probe.executable!)
      : {
          canUpgrade: false,
          upgradeHelp: "Install this runtime on the computer first.",
        }),
  };
}
export async function upgradeStart(
  { name }: ExecutionInput<"upgrade.start">,
  commandId: string,
) {
  let release: () => void;
  try {
    const previous = upgrades.operation(name, commandId);
    if (previous) return { upgrade: previous };
    // Reserve before any await or active-run query. Claim and native launch
    // consult this authority's exact same hold until start takes ownership.
    release = upgrades.reserve(name);
  } catch (error) {
    throw new Problem(409, (error as Error).message);
  }
  try {
    if (nativeSignIns.inProgress(name) || providerChangeInProgress(name))
      throw new Problem(409, "Finish or cancel sign-in before upgrading.");
    if (runsQueries.hasActive(db, OWNER))
      throw new Problem(
        409,
        "Finish or cancel active runs before upgrading runtimes.",
      );
    const saved = savedRegistration(name);
    const probe = await discover(name, saved?.executable);
    if (!probe.installed)
      throw new Problem(409, "Install this runtime on the computer first.");
    let executable: string, upgrade: ReturnType<typeof upgrades.start>;
    try {
      executable = upgradeLauncher(name, probe.executable!);
      release();
      upgrade = upgrades.start(name, executable, commandId);
      probes.clear();
    } catch (error) {
      throw new Problem(409, (error as Error).message);
    }
    if (saved && saved.executable !== executable)
      harnessesQueries.setOptions(
        db,
        JSON.stringify({ ...saved, executable }),
        name,
      );
    return { upgrade };
  } finally {
    release();
  }
}
export function upgradeDismiss({ name }: ExecutionInput<"upgrade.dismiss">) {
  try {
    upgrades.dismiss(name);
  } catch (error) {
    throw new Problem(409, (error as Error).message);
  }
  return { upgrade: null };
}
export function upgradeRecover(
  { name }: ExecutionInput<"upgrade.recover">,
  commandId: string,
) {
  try {
    upgrades.recover(name, commandId);
  } catch (error) {
    throw new Problem(409, (error as Error).message);
  }
  return { upgrade: upgrades.status(name) };
}
export async function runtimeEnable(input: ExecutionInput<"runtime.enable">) {
  const { name } = input;
  if (nativeSignIns.inProgress(name) || providerChangeInProgress(name))
    throw new ExecutionRefused(
      409,
      "Finish or cancel this runtime’s sign-in before enabling it.",
    );
  owned("folders", input.projectId, OWNER);
  const project = projectPathsQueries.path(db, input.projectId) as
    { path: string } | undefined;
  if (!project)
    throw new ExecutionRefused(
      422,
      "Choose a project with a directory on this computer. Add one in Projects.",
    );
  const saved = savedRegistration(name);
  if (saved && input.billing !== saved.billing)
    throw new ExecutionRefused(
      409,
      "This runtime is already enabled with another billing policy. Change it explicitly from the desktop.",
    );
  if (saved && project.path !== saved.project)
    throw new ExecutionRefused(
      409,
      "This runtime is already bound to another project. Stop the desktop workspace before changing its project.",
    );
  if (
    input.billing === "subscription" &&
    ["opencode", "antigravity", "gemini", "muse", "grok"].includes(name)
  )
    throw new ExecutionRefused(
      422,
      `${({ antigravity: "Antigravity", gemini: "Gemini CLI", muse: "Muse Code", grok: "Grok Build" } as Record<string, string>)[name] ?? "OpenCode"} cannot verify subscription billing. Choose existing native configuration instead.`,
    );
  const probe = await discover(name, saved?.executable);
  if (!probe.installed || !probe.supported || !probe.version)
    throw new ExecutionRefused(
      409,
      "Install or repair " + name + " on this computer. " + probe.help,
    );
  try {
    return await nativeSessions.enable({
      harness: name,
      executable: probe.executable!,
      version: probe.version,
      project: project.path,
      billing: input.billing,
    });
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(
      422,
      `Could not enable ${name} on this computer. Check its CLI sign-in and configuration, and verify the selected billing policy. Subscription mode requires a supported native subscription; no billing fallback was attempted. Run loop doctor for installation checks, then retry.`,
    );
  }
}
