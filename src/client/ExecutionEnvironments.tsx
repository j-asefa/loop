import { RuntimeSetup } from "./RuntimeSetup";
import { RuntimeHosts } from "./RuntimeHosts";
import { Sheet } from "./components";
import { capabilities } from "./capabilities";
import type { Connection, Folder } from "../shared/types";

export function ExecutionEnvironments({
  connections,
  onChange,
  onClose,
}: {
  folders: Folder[];
  connections: Connection[];
  initialEnvironmentId?: string;
  onClose: () => void;
  onChange: () => Promise<void>;
  onLegacy: () => void;
}) {
  if (!capabilities.nativeHarnesses) return <RuntimeHosts onClose={onClose} />;
  return (
    <Sheet
      className="settings-sheet"
      title="Execution environments"
      onClose={onClose}
    >
      <p className="settings-intro">
        Installed harnesses run on this computer with their own tools and
        sign-in. Connected Docker workspaces appear under Run on.
      </p>
      <RuntimeSetup connections={connections} onEnabled={onChange} />
    </Sheet>
  );
}
