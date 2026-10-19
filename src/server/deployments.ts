import { createHash } from "node:crypto";
import { db, id, now } from "./db.js";
import {
  BuildStamp,
  publicBuild,
  compareBuild,
  buildLabels,
  type DeploymentObservation,
} from "../shared/build.js";
import { recordChange } from "./project-changes.js";
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
type Target = {
  checkout_id: string;
  owner_id: string;
  run_id: string;
  repository: string;
  commit_sha: string;
  ancestors: string;
  project_id: string;
  conversation_id: string;
};
type Observation = {
  id: string;
  owner_id: string;
  project_id: string;
  checkout_id: string;
  run_id: string;
  conversation_id: string;
  commit_sha: string;
  status: DeploymentObservation["status"];
  reason: string;
  instances: string;
  signature: string;
  observed_at: number;
};
const instances = (at: number) =>
  db
    .prepare(
      "SELECT * FROM deployment_instances WHERE stopped_at IS NULL AND seen_at>=? ORDER BY id",
    )
    .all(at - FRESH_MS) as Instance[];
const identities = (live: Instance[]) =>
  live.map((row) => ({
    id: row.id,
    role: row.role,
    build: publicBuild(BuildStamp.parse(JSON.parse(row.build))),
    digest: createHash("sha256").update(row.build).digest("hex"),
  }));

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
    refreshDeployments();
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
    refreshDeployments();
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

function compare(target: Target, live: Instance[]) {
  const roles = new Set(live.map((row) => row.role));
  if (!roles.has("api") || !roles.has("worker"))
    return {
      status: "unknown" as const,
      reason: "A current API and worker observation is required.",
    };
  const results = live.map((row) =>
    compareBuild(BuildStamp.parse(JSON.parse(row.build)), {
      repository: target.repository,
      commit: target.commit_sha,
      ancestors: JSON.parse(target.ancestors),
    }),
  );
  if (results.every((result) => result === "included"))
    return {
      status: "included" as const,
      reason:
        "The API and worker builds include this commit in their recorded history. This does not verify feature behavior or this device's loaded page.",
    };
  if (results.every((result) => result === "predates"))
    return {
      status: "predates" as const,
      reason: "The API and worker builds both predate this commit.",
    };
  return {
    status: "unknown" as const,
    reason:
      "Builds differ, source provenance is unavailable, or commit history cannot establish inclusion.",
  };
}

// Reconciliation and live reads must select the same recent changes. Observation
// timestamps describe process changes and cannot stand in for checkout recency.
const TARGETS = `SELECT t.*, f.project_id, c.id conversation_id,
  row_number() OVER(PARTITION BY t.owner_id,f.project_id ORDER BY k.ended_at DESC,k.id) rank
  FROM checkout_build_targets t JOIN run_checkouts k ON k.id=t.checkout_id AND k.owner_id=t.owner_id
  JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
  JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
  JOIN project_change_folders f ON f.owner_id=c.owner_id AND f.folder_id IS COALESCE(c.project_id,json_extract(r.payload,'$.folderId'))`;

/** Record only changes in evidence, not heartbeats. All lookups stay in the
 * source's database and join through the run's current owner/project scope. */
export function refreshDeployments(at = now()) {
  db.transaction(() => {
    const live = instances(at);
    const targets = db
      .prepare(
        `WITH targets AS (${TARGETS})
      SELECT * FROM targets WHERE rank<=10 ORDER BY rank DESC`,
      )
      .all() as Target[];
    const latest = db.prepare(
      "SELECT signature FROM deployment_observations WHERE owner_id=? AND project_id=? AND checkout_id=? ORDER BY rowid DESC LIMIT 1",
    );
    const insert = db.prepare(
      "INSERT INTO deployment_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const target of targets) {
      const result = compare(target, live);
      const ids = identities(live);
      const signature = createHash("sha256")
        .update(JSON.stringify([ids, result]))
        .digest("hex");
      if (
        (
          latest.get(target.owner_id, target.project_id, target.checkout_id) as
            { signature: string } | undefined
        )?.signature === signature
      )
        continue;
      const ref = id();
      insert.run(
        ref,
        target.owner_id,
        target.project_id,
        target.checkout_id,
        target.run_id,
        target.conversation_id,
        target.commit_sha,
        result.status,
        result.reason,
        JSON.stringify(ids),
        signature,
        at,
      );
      recordChange(
        target.owner_id,
        target.project_id,
        "brief_edit",
        "deployment:" + ref,
        target.conversation_id,
        at,
      );
    }
  }).immediate();
}

