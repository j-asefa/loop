// Operator-delivered file, never an HTTP self-enrollment endpoint.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { db } from "../src/server/db.js";
import { initializeAccess } from "../src/server/access.js";
import { provisionEnvironment } from "../src/server/hapi/environments.js";
import { MAX_CONCURRENT_RUNS } from "../runtime/concurrency.mjs";
initializeAccess();
const owner = (
  db.prepare("SELECT owner_id FROM installation WHERE id=1").get() as any
)?.owner_id;
if (!owner)
  throw new Error(
    "Select the intended personal workspace before native provisioning",
  );
const inputs = z
  .array(
    z.object({
      name: z.string(),
      url: z.string().url(),
      instanceId: z.string(),
      namespace: z.string(),
      credential: z.string(),
      certificateFingerprint: z.string(),
      capacity: z.number().int().min(1).max(MAX_CONCURRENT_RUNS).default(MAX_CONCURRENT_RUNS),
    }),
  )
  .parse(JSON.parse(readFileSync(process.env.LOOP_ENVIRONMENTS_FILE || "/private/environments.json", "utf8")));
for (const input of inputs) provisionEnvironment(owner, input);
console.log("Provisioned environment identities verified");
db.close();
