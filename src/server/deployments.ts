import * as deploymentInstancesQueries from "./sql/deployment-instances.js";
import { db, id, now } from "./db.js";
import { BuildStamp, publicBuild } from "../shared/build.js";
import { observedBuild } from "./build-runtime.js";
import { observeApiEventLoop } from "./event-loop-health.js";
import { heartbeatWrite } from "./heartbeat-write.js";

const FRESH_MS = 20_000;
type Instance = {
  id: string;
  role: "api" | "worker";
  build: string;
  started_at: number;
  seen_at: number;
  stopped_at: number | null;
};
const instances = (at: number) =>
  deploymentInstancesQueries.fresh(db, at - FRESH_MS) as Instance[];
/** Called by actual serving/working entrypoints, never by a read or CLI status. */
export function observeProcess(role: Instance["role"], build?: BuildStamp) {
  const stopEventLoop = role === "api" ? observeApiEventLoop() : undefined;
  const instance = id(),
    started = now();
  deploymentInstancesQueries.prune(db, started - 24 * 3600_000);
  deploymentInstancesQueries.insert(
    db,
    instance,
    role,
    JSON.stringify(build ?? observedBuild()),
    started,
  );
  const pulse = () =>
    heartbeatWrite(`deployment-${role}`, () => {
      deploymentInstancesQueries.heartbeat(
        db,
        now(),
        JSON.stringify(build ?? observedBuild()),
        instance,
      );
    });
  pulse();
  const timer = setInterval(pulse, 5000);
  timer.unref();
  return () => {
    stopEventLoop?.();
    clearInterval(timer);
    heartbeatWrite(`deployment-${role}`, () =>
      deploymentInstancesQueries.stop(db, now(), instance),
    );
  };
}

export function currentBuilds(at = now()) {
  return instances(at).map((row) => ({
    instance: row.id,
    role: row.role,
    startedAt: row.started_at,
    observedAt: row.seen_at,
    build: publicBuild(BuildStamp.parse(JSON.parse(row.build))),
  }));
}
