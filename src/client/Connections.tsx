import { NativeConnections } from "./NativeConnections";

export function Connections(props: Parameters<typeof NativeConnections>[0]) {
  return <NativeConnections {...props} />;
}
