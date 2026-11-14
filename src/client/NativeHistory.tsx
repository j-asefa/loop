import { ExecutionCommandId } from "../shared/contract-ids.js";
import { ActivityRecords } from "./ActivityRecords";
import { useEffect, useRef, useState } from "react";
import { FolderSearch, Info, TerminalSquare } from "lucide-react";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { useSourceRoute, useSourceId } from "./SourceContext";
import { readRoute } from "./api";
import { commandStorageKey, storedCommandAt } from "./pendingCommandStorage";
import { viewOwner, viewGeneration } from "./viewCache";
import {
  CollectionReadNotice,
  useCollectionRead,
  useProjectionQuery,
} from "./CollectionRead";
import { Sheet, RichText } from "./components";
import {
  SettingsList,
  SettingsNote,
  SettingsPill,
  SettingsRow,
  SettingsSegmented,
} from "./SettingsUI";
type NativeHistoryProps = { onClose: () => void; onOpen: (id: string) => void };
export function NativeHistory(props: NativeHistoryProps) {
  const source = useSourceId();
  return (
    <NativeHistoryView
      key={JSON.stringify([viewGeneration(), source])}
      {...props}
    />
  );
}
function NativeHistoryView({ onClose, onOpen }: NativeHistoryProps) {
  const call = useSourceRoute(),
    sourceId = useSourceId();
  const recovery = useCollectionRead(sourceId);
  const lastList = useRef({ discover: false, cursor: "" });
  const [data, setData] = useState<
      RouteResponse<typeof workspaceApi.nativeHistoryList>
    >({ managed: [], external: [], next: null }),
    [source, setSource] = useState<"managed" | "external">("managed"),
    [externalSelection, setExternalSelection] =
      useState<
        RouteResponse<typeof workspaceApi.nativeHistoryList>["external"][number]
      >(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const detailsRead = useProjectionQuery(
    workspaceApi.nativeHistoryDetail,
    externalSelection ? { params: { id: externalSelection.id } } : undefined,
    { source: sourceId },
  );
  const selected =
    externalSelection && detailsRead.data
      ? { ...externalSelection, note: detailsRead.data.note }
      : undefined;
  const items = detailsRead.data?.items ?? [];
  const activities =
    detailsRead.data?.activities.map((activity) => activity.record) ?? [];
  async function load(discover = false, cursor = "", manual = false) {
    lastList.current = { discover, cursor };
    await recovery.load(
      (signal, mode) =>
        readRoute(
          workspaceApi.nativeHistoryList,
          {
            query: discover ? { discover: "1", cursor } : {},
          },
          sourceId,
          signal,
          undefined,
          mode,
        ),
      (r) =>
        setData((old) => ({
          ...r,
          external: cursor ? [...old.external, ...r.external] : r.external,
        })),
      manual,
    );
  }
  useEffect(() => {
    setData({ managed: [], external: [], next: null });
    void load();
  }, [recovery.load, sourceId]);
  return (
    <Sheet title="Native conversations" onClose={onClose}>
      <p className="settings-intro">Threads that keep their harness context.</p>
      <CollectionReadNotice
        {...recovery}
        retry={() =>
          void load(lastList.current.discover, lastList.current.cursor, true)
        }
      />
      <CollectionReadNotice
        error={detailsRead.error && "Native conversation: " + detailsRead.error}
        busy={detailsRead.busy}
        retry={detailsRead.retry}
      />
      {detailsRead.loading && <p role="status">Loading native conversation…</p>}
      <SettingsSegmented
        label="History source"
        value={source}
        onChange={setSource}
        options={[
          { id: "managed", label: "Managed by Loop" },
          { id: "external", label: "Other Codex" },
        ]}
      />
      {source === "managed" ? (
        <SettingsList>
          {data.managed.map((c) => (
            <SettingsRow
              key={c.id}
              icon={TerminalSquare}
              title={c.title}
              description={`${c.harness} · ${c.project}`}
              state={
                <SettingsPill
                  tone={
                    c.state === "running"
                      ? "attention"
                      : c.state === "completed"
                        ? "ready"
                        : "muted"
                  }
                >
                  {c.state[0].toUpperCase() + c.state.slice(1)}
                </SettingsPill>
              }
              onClick={() => onOpen(c.id)}
            />
          ))}
        </SettingsList>
      ) : (
        <>
          <SettingsList>
            <SettingsRow
              icon={FolderSearch}
              title="Discover Codex history"
              description="Saved threads in other directories"
              disabled={busy || recovery.busy || detailsRead.busy}
              onClick={() => void load(true)}
            />
          </SettingsList>
          <SettingsNote icon={Info} title="Read or fork only">
            Loop cannot take over a session another process is running. Pi,
            Claude and OpenCode currently expose Loop-managed history here.
          </SettingsNote>
          <SettingsList>
            {data.external.map((c) => (
              <SettingsRow
                key={c.id}
                icon={TerminalSquare}
                title={c.title}
                description={c.project}
                onClick={() => {
                  setError("");
                  if (externalSelection?.id === c.id)
                    void detailsRead.refresh(true);
                  else setExternalSelection(c);
                }}
              />
            ))}
          </SettingsList>
        </>
      )}
      {source === "external" && data.next && (
        <button
          className="secondary"
          disabled={busy || recovery.busy || detailsRead.busy}
          onClick={() => void load(true, data.next || "")}
        >
          Load more
        </button>
      )}
      {selected && (
        <section className="native-decision">
          <h3>{selected.title}</h3>
          <p className="note">{selected.note}</p>
          {items.map((item) => (
            <article key={item.id}>
              <strong>{item.kind}</strong>
              <RichText content={item.text} />
            </article>
          ))}
          <ActivityRecords records={activities} />
          <button
            disabled={busy || detailsRead.busy}
            className="primary"
            onClick={async () => {
              setBusy(true);
              setError("");
              const key = commandStorageKey(viewOwner(), sourceId, [
                "native-history-fork",
                selected.id,
              ]);
              const receipt = storedCommandAt(
                sessionStorage,
                key,
                (raw) => raw,
                (value) => value,
              );
              let commandId = receipt.read();
              if (!commandId) {
                commandId = crypto.randomUUID();
                receipt.write(commandId);
              }
              try {
                const r = await call(workspaceApi.nativeHistoryFork, {
                  params: { id: selected.id },
                  body: { commandId: ExecutionCommandId.parse(commandId) },
                });
                receipt.remove();
                onOpen(r.id);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Fork into a new Loop conversation
          </button>
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
