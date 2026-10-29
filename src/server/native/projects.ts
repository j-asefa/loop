import { ConnectionModels, ConnectionMetadata } from "../row-schemas.js";
import { ExecutionRefused } from "../execution-refusal.js";
import { writeConnectionStatus } from "../connection-status.js";
import { harnessUpgrades } from "../harness-upgrades.js";
import { providerChangeInProgress } from "../native-provider-locks.js";
import { nativeSignIns } from "../native-auth.js";
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
import { type Billing, type Harness } from "../../protocol.js";
import type { Snapshot } from "../agent-runtime.js";
import { undiscoveredCapabilities } from "../../agent-activities.js";
import { hostEnvironmentName, hostLocation } from "../execution-location.js";
import type { PiCustomization } from "./pi-customization.js";
import { OWNER, type Live, type Binding } from "./state.js";
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
    return (
      db
        .prepare("SELECT * FROM harnesses ORDER BY name")
        .all() as Registration[]
    ).map((r) => ({
      name: r.name,
      billing: JSON.parse(r.billing),
      models: JSON.parse(r.models),
      capabilities: JSON.parse(r.capabilities),
      updatedAt: r.updated_at,
    }));
  }
  registration(name: Harness): Options {
    const row = db.prepare("SELECT * FROM harnesses WHERE name=?").get(name) as
      Registration | undefined;
    if (!row)
      throw new Problem(
        409,
        `Run loop ${name} on the desktop to enable this harness.`,
      );
    return JSON.parse(row.options);
  }
  isEnabling(name: Harness) {
    return this.enabling.has(name);
  }
  enable(options: Options, providerChange = false, signal?: AbortSignal) {
    if (
      (providerChangeInProgress(options.harness) ||
        nativeSignIns.inProgress(options.harness)) &&
      !providerChange
    )
      throw new ExecutionRefused(
        409,
        "Wait for this harness’s provider change to finish.",
      );
    if (harnessUpgrades.busy(options.harness))
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
      const existing = db
        .prepare("SELECT options FROM harnesses WHERE name='acp'")
        .get() as { options: string } | undefined;
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
      const failure = nativeStartupFailure(labels[options.harness], error);
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
    const models = [
      native.defaultModelOption || {
        id: "native-default",
        name: "Use native default",
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
      boundedWorkflowTime: true,
      history:
        options.harness === "codex"
          ? "native read/list/fork"
          : "Loop-managed history; native resume",
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
      db.prepare(
        "INSERT INTO harnesses VALUES(?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET options=excluded.options,billing=excluded.billing,capabilities=excluded.capabilities,models=excluded.models,updated_at=excluded.updated_at",
      ).run(
        options.harness,
        JSON.stringify(options),
        JSON.stringify(billing),
        JSON.stringify(capabilities),
        JSON.stringify(ConnectionModels.parse(models)),
        now(),
      );
      writeConnectionStatus("native-" + options.harness, () =>
        db
          .prepare(
            "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,?,?,?,'connected',?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,status='connected',models=excluded.models,metadata=excluded.metadata",
          )
          .run(
            "native-" + options.harness,
            OWNER,
            options.harness === "claude" ? "anthropic" : options.harness,
            metadata.environmentName + " · " + labels[options.harness],
            "",
            JSON.stringify(ConnectionModels.parse(models)),
            JSON.stringify(ConnectionMetadata.parse(metadata)),
            now(),
          ),
      );
      db.prepare(
        "UPDATE agents SET connection_id=? WHERE connection_id IS NULL AND id IN (SELECT agent_id FROM conversations c JOIN companion_sessions n ON n.conversation_id=c.id WHERE n.harness=?)",
      ).run("native-" + options.harness, options.harness);
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
    const existing = db
      .prepare(
        "SELECT f.*,p.path FROM folders f JOIN project_paths p ON p.folder_id=f.id WHERE p.path=?",
      )
      .get(real);
    if (existing) return existing;
    const folder = id();
    db.prepare(
      "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,NULL,'project',?,?)",
    ).run(folder, OWNER, name || basename(real) || real, now());
    db.prepare("INSERT INTO project_paths VALUES(?,?)").run(folder, real);
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
      const row = db
        .prepare(
          "SELECT f.parent_id,p.path FROM folders f LEFT JOIN project_paths p ON p.folder_id=f.id WHERE f.id=? AND f.owner_id=?",
        )
        .get(folder, OWNER) as
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
      ? (db
          .prepare("SELECT * FROM companion_sessions WHERE conversation_id=?")
          .get(conversation) as Binding | undefined)
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
