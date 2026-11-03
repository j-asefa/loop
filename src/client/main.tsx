import { loadCapabilities } from "./capabilities";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeShellSource } from "./sourceRouting";
import { startViewportDiagnostics } from "./viewportDiagnostics";
initializeShellSource();
void loadCapabilities()
  .then(() => {
    createRoot(document.getElementById("root")!).render(<App />);
    startViewportDiagnostics();
  })
  .catch(() => {
    document.getElementById("root")!.textContent =
      "Cannot connect to Loop. Reload to try again.";
  });
