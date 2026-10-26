export type DeploymentProfile = "server" | "companion";
export interface Capabilities {
  profile: DeploymentProfile;
  nativeHarnesses: boolean;
  pairedDevices: boolean;
  runtimeHosts: boolean;
  localProjects: boolean;
  /** Absent on older sources; preview sources explicitly disable management. */
  cardTokens?: boolean;
  /** Absent on sources that predate personal decision history. */
  personalDecisions?: boolean;
  /** Absent on sources without the idempotent continuation-start endpoint. */
  continuationStart?: boolean;
}
export function profileCapabilities(profile: DeploymentProfile): Capabilities {
  const companion = profile === "companion";
  return {
    profile,
    nativeHarnesses: companion,
    pairedDevices: companion,
    runtimeHosts: !companion,
    localProjects: companion,
    cardTokens: true,
    personalDecisions: true,
    continuationStart: true,
  };
}