function visible(owner: string, project?: string, ref?: string) {
  return db
    .prepare(
      `WITH targets AS (${TARGETS}), visible AS (SELECT o.*, c.title,
    row_number() OVER(PARTITION BY o.project_id,o.checkout_id ORDER BY o.rowid DESC) revision
    FROM deployment_observations o
    JOIN conversations c ON c.id=o.conversation_id AND c.owner_id=o.owner_id
    JOIN runs r ON r.id=o.run_id AND r.owner_id=o.owner_id AND r.conversation_id=c.id
    JOIN project_change_folders f ON f.owner_id=c.owner_id AND f.folder_id IS COALESCE(c.project_id,json_extract(r.payload,'$.folderId')) AND f.project_id=o.project_id
    WHERE o.owner_id=@owner AND (@project IS NULL OR o.project_id=@project) AND (@ref IS NULL OR o.id=@ref)
    AND (@ref IS NOT NULL OR EXISTS (SELECT 1 FROM targets t WHERE t.checkout_id=o.checkout_id AND t.owner_id=o.owner_id AND t.project_id=o.project_id AND t.rank<=10))),
    latest AS (SELECT *,row_number() OVER(PARTITION BY project_id ORDER BY observed_at DESC,id) position FROM visible WHERE revision=1)
    SELECT * FROM latest WHERE position<=10 ORDER BY observed_at DESC,id`,
    )
    .all({
      owner,
      project: project ?? null,
      ref: ref ?? null,
    }) as (Observation & { title: string })[];
}

export function projectDeployments(
  owner: string,
  project: string,
  at = now(),
): DeploymentObservation[] {
  return deploymentMap(owner, project, at).get(project) ?? [];
}

export function deploymentMap(owner: string, project?: string, at = now()) {
  const processes = instances(at);
  const live = identities(processes);
  const validUntil = Math.min(
    at + FRESH_MS,
    ...processes.map((row) => row.seen_at + FRESH_MS),
  );
  const map = new Map<string, DeploymentObservation[]>();
  for (const row of visible(owner, project)) {
    const current = JSON.stringify(live) === row.instances;
    const list = map.get(row.project_id) ?? [];
    list.push({
      ref: "dep_" + row.id,
      checkout: row.checkout_id,
      run: row.run_id,
      conversation: row.conversation_id,
      title: row.title.slice(0, 200),
      commit: row.commit_sha,
      status: current ? row.status : "unknown",
      reason: current
        ? row.reason
        : "The deployment observation is no longer current.",
      observedAt: row.observed_at,
      validUntil: current ? validUntil : at,
      current,
    });
    map.set(row.project_id, list);
  }
  return map;
}

export function deploymentCite(owner: string, project: string, ref: string) {
  const row = visible(owner, project, ref)[0];
  return row
    ? {
        kind: "deployment" as const,
        content: `${buildLabels[row.status]} for commit ${row.commit_sha}. ${row.reason} Observed at ${new Date(row.observed_at).toISOString()}. Running builds: ${row.instances}. This is a historical observation; consult current deployment status for changes.`,
        recordedAt: row.observed_at,
        conversation: row.conversation_id,
        runId: row.run_id,
      }
    : null;
}
