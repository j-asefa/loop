import { ActivityRecords } from "./ActivityRecords";
import type { ActivityRecord } from "../agent-activities";
import { useEffect, useRef, useState } from "react";
import { api, parse } from "./api";
import { Sheet, RichText } from "./components";
export function NativeHistory({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<any>({ managed: [], external: [] }),
    [selected, setSelected] = useState<any>(),
    [activities, setActivities] = useState<ActivityRecord[]>([]),
    [items, setItems] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const selection = useRef(0);
  useEffect(
    () => () => {
      selection.current++;
    },
    [],
  );
  async function load(discover = false, cursor = "") {
    setBusy(true);
    setError("");
    try {
      const r = await api(
        "/native/history" +
          (discover ? "?discover=1&cursor=" + encodeURIComponent(cursor) : ""),
      );
      setData((old: any) => ({
        ...r,
        external: cursor ? [...old.external, ...r.external] : r.external,
      }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <Sheet title="Native conversations" onClose={onClose}>
      <p>
        Your Loop conversations keep their native context. Open a saved
        conversation to send a follow-up.
      </p>
      <h3>Managed by Loop</h3>
      {data.managed.map((c: any) => (
        <button
          className="project-agent"
          key={c.id}
          onClick={() => onOpen(c.id)}
        >
          <span>
            <strong>{c.title}</strong>
            <small>
              {c.harness} · {c.project} · {c.state}
            </small>
          </span>
        </button>
      ))}
      <h3>Other native Codex history</h3>
      <p className="note">
        Discover saved threads across directories. External live sessions can be
        read or forked; Loop cannot take over their running process. Pi, Claude
        and OpenCode currently expose Loop-managed history here.
      </p>
      <button disabled={busy} onClick={() => void load(true)}>
        Discover Codex history
      </button>
      {data.external.map((c: any) => (
        <button
          className="project-agent"
          key={c.id}
          onClick={async () => {
            const ticket = ++selection.current;
            setBusy(true);
            setError("");
            try {
              const r = await api(
                "/native/history/" + encodeURIComponent(c.id),
              );
              if (ticket !== selection.current) return;
              setSelected({ ...c, note: r.note });
              setItems(r.items);
              setActivities(
                (r.activities || []).map((a: any) => a.record || a),
              );
            } catch (e) {
              if (ticket === selection.current) setError((e as Error).message);
            } finally {
              if (ticket === selection.current) setBusy(false);
            }
          }}
        >
          <span>
            <strong>{c.title}</strong>
            <small>{c.project}</small>
          </span>
        </button>
      ))}
      {data.next && (
        <button disabled={busy} onClick={() => void load(true, data.next)}>
          Load more
        </button>
      )}
      {selected && (
        <section className="native-decision">
          <h3>{selected.title}</h3>
          <p className="note">{selected.note}</p>
          {items.map((item: any) => (
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
              let commandId = sessionStorage.getItem(key);
              if (!commandId) {
                commandId = crypto.randomUUID();
                sessionStorage.setItem(key, commandId);
              }
              try {
                const r = await api(
                  "/native/history/" + selected.id + "/fork",
                  { commandId },
                );
                sessionStorage.removeItem(key);
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
