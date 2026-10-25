import { realpathSync, statSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { db, now } from "../db.js";
import { ownedConnection, Problem } from "../domain.js";

import { type NativeCommand } from "../../adapters/types.js";
import type { Snapshot } from "../agent-runtime.js";
import { piInstructionSources, piPackageEntries, piProjectResources, piSettingsPath, piSavedTrust, settingsHash, updatePiPackageFilters, type PiPackageEntry } from "../pi-customization-files.js";
import { expandPiPrompt, piPromptBody } from "../pi-prompt-preview.js";
import { runPi } from "../pi-run.js";
import { inspectPiPackage, previousPiPackageSource } from "../pi-package-inspect.js";
import type { NativeProjects } from "./projects.js";
import type { Live } from "./state.js";
import { OWNER } from "./state.js";

type Context = {
  live: ReadonlyMap<string, Live>;
  dispose(live: Live): Promise<void>;
  clearProbes: NativeProjects["clearProbes"];
  catalog: NativeProjects["catalog"];
  registration: NativeProjects["registration"];
  project: NativeProjects["project"];
};



export class PiCustomization {
  constructor(private readonly context: Context) {}

  private piPackageBusy = false;
  private piAgentDir() {
    return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  }
  projectTrust(project: string) {
    const resource = piProjectResources(project);
    if (!resource.required)
      return {
        ...resource,
        trusted: true,
        decision: "not required",
        override: undefined,
      };
    const stored = db
      .prepare(
        "SELECT trusted,fingerprint FROM pi_project_trust WHERE owner_id=? AND project=?",
      )
      .get(OWNER, project) as
      { trusted: number; fingerprint: string } | undefined;
    if (stored?.fingerprint === resource.fingerprint)
      return {
        ...resource,
        trusted: stored.trusted === 1,
        decision: stored.trusted === 1 ? "trusted in Loop" : "declined in Loop",
        override: stored.trusted === 1,
      };
    if (stored)
      return {
        ...resource,
        trusted: false,
        decision: "review again",
        override: false,
      };
    const saved = piSavedTrust(this.piAgentDir(), project);
    return {
      ...resource,
      trusted: saved?.trusted === true,
      decision: saved?.decision || "undecided",
      override: undefined,
    };
  }
  private refreshLoopTrustAfterProjectWrite(project: string) {
    const stored = db
      .prepare(
        "SELECT trusted FROM pi_project_trust WHERE owner_id=? AND project=?",
      )
      .get(OWNER, project) as { trusted: number } | undefined;
    if (stored?.trusted !== 1) return;
    db.prepare(
      "UPDATE pi_project_trust SET fingerprint=?,decided_at=? WHERE owner_id=? AND project=?",
    ).run(piProjectResources(project).fingerprint, now(), OWNER, project);
  }
  // Shared database/filesystem reads only; safe in the HTTP process.
  piConfiguration(agent: any) {
    const { project } = this.piPackageContext(agent);
    const trust = this.projectTrust(project);
    const agentDir = this.piAgentDir();
    const packages = piPackageEntries(agentDir, project).map((entry, index) => {
      const recovery = db
        .prepare(
          "SELECT previous_source FROM pi_package_recovery WHERE owner_id=? AND project=? AND scope=? AND source=?",
        )
        .get(OWNER, project, entry.scope, entry.source) as
        { previous_source: string } | undefined;
      let resolvedSource: string | undefined;
      if (index < 100)
        try {
          resolvedSource = previousPiPackageSource(
            entry.source,
            entry.scope,
            agentDir,
            project,
          );
        } catch {
          /* Pi can report the resource on reload. */
        }
      return {
        ...entry,
        resolvedSource,
        settingsHash: settingsHash(
          piSettingsPath(agentDir, project, entry.scope),
        ),
        previousSource: recovery?.previous_source,
      };
    });
    return {
      project,
      trust,
      packages,
      instructions: piInstructionSources(agentDir, project, trust.trusted),
    };
  }
  // Pi configuration changes invalidate probed catalogs, success or not.
  async piTrustDecision(agent: any, trusted: boolean, fingerprint: string) {
    try {
      return await this.applyPiTrust(agent, trusted, fingerprint);
    } finally {
      this.context.clearProbes();
    }
  }
  private async applyPiTrust(
    agent: any,
    trusted: boolean,
    fingerprint: string,
  ) {
    const { project } = this.piPackageContext(agent);
    const current = piProjectResources(project);
    if (current.fingerprint !== fingerprint)
      throw new Problem(
        409,
        "Project resources changed. Review them again before deciding.",
      );
    const sessions = [...this.context.live.values()].filter(
      (live) =>
        live.binding.harness === "pi" &&
        live.binding.project === project &&
        !live.closed,
    );
    if (sessions.some((live) => !!live.run))
      throw new Problem(
        409,
        "Wait for the current Pi run to finish before changing project trust.",
      );
    for (const live of sessions) await this.context.dispose(live);
    db.prepare(
      "INSERT INTO pi_project_trust(owner_id,project,fingerprint,trusted,decided_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,project) DO UPDATE SET fingerprint=excluded.fingerprint,trusted=excluded.trusted,decided_at=excluded.decided_at",
    ).run(OWNER, project, fingerprint, trusted ? 1 : 0, now());
    return {};
  }
  piPackageFilters(
    agent: any,
    source: string,
    scope: "user" | "project",
    filters: PiPackageEntry["filters"],
    expectedHash: string,
  ) {
    if (this.piPackageBusy)
      throw new Problem(409, "A Pi package change is already running.");
    const { project } = this.piPackageContext(agent);
    if (scope === "project" && !this.projectTrust(project).trusted)
      throw new Problem(
        409,
        "Review and trust this project before changing project packages.",
      );
    const path = piSettingsPath(this.piAgentDir(), project, scope);
    try {
      updatePiPackageFilters(path, source, filters, expectedHash);
    } catch (error) {
      throw new Problem(409, (error as Error).message);
    }
    if (scope === "project") this.refreshLoopTrustAfterProjectWrite(project);
    return {
      status: "configured",
      application: "new-session",
    };
  }
  async piPromptPreview(
    agent: any,
    name: string,
    args: string,
    conversation?: string,
  ) {
    this.piPackageContext(agent);
    const catalog = await this.context.catalog(agent, conversation);
    const command = (catalog.commands || []).find(
      (entry: NativeCommand) => entry.name === name && entry.kind === "prompt",
    );
    if (!command?.sourceInfo?.path)
      throw new Problem(
        404,
        "This prompt is not loaded by Pi. Refresh its catalog.",
      );
    let raw: string;
    try {
      const path = realpathSync(command.sourceInfo.path);
      if (
        !path.endsWith(".md") ||
        !statSync(path).isFile() ||
        statSync(path).size > 100_000
      )
        throw new Error("Invalid prompt file");
      raw = readFileSync(path, "utf8");
    } catch {
      throw new Problem(404, "The loaded prompt file is unavailable.");
    }
    return {
      token: `/${name}${args ? ` ${args}` : ""}`,
      expanded: expandPiPrompt(piPromptBody(raw), args),
    };
  }
  async piInspectPackage(agent: any, source: string) {
    const { project } = this.piPackageContext(agent);
    if (
      source.length > 512 ||
      !source ||
      source.startsWith("-") ||
      /[\x00-\x1f]/.test(source)
    )
      throw new Problem(422, "Enter a valid Pi package source.");
    return inspectPiPackage(source, project);
  }
  // Pi configuration changes invalidate probed catalogs, success or not.
  async piRollbackPackage(
    agent: any,
    source: string,
    scope: "user" | "project",
  ) {
    try {
      return await this.applyPiRollback(agent, source, scope);
    } finally {
      this.context.clearProbes();
    }
  }
  private async applyPiRollback(
    agent: any,
    source: string,
    scope: "user" | "project",
  ) {
    if (this.piPackageBusy)
      throw new Problem(409, "A Pi package change is already running.");
    const { options, project } = this.piPackageContext(agent);
    if (scope === "project" && !this.projectTrust(project).trusted)
      throw new Problem(
        409,
        "Review and trust this project before changing project packages.",
      );
    const recovery = db
      .prepare(
        "SELECT previous_source FROM pi_package_recovery WHERE owner_id=? AND project=? AND scope=? AND source=?",
      )
      .get(OWNER, project, scope, source) as
      { previous_source: string } | undefined;
    if (
      !recovery ||
      !this.piPackages(agent).some(
        (entry) => entry.source === source && entry.scope === scope,
      )
    )
      throw new Problem(
        409,
        "This package no longer has a matching recovery revision.",
      );
    this.piPackageBusy = true;
    try {
      await runPi(
        options.executable,
        [
          "install",
          recovery.previous_source,
          ...(scope === "project"
            ? ["--local", "--approve"]
            : ["--no-approve"]),
        ],
        { cwd: project },
      );
      if (scope === "project") this.refreshLoopTrustAfterProjectWrite(project);
      db.prepare(
        "DELETE FROM pi_package_recovery WHERE owner_id=? AND project=? AND scope=? AND source=?",
      ).run(OWNER, project, scope, source);
      return {
        status: "configured",
        application: "new-session",
      };
    } catch (error: any) {
      throw new Problem(
        422,
        `Pi could not restore the previous package revision${error?.message ? `: ${error.message}` : "."} The recovery pin is still available.`,
      );
    } finally {
      this.piPackageBusy = false;
    }
  }
  private piPackageContext(agent: any) {
    const connection = ownedConnection(agent.connection_id, OWNER);
    if (connection.metadata.loopHarness !== "pi")
      throw new Problem(
        422,
        "Choose a direct Pi agent for Pi package management.",
      );
    const options = this.context.registration("pi");
    return {
      options,
      project: this.context.project({ folderId: agent.folder_id } as Snapshot, options),
    };
  }
  piPackages(agent: any) {
    const { project } = this.piPackageContext(agent);
    return piPackageEntries(this.piAgentDir(), project);
  }
  // Pi configuration changes invalidate probed catalogs, success or not.
  async piPackageAction(
    agent: any,
    action: "install" | "remove" | "update",
    source: string,
    scope: "user" | "project",
  ) {
    try {
      return await this.applyPiPackageAction(agent, action, source, scope);
    } finally {
      this.context.clearProbes();
    }
  }
  private async applyPiPackageAction(
    agent: any,
    action: "install" | "remove" | "update",
    source: string,
    scope: "user" | "project",
  ) {
    if (this.piPackageBusy)
      throw new Problem(409, "A Pi package change is already running.");
    const { options, project } = this.piPackageContext(agent);
    if (scope === "project" && !this.projectTrust(project).trusted)
      throw new Problem(
        409,
        "Review and trust this project before changing project packages.",
      );
    if (
      source.length > 512 ||
      !source ||
      source.startsWith("-") ||
      /[\x00-\x1f]/.test(source)
    )
      throw new Problem(422, "Enter a valid Pi package source.");
    if (
      action !== "install" &&
      !this.piPackages(agent).some(
        (entry) => entry.source === source && entry.scope === scope,
      )
    )
      throw new Problem(
        409,
        "This package is no longer configured in the selected scope. Refresh and retry.",
      );
    if (
      action === "update" &&
      this.piPackages(agent).some(
        (entry) => entry.source === source && entry.scope !== scope,
      )
    )
      throw new Problem(
        409,
        "Pi updates matching package sources in both scopes. Remove the duplicate or update it in Pi directly.",
      );
    if (source.startsWith("./")) {
      if (scope !== "project")
        throw new Problem(
          422,
          "Relative local packages must be installed for this project.",
        );
      let path: string;
      try {
        // Pi resolves project-local sources relative to the project's .pi directory.
        path = realpathSync(resolve(project, ".pi", source));
      } catch {
        throw new Problem(422, "Local package directory was not found.");
      }
      if (!path.startsWith(project + sep) || !statSync(path).isDirectory())
        throw new Problem(
          422,
          "Local packages must be directories inside this project.",
        );
    } else if (
      !/^(npm:|git:)/.test(source) &&
      !(
        action !== "install" &&
        this.piPackages(agent).some(
          (entry) => entry.source === source && entry.scope === scope,
        )
      )
    )
      throw new Problem(
        422,
        "Use an npm: or git: source, or a ./ path inside the project.",
      );
    this.piPackageBusy = true;
    try {
      let previous: string | undefined;
      if (action === "update") {
        try {
          previous = previousPiPackageSource(
            source,
            scope,
            this.piAgentDir(),
            project,
          );
        } catch {
          /* update can proceed without a recovery pin */
        }
      }
      const args = [
        action,
        source,
        ...(action !== "update" && scope === "project" ? ["--local"] : []),
        scope === "project" ? "--approve" : "--no-approve",
      ];
      await runPi(options.executable, args, { cwd: project });
      if (action === "update" && previous) {
        let current: string | undefined;
        try {
          current = previousPiPackageSource(
            source,
            scope,
            this.piAgentDir(),
            project,
          );
        } catch {
          /* A future update can establish a new recovery pin. */
        }
        if (current && current !== previous)
          db.prepare(
            "INSERT INTO pi_package_recovery(owner_id,project,scope,source,previous_source,saved_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,project,scope,source) DO UPDATE SET previous_source=excluded.previous_source,saved_at=excluded.saved_at",
          ).run(OWNER, project, scope, source, previous, now());
      }
      if (scope === "project") this.refreshLoopTrustAfterProjectWrite(project);
      if (action === "remove")
        db.prepare(
          "DELETE FROM pi_package_recovery WHERE owner_id=? AND project=? AND scope=? AND source=?",
        ).run(OWNER, project, scope, source);
      return {
        status: "configured",
        application: "new-session",
      };
    } catch (error: any) {
      throw new Problem(
        422,
        `Pi ${action} failed${error?.message ? `: ${error.message}` : "."} Check the package source and Pi installation on this computer.`,
      );
    } finally {
      this.piPackageBusy = false;
    }
  }
}
