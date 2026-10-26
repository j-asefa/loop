import { app } from "../../src/server/index.js";
import { db } from "../../src/server/db.js";
import { closeExecution } from "../../src/server/execution-client.js";
import { deferredOptionsMarker } from "../../src/server/registrar.js";

type Layer = {
  method?: string;
  route?: { path: string; methods: Record<string, boolean>; stack: Layer[] };
  handle: { stack?: Layer[]; [deferredOptionsMarker]?: true };
};
const keys: string[] = [];
function walk(stack: Layer[], nested = false) {
  for (const layer of stack) {
    if (layer.route) {
      const { path, methods } = layer.route;
      if (!nested && !path.startsWith("/api/")) continue;
      const relative = path.replace(/^\/api(?=\/)/, "");
      const declared = Object.keys(methods).filter(
        (method) =>
          method !== "options" ||
          !layer.route!.stack.some(
            (entry) =>
              entry.method === "options" && entry.handle[deferredOptionsMarker],
          ),
      );
      for (const method of methods._all
        ? ["ALL"]
        : declared.map((m) => m.toUpperCase()))
        keys.push(`${method} ${relative}`);
    } else if (layer.handle.stack) walk(layer.handle.stack, true);
  }
}
walk(app.router.stack as Layer[]);
await closeExecution();
db.close();
console.log("ROUTE_INVENTORY=" + JSON.stringify(keys));
