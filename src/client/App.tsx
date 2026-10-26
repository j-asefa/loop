import { useAppController } from "./app/AppController";
import { renderApp } from "./app/AppView";
import "./style.css";
import "./design.css";

export default function App() {
  const app = useAppController();
  return renderApp(app);
}
