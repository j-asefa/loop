import { upgradeBrowserNames } from "./name-upgrade";
import { loadCapabilities } from "./capabilities";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeShellSource } from "./sourceRouting";
import { startViewportDiagnostics } from "./viewportDiagnostics";
upgradeBrowserNames();
initializeShellSource();
void loadCapabilities()
  .then(() => {
    createRoot(document.getElementById("root")!).render(<App />);
    startViewportDiagnostics();
  })
  .catch(() => {
    document.getElementById("root")!.textContent =
      "Cannot connect to Loop55. Reload to try again.";
  });
