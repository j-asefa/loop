import { parse } from "./json";
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
type BootstrapCatalogOptions = {
  sourceId: string;
  bootstrap: { id: Connection["id"] | ""; models?: string; present: boolean };
};
export function useModelCatalog(
  connections: Connection[],
  selected?: SelectedCatalog | BootstrapCatalogOptions,
) {
  const [catalog, setCatalog] = useState<Record<string, ModelOption[]>>({});
  const [refreshing, setRefreshing] = useState(true),
    [stale, setStale] = useState(false);
  const [revision, setRevision] = useState(0);
  const sourceId = selected?.sourceId;
  const selectedNative = selected && "ids" in selected ? selected : undefined;
  const bootstrap = selected && "bootstrap" in selected ? selected : undefined;
  const source = bootstrap?.sourceId || "";
  const selectedConnection = bootstrap?.bootstrap.id || "";
  const savedModels = parse<ModelOption[]>(bootstrap?.bootstrap.models, []);
  const catalogKey = JSON.stringify([sourceId, revision]);
  const [selectedState, setSelectedState] = useState<{
    key: string;
    entries: Record<string, Catalog>;
  }>({ key: "", entries: {} });
  const selectedRef = useRef(selectedNative);
  selectedRef.current = selectedNative;
  const readProjection = useProjectionRoute(
    selectedNative
      ? {
          source: sourceId,
          key: JSON.stringify([revision, selectedNative.ids]),
        }
      : {},
  );
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const connectionKey =
    selectedNative?.ids ??
    connections
      .filter((c) => c.status === "connected")
      .map((c) => c.id)
      .join(",");
  useEffect(() => {
    if (bootstrap) return;
    if (selectedNative) {
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
  const [bootstrapCatalog, setBootstrapCatalog] = useState<{
    connectionId: string;
    source: string;
    models?: ModelOption[];
    error?: string;
  }>();
  const catalogRequest = useRef<
    | {
        key: string;
        cancel: () => void;
        savedModels?: string;
        succeeded: boolean;
      }
    | undefined
  >(undefined);
  useEffect(
    () => () => {
      catalogRequest.current?.cancel();
      catalogRequest.current = undefined;
    },
    [],
  );
  useEffect(() => {
    if (!bootstrap) return;
    const key = JSON.stringify([selectedConnection, source, revision]);
    const previous = catalogRequest.current;
    if (previous?.key === key) {
      const changed = previous.savedModels !== bootstrap?.bootstrap.models;
      previous.savedModels = bootstrap?.bootstrap.models;
      // Keep pending discovery alive across its own metadata notification.
      // After success, later workspace updates become the current catalog.
      // Failures still require an explicit retry rather than falling back.
      if (previous.succeeded && changed)
        setBootstrapCatalog({
          connectionId: selectedConnection,
          source,
          models: savedModels,
        });
      return;
    }
    catalogRequest.current?.cancel();
    catalogRequest.current = undefined;
    setBootstrapCatalog(undefined);
    // Bootstrap already includes the validated catalog. Re-discovering a native
    // harness here can take seconds; only discover missing catalogs or refresh
    // when requested. Creation still validates against the owner's connection.
    if (!selectedConnection || (savedModels.length && !revision)) return;
    let current = true;
    const discovery = {
      key,
      savedModels: bootstrap?.bootstrap.models,
      succeeded: false,
      cancel: () => {
        current = false;
      },
    };
    catalogRequest.current = discovery;
    setBootstrapCatalog({ connectionId: selectedConnection, source });
    void readProjection(
      workspaceApi.connectionModels,
      { params: { id: selectedConnection } },
      { mode: "once", source: source },
    ).then(
      ({ models }) => {
        if (current) {
          discovery.succeeded = true;
          setBootstrapCatalog({
            connectionId: selectedConnection,
            source,
            models,
          });
        }
      },
      (error: Error) => {
        if (current)
          setBootstrapCatalog({
            connectionId: selectedConnection,
            source,
            error: error.message,
          });
      },
    );
  }, [selectedConnection, source, revision, bootstrap?.bootstrap.models]);
  const currentCatalog =
    bootstrapCatalog?.connectionId === selectedConnection &&
    bootstrapCatalog.source === source
      ? bootstrapCatalog
      : undefined;
  const refreshingModels =
    !!bootstrap?.bootstrap.present &&
    (currentCatalog
      ? !currentCatalog.models && !currentCatalog.error
      : !savedModels.length);
  const models = currentCatalog ? currentCatalog.models || [] : savedModels;
  return {
    catalog,
    currentCatalog,
    refreshingModels,
    models,
    invalidate: () => setRevision((value) => value + 1),
    reset: () => {
      setBootstrapCatalog(undefined);
      setRevision(0);
    },
    entries: selectedState.key === catalogKey ? selectedState.entries : {},
    refreshing,
    stale,
    refresh: () => {
      if (bootstrap)
        setBootstrapCatalog({ connectionId: selectedConnection, source });
      setRevision((value) => value + 1);
    },
  };
}
