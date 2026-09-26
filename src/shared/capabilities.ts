export type DeploymentProfile = "server" | "companion";
export interface Capabilities {
  profile: DeploymentProfile;
  nativeHarnesses: boolean;
  pairedDevices: boolean;
  runtimeHosts: boolean;
  localProjects: boolean;
}
export function profileCapabilities(profile: DeploymentProfile): Capabilities {
  const companion = profile === "companion";
  return {
    profile,
    nativeHarnesses: companion,
    pairedDevices: companion,
    runtimeHosts: !companion,
    localProjects: companion,
  };
}
