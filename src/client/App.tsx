import { capabilities } from "./capabilities";
import { ShellCapabilitiesProvider } from "./ShellCapabilities";
import { OwnerSessionBoundary } from "./app/OwnerSessionBoundary";
import type { AppNavigationInitial } from "./app/Navigation";
import { useAppController } from "./app/AppController";
import { FleetProvider } from "./FleetContext";
import { renderApp } from "./app/AppView";
import "./style.css";
import "./design.css";

export default function App() {
  return (
    <ShellCapabilitiesProvider value={capabilities}>
      <OwnerSessionBoundary>
        {(initial) => <WorkspaceApp initial={initial} />}
      </OwnerSessionBoundary>
    </ShellCapabilitiesProvider>
  );
}

function WorkspaceApp({ initial }: { initial: AppNavigationInitial }) {
  const app = useAppController(initial);
  const owner = app.session?.user.id;
  return owner ? (
    <FleetProvider key={owner} owner={owner}>
      {renderApp(app)}
    </FleetProvider>
  ) : (
    renderApp(app)
  );
}
