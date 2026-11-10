import { directActivityEmitter } from "./direct-activities.js";
import { DirectControls } from "./direct-controls.js";
import type { Emit } from "./types.js";

export abstract class DirectAdapter {
  protected controlState?: DirectControls;
  protected readonly emit: Emit;
  constructor(
    private readonly controlHarness: string,
    emit: Emit,
    private readonly controlOptions: { commands?: boolean } = {},
  ) {
    this.emit = directActivityEmitter(emit);
  }
  protected createControls() {
    return new DirectControls(this.controlHarness, this.emit);
  }
  protected get displayControls() {
    return (this.controlState ||= this.createControls());
  }
  get settings() {
    return this.displayControls.settings;
  }
  get commandCatalog() {
    return this.controlOptions.commands === false
      ? undefined
      : this.displayControls.commands;
  }
  get activityCapabilities() {
    return this.displayControls.capabilities;
  }
}
