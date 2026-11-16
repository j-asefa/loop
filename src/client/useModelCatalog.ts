import { ConnectionId } from "../shared/contract-ids";
import { viewOwner } from "./viewCache";
import { useEffect, useRef, useState } from "react";
import type { Connection } from "../shared/types";
import type { ModelOption } from "../shared/models";
import { workspaceApi } from "../shared/workspace-api";
import { useProjectionRoute } from "./SourceContext";

type Catalog = { models?: ModelOption[]; error?: string };
type SelectedCatalog = {
  sourceId: string;
  ids: string;
  onModels: (connectionId: string, models: ModelOption[]) => void;
};
export function useModelCatalog(
  connections: Connection[],
  selected?: SelectedCatalog,
) {
  const [catalog, setCatalog] = useState<Record<string, ModelOption[]>>({});
  const [refreshing, setRefreshing] = useState(true),
    [stale, setStale] = useState(false);
  const [revision, setRevision] = useState(0);
  const sourceId = selected?.sourceId;
  const catalogKey = JSON.stringify([sourceId, revision]);
  const [selectedState, setSelectedState] = useState<{
    key: string;
    entries: Record<string, Catalog>;
  }>({ key: "", entries: {} });
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const readProjection = useProjectionRoute(
    selected
      ? { source: sourceId, key: JSON.stringify([revision, selected.ids]) }
      : {},
  );
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const connectionKey =
    selected?.ids ??
    connections
      .filter((c) => c.status === "connected")
      .map((c) => c.id)
      .join(",");
  useEffect(() => {
    if (selected) {
      let active = true;
      const owner = viewOwner();
      // A role changing connection must not invalidate the other roles' loaded
      // catalogs. An explicit refresh or workspace change still reloads them.
      const cached =
        selectedState.key === catalogKey ? selectedState.entries : {};
      setSelectedState((current) =>
        current.key === catalogKey ? current : { key: catalogKey, entries: {} },
      );
      for (const connectionId of JSON.parse(connectionKey) as string[]) {
        if (cached[connectionId]) continue;
        void readProjection(
          workspaceApi.connectionModels,
          { params: { id: ConnectionId.parse(connectionId) } },
          { mode: "once" },
        ).then(
          ({ models: discovered }) => {
            if (!active || owner !== viewOwner()) return;
            setSelectedState((current) => ({
              key: catalogKey,
              entries: {
                ...current.entries,
                [connectionId]: { models: discovered },
              },
            }));
            selectedRef.current?.onModels(connectionId, discovered);
          },
          (error: Error) => {
            if (!active || owner !== viewOwner()) return;
            setSelectedState((current) => ({
              key: catalogKey,
              entries: {
                ...current.entries,
                [connectionId]: { error: error.message },
              },
            }));
          },
        );
      }
      return () => {
        active = false;
      };
    }
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
  }, [connectionKey, revision, sourceId]);
  return {
    catalog,
    entries: selectedState.key === catalogKey ? selectedState.entries : {},
    refreshing,
    stale,
    refresh: () => setRevision((value) => value + 1),
  };
}
