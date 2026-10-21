import { db, id, now } from "./db.js";
import { BuildStamp, publicBuild } from "../shared/build.js";
import { observedBuild } from "./build-runtime.js";

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
  db
    .prepare(
      "SELECT * FROM deployment_instances WHERE stopped_at IS NULL AND seen_at>=? ORDER BY id",
    )
    .all(at - FRESH_MS) as Instance[];
/** Called by actual serving/working entrypoints, never by a read or CLI status. */
export function observeProcess(role: Instance["role"], build?: BuildStamp) {
  const instance = id(),
    started = now();
  db.prepare("DELETE FROM deployment_instances WHERE seen_at<?").run(
    started - 24 * 3600_000,
  );
  db.prepare("INSERT INTO deployment_instances VALUES(?,?,?,?,?,NULL)").run(
    instance,
    role,
    JSON.stringify(build ?? observedBuild()),
    started,
    started,
  );
  const pulse = () => {
    db.prepare(
      "UPDATE deployment_instances SET seen_at=?,build=? WHERE id=? AND stopped_at IS NULL",
    ).run(now(), JSON.stringify(build ?? observedBuild()), instance);
  };
  pulse();
  const timer = setInterval(pulse, 5000);
  timer.unref();
  return () => {
    clearInterval(timer);
    db.prepare("UPDATE deployment_instances SET stopped_at=? WHERE id=?").run(
      now(),
      instance,
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
