import { useEffect, useRef, useState } from "react";
import type { Connection } from "../shared/types";
import type { ModelOption } from "../shared/models";
import { workspaceApi } from "../shared/workspace-api";
import { useProjectionRoute } from "./SourceContext";

export function useModelCatalog(connections: Connection[]) {
  const readProjection = useProjectionRoute();
  const [catalog, setCatalog] = useState<Record<string, ModelOption[]>>({});
  const [refreshing, setRefreshing] = useState(true),
    [stale, setStale] = useState(false);
  const [revision, setRevision] = useState(0);
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const connectionKey = connections
    .filter((c) => c.status === "connected")
    .map((c) => c.id)
    .join(",");
  useEffect(() => {
    let current = true;
    setRefreshing(true);
    setStale(false);
    void Promise.all(
      connectionsRef.current
        .filter((c) => c.status === "connected")
        .map(async (connection) => {
          try {
            const result = await readProjection(
              workspaceApi.connectionModels,
              {
                params: { id: connection.id },
              },
              { mode: "once" },
            );
            if (current)
              setCatalog((old) => ({ ...old, [connection.id]: result.models }));
          } catch {
            if (current) setStale(true);
          }
        }),
    ).finally(() => {
      if (current) setRefreshing(false);
    });
    return () => {
      current = false;
    };
  }, [connectionKey, revision]);
  return {
    catalog,
    refreshing,
    stale,
    refresh: () => setRevision((value) => value + 1),
  };
}
