import { useAppController } from "./app/AppController";
import { FleetProvider } from "./FleetContext";
import { renderApp } from "./app/AppView";
import "./style.css";
import "./design.css";

export default function App() {
  const app = useAppController();
  const owner = app.session?.user.id;
  return owner ? (
    <FleetProvider key={owner} owner={owner}>
      {renderApp(app)}
    </FleetProvider>
  ) : (
    renderApp(app)
  );
}
