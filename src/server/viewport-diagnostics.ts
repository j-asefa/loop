import { workspaceApi } from "../shared/workspace-api.js";
import { registrar } from "./registrar.js";

// Mounted behind the same owner/device/CSRF boundary as the rest of the API.
const routes = registrar("viewportDiagnostics");
export const viewportDiagnostics = routes.mount;
routes.on(workspaceApi.viewportDiagnostics, (req, res) => {
  const sample = req.body;
  console.info("loop-viewport-diagnostics", JSON.stringify(sample));
  res.status(204).end();
});
