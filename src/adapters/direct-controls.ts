import {
  undiscoveredCapabilities,
  type ActivityCapabilities,
  type SettingsData,
  type SettingValue,
  type Setting,
  type CommandsData,
} from "../shared/agent-activities.js";
import type { Emit, NativeCommand } from "./types.js";

/** Shared lifecycle for direct controls. Requests never overwrite confirmed values. */
export class DirectControls {
  settings: SettingsData = { options: [], revision: 0 };
  commands: CommandsData = { commands: [], revision: 0 };
  capabilities: ActivityCapabilities;
  private busy = false;
  constructor(
    private harness: string,
    private emit: Emit,
    options: { plans?: boolean } = {},
  ) {
    this.capabilities = undiscoveredCapabilities(`${harness} native protocol`);
    for (const feature of ["tools", "diffs", "output"] as const)
      this.capabilities[feature].state = "supported";
    if (options.plans !== false) this.capabilities.plans.state = "supported";
  }
  publish(options: Setting[], commands?: NativeCommand[]) {
    const remove = this.settings.options
      .filter((o) => !options.some((n) => n.id === o.id))
      .map((o) => o.id);
    this.settings = { revision: this.settings.revision + 1, options };
    this.capabilities.settings.state = "supported";
    if (commands) {
      this.commands = {
        revision: this.commands.revision + 1,
        commands: commands.slice(0, 500).map((c) => ({
          id: `${c.kind}:${c.token}`,
          token: c.token,
          name: c.name,
          description: c.description,
          kind: c.kind,
          argumentHint: c.argumentHint,
          available: !c.disabledReason,
          reason: c.disabledReason,
        })),
      };
      this.capabilities.commands.state = "supported";
      this.emit({
        type: "activity",
        activity: {
          v: 1,
          id: "session-commands",
          kind: "commands",
          source: this.source(),
          patch: this.commands,
        },
      });
    }
    this.emit({
      type: "activity_capabilities",
      capabilities: this.capabilities,
    });
    this.emit({
      type: "activity",
      activity: {
        v: 1,
        id: "session-settings",
        kind: "settings",
        source: this.source(),
        patch: {
          ...this.settings,
          remove,
          options: options.map((o) => ({
            ...o,
            requested: o.requested ?? null,
            confirmed: o.confirmed ?? null,
            rejected: o.rejected ?? null,
            choices: o.choices ?? null,
          })),
        },
      },
    });
  }
  private refreshing = false;
  private refreshAt = 0;
  private stopped = false;
  stop() {
    this.stopped = true;
  }
  /** Catalog reads trigger throttled rediscovery; the next workspace refresh sees replacements. */
  refresh(
    load: () => Promise<NativeCommand[]>,
    apply: (commands: NativeCommand[]) => void,
  ) {
    if (this.stopped || this.refreshing || Date.now() - this.refreshAt < 2500)
      return;
    this.refreshAt = Date.now();
    this.refreshing = true;
    void load()
      .then((commands) => {
        if (this.stopped) return;
        const before = this.commands.commands.map((c) => [
          c.token,
          c.name,
          c.description,
          c.argumentHint,
          c.kind,
          c.available,
          c.reason,
        ]);
        const after = commands.map((c) => [
          c.token,
          c.name,
          c.description,
          c.argumentHint,
          c.kind,
          !c.disabledReason,
          c.disabledReason,
        ]);
        apply(commands);
        if (
          this.capabilities.commands.state !== "supported" ||
          JSON.stringify(before) !== JSON.stringify(after)
        )
          this.publish(this.settings.options, commands);
      })
      .catch((error) => {
        if (this.stopped) return;
        apply([]);
        this.publish(this.settings.options, []);
        this.capabilities.commands = {
          state: "undiscovered",
          source: `${this.harness} catalog refresh`,
          reason: (error as Error).message.slice(0, 1000),
        };
        this.emit({
          type: "activity_capabilities",
          capabilities: this.capabilities,
        });
      })
      .finally(() => {
        this.refreshing = false;
      });
  }
  private source() {
    return {
      transport: "native" as const,
      harness: this.harness,
      origin: `${this.harness}:controls`,
    };
  }
  async change(
    id: string,
    value: SettingValue,
    revision: number,
    apply: () => Promise<Setting[] | undefined>,
  ) {
    if (this.busy || revision !== this.settings.revision)
      throw new Error("Session settings changed; refresh and retry.");
    const option = this.settings.options.find((o) => o.id === id);
    if (!option?.mutable)
      throw new Error("This setting cannot be changed in this session.");
    if (option.choices && !option.choices.some((c) => c.value === value))
      throw new Error("This choice is no longer available.");
    this.busy = true;
    this.publish(
      this.settings.options.map((o) =>
        o.id === id ? { ...o, requested: value, rejected: undefined } : o,
      ),
    );
    try {
      const confirmed = await apply();
      if (confirmed) this.publish(confirmed);
      return this.settings;
    } catch (error) {
      this.publish(
        this.settings.options.map((o) =>
          o.id === id
            ? {
                ...o,
                requested: undefined,
                rejected: (error as Error).message.slice(0, 1000),
              }
            : o,
        ),
      );
      throw error;
    } finally {
      this.busy = false;
    }
  }
  confirmNextTurn() {
    if (!this.settings.options.some((o) => o.requested !== undefined)) return;
    this.publish(
      this.settings.options.map((o) =>
        o.requested === undefined
          ? o
          : {
              ...o,
              confirmed: o.requested,
              provenance: `${this.harness} prompt acknowledgement`,
              requested: undefined,
              rejected: undefined,
            },
      ),
    );
  }
}
