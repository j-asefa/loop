import { ActivityRecords } from "./ActivityRecords";
import type { ActivityRecord } from "../shared/agent-activities";
import { useEffect, useRef, useState } from "react";
import { FolderSearch, Info, TerminalSquare } from "lucide-react";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import {
  useProjectionRoute,
  useSourceRoute,
  useSourceId,
} from "./SourceContext";
import { readRoute } from "./workspace-api";
import { storedCommandAt } from "./pendingCommandStorage";
import { CollectionReadNotice, useCollectionRead } from "./CollectionRead";
import { Sheet, RichText } from "./components";
import {
  SettingsList,
  SettingsNote,
  SettingsPill,
  SettingsRow,
  SettingsSegmented,
} from "./SettingsUI";
export function NativeHistory({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const read = useProjectionRoute(),
    call = useSourceRoute();
  const sourceId = useSourceId();
  const recovery = useCollectionRead(sourceId);
  const lastList = useRef({ discover: false, cursor: "" });
  const [data, setData] = useState<
      RouteResponse<typeof workspaceApi.nativeHistoryList>
    >({ managed: [], external: [], next: null }),
    [source, setSource] = useState<"managed" | "external">("managed"),
    [selected, setSelected] = useState<
      RouteResponse<
        typeof workspaceApi.nativeHistoryList
      >["external"][number] & { note: string }
    >(),
    [activities, setActivities] = useState<ActivityRecord[]>([]),
    [items, setItems] = useState<
      RouteResponse<typeof workspaceApi.nativeHistoryDetail>["items"]
    >([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const selection = useRef(0);
  useEffect(
    () => () => {
      selection.current++;
    },
    [],
  );
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
              disabled={busy || recovery.busy}
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
                onClick={async () => {
                  const ticket = ++selection.current;
                  setBusy(true);
                  setError("");
                  try {
                    const r = await read(workspaceApi.nativeHistoryDetail, {
                      params: { id: c.id },
                    });
                    if (ticket !== selection.current) return;
                    setSelected({ ...c, note: r.note });
                    setItems(r.items);
                    setActivities(r.activities.map((a) => a.record));
                  } catch (e) {
                    if (ticket === selection.current)
                      setError((e as Error).message);
                  } finally {
                    if (ticket === selection.current) setBusy(false);
                  }
                }}
              />
            ))}
          </SettingsList>
        </>
      )}
      {source === "external" && data.next && (
        <button
          className="secondary"
          disabled={busy || recovery.busy}
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
            disabled={busy}
            className="primary"
            onClick={async () => {
              setBusy(true);
              setError("");
              const key = "loop-fork-" + selected.id;
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
                  body: { commandId },
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
