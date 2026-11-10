import { nativeConnectionId, harnesses } from "../../shared/harnesses.js";
import * as harnessesQueries from "../sql/harnesses.js";
import * as connectionsQueries from "../sql/connections.js";
import * as agentsQueries from "../sql/agents.js";
import * as foldersQueries from "../sql/folders.js";
import * as projectPathsQueries from "../sql/project-paths.js";
import * as companionSessionsQueries from "../sql/companion-sessions.js";
import { ConnectionModels, ConnectionMetadata } from "../row-schemas.js";
import { ExecutionRefused } from "../execution-refusal.js";
import { writeConnectionStatus } from "../connection-status.js";
import { harnessHolds } from "../harness-holds.js";
import {
  verifyAgentWorkspace,
  type AgentWorkspace,
} from "../agent-worktree.js";
import { realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { db, id, now } from "../db.js";
import { ownedConnection, ownedConversation, Problem } from "../domain.js";

import { nativeStartupFailure } from "./startup-failure.js";
import { type Adapter, type Options } from "../../adapters/types.js";
import { type Billing, type Harness } from "../../shared/protocol.js";
import type { Snapshot } from "../agent-runtime.js";
import { undiscoveredCapabilities } from "../../shared/agent-activities.js";
import { hostEnvironmentName, hostLocation } from "../execution-location.js";
import type { PiCustomization } from "./pi-customization.js";
import { type Live, type Binding } from "./state.js";
import { OWNER } from "../workspace-identity.js";
import { classes, labels } from "./adapters.js";
import { boundWorkspaceArgs, workspaceError } from "./workspace.js";

// Aggregator providers report hundreds of models; this bounds what one
// harness registration can store and send to every model picker.
export const MAX_NATIVE_MODELS = 5000;

type Context = {
  live: ReadonlyMap<string, Live>;
  isStopped(): boolean;
  projectTrust: PiCustomization["projectTrust"];
};

type Registration = {
  name: Harness;
  options: string;
  billing: string;
  models: string;
  capabilities: string;
  updated_at: number;
};
/** One workspace owns native processes; native sessions own their model context. */
const PROBE_TTL = 15_000;

export class NativeProjects {
  constructor(private readonly context: Context) {}

  private enabling = new Map<Harness, Promise<any>>();
  registrations() {
    return (harnessesQueries.all(db) as Registration[]).map((r) => ({
      name: r.name,
      billing: JSON.parse(r.billing),
      models: JSON.parse(r.models),
      capabilities: JSON.parse(r.capabilities),
      updatedAt: r.updated_at,
    }));
  }
  savedRegistration(name: Harness): Options | undefined {
    const row = harnessesQueries.get(db, name) as Registration | undefined;
    return row ? JSON.parse(row.options) : undefined;
  }
  registration(name: Harness): Options {
    const options = this.savedRegistration(name);
    if (!options)
      throw new Problem(
        409,
        `Run loop ${name} on the desktop to enable this harness.`,
      );
    return options;
  }
  isEnabling(name: Harness) {
    return this.enabling.has(name);
  }
  enable(options: Options, providerChange = false, signal?: AbortSignal) {
    const hold = harnessHolds.first(
      options.harness,
      providerChange ? ["upgrade"] : ["provider-change", "sign-in", "upgrade"],
    );
    if (hold && hold !== "upgrade")
      throw new ExecutionRefused(
        409,
        "Wait for this harness’s provider change to finish.",
      );
    if (hold === "upgrade")
      throw new ExecutionRefused(
        409,
        "Wait for the runtime upgrade to finish before enabling a runtime.",
      );
    const pending = this.enabling.get(options.harness);
    if (pending)
      throw new ExecutionRefused(
        409,
        "This harness is already being enabled. Retry shortly.",
      );
    const promise = this.probe(options, signal).finally(() =>
      this.enabling.delete(options.harness),
    );
    this.enabling.set(options.harness, promise);
    return promise;
  }
  private async probe(options: Options, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.context.isStopped())
      throw new ExecutionRefused(409, "Workspace is stopping");
    if (options.harness === "acp") {
      const existing = harnessesQueries.acpOptions(db) as
        { options: string } | undefined;
      if (existing) {
        const saved = JSON.parse(existing.options) as Options;
        if (
          saved.executable !== options.executable ||
          JSON.stringify(saved.args || []) !==
            JSON.stringify(options.args || [])
        )
          throw new ExecutionRefused(
            409,
            "This workspace already has an ACP agent. Existing conversations retain that agent; changing its executable requires a distinct connection identity.",
          );
      }
    }
    try {
      options = {
        harness: options.harness,
        executable:
          options.harness === "acp"
            ? realpathSync(options.executable)
            : resolve(options.executable),
        version: options.version,
        project: this.directory(options.project),
        billing: options.billing,
        args: options.harness === "acp" ? options.args : undefined,
      };
    } catch (error) {
      // Path validation precedes adapter creation and any native command.
      if (error instanceof Problem)
        throw new ExecutionRefused(
          error.status,
          error.message,
          error.diagnostic,
        );
      throw new ExecutionRefused(
        422,
        "Could not resolve the native executable or project directory. Restore the path and retry.",
      );
    }
    const native: Adapter = new classes[options.harness](
      { ...options, probeOnly: true },
      () => {},
    );
    let billing: Billing;
    try {
      billing = await native.start();
    } catch (error) {
      // This is a prompt-free verification adapter, before registration writes.
      // Disposal below must complete before a failed probe becomes retryable.
      const failure = nativeStartupFailure(options.harness, error);
      throw new ExecutionRefused(
        failure.status,
        failure.message,
        failure.diagnostic,
      );
    } finally {
      await native.dispose();
    }
    if (this.context.isStopped())
      throw new ExecutionRefused(409, "Workspace is stopping");
    signal?.throwIfAborted();
    // Harnesses that cannot report their default before a turn keep the model
    // their last native-default run reported (see NativeProjector).
    const observed = native.defaultModelOption
      ? undefined
      : (
          connectionsQueries.resolvedNativeModel(
            db,
            nativeConnectionId(options.harness),
            OWNER,
          ) as { model: string | null } | undefined
        )?.model;
    const models = [
      native.defaultModelOption || {
        id: "native-default",
        name: "Use native default",
        ...(observed ? { resolvedModel: observed } : {}),
      },
      ...(native.models || []).filter((m) => m.id && m.id !== "native-default"),
    ];
    if (models.length > MAX_NATIVE_MODELS)
      throw new ExecutionRefused(
        422,
        `${labels[options.harness]} reported ${models.length} models; Loop accepts up to ${MAX_NATIVE_MODELS}. Remove a provider in ${labels[options.harness]} and refresh.`,
      );
    const capabilities = {
      ...native.capabilities,
      concurrentConversations: true,
      inheritedConfiguration: true,
      nativePause: false,
      settingsApplyTo: "next message",
      nativeTokenBudget: false,
      history: harnesses[options.harness].history,
      billingVerified: options.billing === "subscription",
    };
    const metadata = {
      loopHarness: options.harness,
      authMode:
        options.billing === "subscription" ? "subscription" : "native-existing",
      runtimeKind: "loop-local",
      location: hostLocation(),
      environmentName: hostEnvironmentName(),
      billing,
      capabilities,
    };
    db.transaction(() => {
      harnessesQueries.upsert(
        db,
        options.harness,
        JSON.stringify(options),
        JSON.stringify(billing),
        JSON.stringify(capabilities),
        JSON.stringify(ConnectionModels.parse(models)),
        now(),
      );
      writeConnectionStatus(nativeConnectionId(options.harness), () =>
        connectionsQueries.registerNative(
          db,
          nativeConnectionId(options.harness),
          OWNER,
          harnesses[options.harness].provider,
          metadata.environmentName + " · " + labels[options.harness],
          "",
          JSON.stringify(ConnectionModels.parse(models)),
          JSON.stringify(ConnectionMetadata.parse(metadata)),
          now(),
        ),
      );
      agentsQueries.bindNativeHarness(
        db,
        nativeConnectionId(options.harness),
        options.harness,
      );
      this.addProject(options.project);
    }).immediate();
    return { name: options.harness, billing, models, capabilities };
  }
  directory(path: string) {
    let real: string;
    try {
      real = realpathSync(path);
      if (!statSync(real).isDirectory()) throw new Error();
    } catch {
      throw new Problem(422, "Choose an existing directory on the desktop.");
    }
    return real;
  }
  addProject(path: string, name?: string) {
    const real = this.directory(path);
    const existing = foldersQueries.byProjectPath(db, real);
    if (existing) return existing;
    const folder = id();
    foldersQueries.insertNativeProject(
      db,
      folder,
      OWNER,
      name || basename(real) || real,
      now(),
    );
    projectPathsQueries.insert(db, folder, real);
    return {
      id: folder,
      name: name || basename(real),
      kind: "project",
      path: real,
    };
  }
  project(snapshot: Snapshot, options: Options) {
    if (!snapshot.folderId) return this.directory(options.project);
    let folder: string | null = snapshot.folderId;
    const seen = new Set<string>();
    while (folder && !seen.has(folder)) {
      seen.add(folder);
      const row = foldersQueries.parentProjectPath(db, folder, OWNER) as
        { parent_id: string | null; path: string | null } | undefined;
      if (row?.path) return this.directory(row.path);
      folder = row?.parent_id ?? null;
    }
    throw new Problem(
      422,
      "This project has no desktop directory. Bind it in Projects before running an agent.",
    );
  }
  private catalogCount = 0;
  private catalogChecks = new Map<string, Promise<AgentWorkspace>>();

  private async catalogWorkspace(binding: Binding, agentId: string) {
    const args = boundWorkspaceArgs(binding, agentId, OWNER);
    const key = JSON.stringify(args);
    const pending = this.catalogChecks.get(key);
    if (pending) return pending;
    // Read-only Git checks have their own budget, so slow harness probes do
    // not prevent validation of commands already loaded in a live/cache entry.
    if (this.catalogChecks.size >= 3)
      throw new Problem(429, "Native catalogs are busy. Retry shortly.");
    // Share only checks still in flight. A completed check is never reused,
    // because the directory or its Git state may change between polls.
    const check = verifyAgentWorkspace(...args).catch(workspaceError);
    this.catalogChecks.set(key, check);
    try {
      return await check;
    } finally {
      if (this.catalogChecks.get(key) === check) this.catalogChecks.delete(key);
    }
  }

  // Reports the catalog of the harness the conversation's next turn would
  // use. session() rebinds a chat to the agent's current harness while
  // keeping its project, so the catalog follows the same rule.
  async catalog(agent: any, conversation?: string, cachedOnly = false) {
    const c = conversation ? ownedConversation(conversation, OWNER) : undefined;
    if (c && c.agent_id !== agent.id)
      throw new Problem(400, "Conversation belongs to another agent");
    const harness = ownedConnection(agent.connection_id, OWNER).metadata
      .loopHarness as Harness;
    const binding = conversation
      ? (companionSessionsQueries.get(db, conversation) as Binding | undefined)
      : undefined;
    const options = this.registration(harness);
    // Validate before returning live/cached commands or launching a probe, so
    // discovery follows the same workspace and migration rules as dispatch.
    const project = binding
      ? (await this.catalogWorkspace(binding, agent.id)).directory
      : this.project({ folderId: agent.folder_id } as Snapshot, options);
    if (conversation && binding?.harness === harness) {
      const live = this.context.live.get(conversation);
      if (live && !live.closed && live.adapter.commandCatalog) {
        if (!cachedOnly) live.adapter.refreshCommandCatalog?.();
        return {
          available: true,
          runtime: labels[harness],
          commands: live.adapter.commands || [],
          ...(harness === "pi"
            ? { inventory: live.adapter.customizationInventory }
            : {}),
          revision: live.adapter.commandCatalog.revision,
          capabilities:
            live.adapter.activityCapabilities ||
            undiscoveredCapabilities(
              "Native adapter has not reported activity support",
            ),
        };
      }
    }
    const projectTrust =
      harness === "pi"
        ? this.context.projectTrust(project).override
        : undefined;
    // Commands & skills polls every few seconds. Share one recent probe per
    // harness, project and trust decision instead of starting a process each
    // time; Pi configuration changes clear it.
    const key = JSON.stringify([harness, project, projectTrust ?? null]);
    const cached = this.probes.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    if (cachedOnly)
      return {
        available: false,
        commands: [],
        message:
          "No loaded command catalog is available. Refresh the runtime on its owning computer.",
      };
    if (this.catalogCount >= 3)
      throw new Problem(429, "Native catalogs are busy. Retry shortly.");
    this.catalogCount++;
    const result = (async () => {
      const native = new classes[harness](
        { ...options, project, probeOnly: true, projectTrust },
        () => {},
      );
      try {
        await native.start();
        return {
          available: true,
          runtime: labels[harness],
          commands: native.commands || [],
          ...(harness === "pi"
            ? { inventory: (native as Adapter).customizationInventory }
            : {}),
          message:
            "Native catalog for this project. Terminal-only interactions are unavailable.",
        };
      } finally {
        await native.dispose();
        this.catalogCount--;
      }
    })();
    this.probes.set(key, { expires: Date.now() + PROBE_TTL, result });
    result.catch(() => {
      if (this.probes.get(key)?.result === result) this.probes.delete(key);
    });
    return result;
  }
  private probes = new Map<string, { expires: number; result: Promise<any> }>();
  /** Forget probed catalogs after Pi configuration or trust changes. */
  clearProbes() {
    this.probes.clear();
  }
}
