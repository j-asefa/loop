import { capabilities } from "./capabilities";
import { NativeConnections } from "./NativeConnections";

export function Connections(props: Parameters<typeof NativeConnections>[0]) {
  return capabilities.nativeHarnesses ? <NativeConnections {...props} /> : null;
}
