import { useEffect, useState } from "react";
import {
  BuildIdentity,
  browserNeedsReload,
  runningBuild,
  buildLabels,
  type DeploymentObservation,
} from "../shared/build";
import { ConnectionNotice, setConnection } from "./ConnectionNotice";
import { relativeTime } from "./threadView";
import { useReadableText } from "./ReadableText";
import { buildObservationCurrent } from "./buildFreshness";

/** This concerns the origin serving the shell, never a selected linked source. */
export function BrowserBuildStatus() {
  useEffect(() => {
    let stopped = false;
    let request = 0;
    const check = async () => {
      const generation = ++request;
      try {
        const response = await fetch("/api/build", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return;
        const serving = BuildIdentity.safeParse(
          (await response.json()).serving,
        );
        if (!stopped && generation === request && serving.success)
          setConnection({
            updated: browserNeedsReload(runningBuild, serving.data),
          });
      } catch {
        /* A failed read is not evidence that builds match. */
      }
    };
    void check();
    const timer = setInterval(check, 15000);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return <ConnectionNotice />;
}

export function DeploymentStatus({
  observations,
  source,
  fresh = true,
}: {
  observations?: DeploymentObservation[];
  source?: string;
  fresh?: boolean;
}) {
  const readable = useReadableText();
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!observations?.length) return;
    const timer = setInterval(() => refresh((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [observations]);
  if (!observations?.length) return null;
  return (
    <details className="deployment-status">
      <summary>
        Running app · {observations.length} build comparison
        {observations.length === 1 ? "" : "s"}
      </summary>
      <p className="muted">
        Commit history comparison for the API and worker. Device reload and
        feature checks are separate.
      </p>
      {observations.map((item) => {
        const current = fresh && buildObservationCurrent(item);
        const params = new URLSearchParams({ conversation: item.conversation });
        if (source) params.set("source", source);
        return (
          <div key={item.ref} className="deployment-observation">
            <a href={"/?" + params}>{readable(item.title)}</a>
            <p>
              <strong>{buildLabels[current ? item.status : "unknown"]}</strong>
            </p>
            <p>
              {current
                ? item.reason
                : "The deployment observation is no longer current."}
            </p>
            <small>
              <code>{item.commit.slice(0, 8)}</code> ·{" "}
              <time dateTime={new Date(item.observedAt).toISOString()}>
                {relativeTime(item.observedAt)}
              </time>
              {!current && " · Last observation"}
            </small>
          </div>
        );
      })}
    </details>
  );
}
