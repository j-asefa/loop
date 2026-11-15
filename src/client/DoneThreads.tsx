import { DoneThreadId } from "../shared/contract-ids.js";
import { proseEntry } from "./textEntry";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCollectionRead } from "./CollectionRead";
import { createReadExecutor } from "./read-executor";
import { performStoredEffect, creationFailureSettled } from "./pendingCommands";
import {
  ArrowRight,
  ChevronRight,
  Layers,
  FolderInput,
  Link2,
  LoaderCircle,
} from "lucide-react";
import type {
  DoneThreadSummary,
  DoneThreadDetail,
  DoneThreadQuery,
} from "../shared/done-threads";
import { workspaceApi } from "../shared/workspace-api";
import { contractDoneThreadReader } from "../shared/done-thread-client";
import { callRoute, readRoute } from "./api";
import { Sheet } from "./components";
import { CardBody } from "./ContentCard";
import { SourceProvider, useSourceCapabilities } from "./SourceContext";
import { cachedView, cacheView, viewOwner, viewGeneration } from "./viewCache";
import {
  listenWorkspaceChanges,
  workspaceChangeAffects,
} from "./workspace-changes";

export type SourcedDoneThread = DoneThreadSummary & { source: string };
export type ThreadSelection = {
  source: string;
  cardIds: string[];
  title: string;
  target?: string;
  previews: { title: string; author?: string }[];
};

export function useDoneThreads(
  sources: string[],
  enabled: boolean,
  query: DoneThreadQuery,
) {
  const selection = [
    query.project ?? null,
    query.agent ?? null,
    query.teams ?? null,
  ];
  const key = JSON.stringify([sources, selection]),
    generation = viewGeneration();
  const cacheKey = (source: string) =>
    "done-threads:" + JSON.stringify([source, selection]);
  const [threads, setThreads] = useState<SourcedDoneThread[]>([]);
  const [supported, setSupported] = useState<string[]>([]);
  const [error, setError] = useState("");
  const context = useMemo(
    () => ({ refresh: (_manual = false) => {} }),
    [key, enabled, generation],
  );
  const [loadedGeneration, setLoadedGeneration] = useState(generation);
  const [loadedKey, setLoadedKey] = useState(key);
  useEffect(() => {
    setSupported([]);
  }, [key, generation]);
  useEffect(() => {
    if (!enabled) {
      setThreads([]);
      return;
    }
    let active = true;
    const owner = viewOwner();
    const failures = new Set<string>();
    setLoadedGeneration(generation);
    setLoadedKey(key);
    setError("");
    setThreads(
      sources.flatMap(
        (source) => cachedView<SourcedDoneThread[]>(cacheKey(source)) ?? [],
      ),
    );
    const readers = new Map(
      [...new Set(sources)].map((source) => [
        source,
        createReadExecutor({
          current: () => active && generation === viewGeneration(),
          changed: (state) => {
            if (state.error) failures.add(source);
            else failures.delete(source);
            setError(
              failures.size
                ? "Couldn’t load card threads. Refresh to try again."
                : "",
            );
          },
        }),
      ]),
    );
    const refresh = (selected = sources, manual = false) => {
      for (const source of selected) {
        const executor = readers.get(source);
        if (!executor) continue;
        void executor.load(
          async (signal, mode) => {
            const reader = contractDoneThreadReader((contract, input) =>
              readRoute(contract, input, source, signal, undefined, mode),
            );
            try {
              return {
                supported: true,
                rows: await reader.list(query, signal),
              };
            } catch (error) {
              if ((error as { status?: number }).status === 404)
                return { supported: false, rows: [] };
              throw error;
            }
          },
          (result) => {
            const values = result.rows.map((thread) => ({ ...thread, source }));
            cacheView(cacheKey(source), values, owner);
            setThreads((previous) => [
              ...previous.filter((thread) => thread.source !== source),
              ...values,
            ]);
            setSupported((previous) =>
              result.supported
                ? previous.includes(source)
                  ? previous
                  : [...previous, source]
                : previous.filter((value) => value !== source),
            );
          },
          manual,
        );
      }
    };
    context.refresh = (manual = false) => refresh(sources, manual);
    const stop = listenWorkspaceChanges("feed", (event) =>
      refresh(
        sources.filter((source) =>
          workspaceChangeAffects(event, "feed", source),
        ),
      ),
    );
    const focus = () => refresh();
    window.addEventListener("focus", focus);
    refresh();
    return () => {
      active = false;
      for (const reader of readers.values()) reader.dispose();
      stop();
      window.removeEventListener("focus", focus);
    };
  }, [context]);
  return {
    threads:
      enabled && loadedGeneration === generation && loadedKey === key
        ? threads.filter((thread) => sources.includes(thread.source))
        : [],
    supported:
      enabled && loadedGeneration === generation && loadedKey === key
        ? supported.filter((source) => sources.includes(source))
        : [],
    error:
      enabled && loadedGeneration === generation && loadedKey === key
        ? error
        : "",
    refresh: () => context.refresh(),
    retry: () => context.refresh(true),
  };
}

export function OrganizeCards({
  selection,
  threads,
  onClose,
  onDone,
}: {
  selection: ThreadSelection;
  threads: SourcedDoneThread[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(selection.title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(viewGeneration());
  const live = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function move(target?: string) {
    if (busy.current || generation.current !== viewGeneration()) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      if (target)
        await callRoute(
          workspaceApi.doneThreadMove,
          {
            params: { id: DoneThreadId.parse(target) },
            body: { cardIds: selection.cardIds },
          },
          selection.source,
        );
      else {
        const body = { title: title.trim(), cardIds: selection.cardIds };
        await performStoredEffect(
          localStorage,
          viewOwner(),
          selection.source,
          ["done-thread-create", JSON.stringify(body)],
          () => live.current && generation.current === viewGeneration(),
          (id) =>
            callRoute(
              workspaceApi.doneThreadCreate,
              { body: { ...body, id: DoneThreadId.parse(id) } },
              selection.source,
            ),
          creationFailureSettled,
        );
      }
      if (generation.current !== viewGeneration()) return;
      if (live.current) {
        onDone();
        onClose();
      }
    } catch (error) {
      if (live.current && generation.current === viewGeneration())
        setError((error as Error).message);
    } finally {
      busy.current = false;
      if (live.current && generation.current === viewGeneration())
        setPending(false);
    }
  }
  const destinations = threads
    .filter(
      (thread) =>
        thread.source === selection.source &&
        !selection.cardIds.every((id) => thread.cardIds.includes(id)),
    )
    .sort(
      (a, b) =>
        Number(b.id === selection.target) - Number(a.id === selection.target),
    );
  return (
    <Sheet
      title="Move cards to a thread"
      className="action-sheet done-menu card-aggregation-sheet"
      onClose={onClose}
      heading={
        <div className="done-menu-heading">
          <span className="done-menu-eyebrow">
            <Layers size={13} />
            Organize cards
          </span>
          <h2>Bring cards together</h2>
          <p>Keep the conversation in Done and Threads.</p>
        </div>
      }
    >
      <div className="thread-selection-summary">
        <span className="thread-selection-count">
          {selection.cardIds.length}{" "}
          {selection.cardIds.length === 1 ? "card selected" : "cards selected"}
        </span>
        <div
          className="thread-selection-previews"
          aria-label="Selected card previews"
        >
          {selection.previews.slice(0, 2).map((preview, index) => (
            <div className="thread-selection-card" key={index}>
              <span className="thread-selection-mark" aria-hidden="true">
                <Layers size={15} />
              </span>
              <span>
                <small>
                  {preview.author ? `@${preview.author}` : "Done card"}
                </small>
                <strong>{preview.title}</strong>
              </span>
            </div>
          ))}
          {selection.previews.length > 2 && (
            <small className="thread-selection-more">
              +{selection.previews.length - 2} more selected
            </small>
          )}
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="thread-create-panel" aria-label="New thread">
        <div className="thread-create-heading">
          <span className="done-menu-icon">
            <Layers size={21} />
          </span>
          <span>
            <strong>Create a thread</strong>
            <small>A single card in your Done feed</small>
          </span>
        </div>
        <label className="done-thread-name">
          New thread name
          <input
            {...proseEntry}
            maxLength={200}
            value={title}
            disabled={pending}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div role="menu" aria-label="Card grouping options">
          <button
            className="thread-create-submit"
            role="menuitem"
            disabled={pending || selection.cardIds.length < 2 || !title.trim()}
            onClick={() => void move()}
          >
            Combine into a new thread
            {pending ? (
              <LoaderCircle
                size={18}
                className="thread-moving"
                aria-hidden="true"
              />
            ) : (
              <ArrowRight size={18} aria-hidden="true" />
            )}
          </button>
        </div>
        {selection.cardIds.length < 2 && (
          <p className="thread-create-hint">
            Select at least two cards to start a new thread.
          </p>
        )}
      </section>
      {!!destinations.length && (
        <section className="thread-destinations" aria-label="Existing threads">
          <span className="done-menu-section-label">Or add to a thread</span>
          <div role="menu" aria-label="Existing thread destinations">
            {destinations.map((thread) => (
              <button
                className={`done-menu-action${thread.id === selection.target ? " thread-drop-destination" : ""}`}
                role="menuitem"
                key={thread.id}
                aria-label={`Move to “${thread.title}”`}
                disabled={pending}
                onClick={() => void move(thread.id)}
              >
                <span className="done-menu-icon" aria-hidden="true">
                  <FolderInput size={20} />
                </span>
                <span className="done-menu-label">
                  <span>{thread.title}</span>
                  <small>{thread.cardIds.length} cards</small>
                </span>
                <ChevronRight
                  size={17}
                  className="done-menu-chevron"
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
        </section>
      )}
      {pending && (
        <p className="thread-create-hint" role="status">
          Moving cards…
        </p>
      )}
      <p className="done-menu-tip">
        <Link2 size={13} aria-hidden="true" />
        Original conversations stay intact.
      </p>
    </Sheet>
  );
}

export function DoneThreadReader({
  thread,
  onClose,
  onOpen,
  onChanged,
}: {
  thread: SourcedDoneThread;
  onClose: () => void;
  onOpen: (
    conversation: string,
    message: string | undefined,
    source: string,
  ) => void;
  onChanged: () => void;
}) {
  const capabilities = useSourceCapabilities();
  const readKey = JSON.stringify([thread.source, thread.id, viewGeneration()]);
  const { load, error: readError } = useCollectionRead(readKey);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    value: DoneThreadDetail | null;
  }>();
  const detail = snapshot?.key === readKey ? snapshot.value : null;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(viewGeneration());
  const live = useRef(true);
  const changing = useRef(false);
  const callbacks = useRef({ onClose, onChanged });
  callbacks.current = { onClose, onChanged };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const refresh = useCallback(
    (manual = false) => {
      setError("");
      return load(
        async (signal, mode) => {
          const reader = contractDoneThreadReader((contract, input) =>
            readRoute(contract, input, thread.source, signal, undefined, mode),
          );
          try {
            return await reader.detail(thread.id, signal);
          } catch (error) {
            if ((error as { status?: number }).status === 404) return null;
            throw error;
          }
        },
        (value) => {
          setSnapshot({ key: readKey, value });
          if (!value) {
            callbacks.current.onClose();
            callbacks.current.onChanged();
          }
        },
        manual,
      );
    },
    [load, readKey],
  );
  useEffect(() => {
    const update = () => void refresh();
    const stop = listenWorkspaceChanges("feed", update, thread.source);
    window.addEventListener("focus", update);
    return () => {
      stop();
      window.removeEventListener("focus", update);
    };
  }, [refresh]);
  useEffect(() => {
    void refresh();
  }, [refresh, revision]);
  async function remove(card: string) {
    if (changing.current || generation.current !== viewGeneration()) return;
    changing.current = true;
    setBusy(true);
    setError("");
    try {
      await callRoute(
        workspaceApi.doneThreadRemoveCard,
        { params: { id: thread.id, card } },
        thread.source,
      );
      if (generation.current !== viewGeneration()) return;
      onChanged();
      if (!live.current) return;
      if ((detail?.cards.length ?? 0) <= 2) onClose();
      else setRevision((value) => value + 1);
    } catch (error) {
      if (live.current && generation.current === viewGeneration())
        setError((error as Error).message);
    } finally {
      changing.current = false;
      if (live.current && generation.current === viewGeneration())
        setBusy(false);
    }
  }
  return (
    <SourceProvider sourceId={thread.source} capabilities={capabilities}>
      <Sheet
        title={thread.title}
        className="done-thread-sheet"
        wide
        onClose={onClose}
      >
        {(error || readError) && (
          <p className="error" role="alert">
            {error || readError}
            <button
              onClick={() => {
                setError("");
                void refresh(true);
              }}
            >
              Retry
            </button>
          </p>
        )}
        {!detail && !error && !readError && (
          <p role="status">Loading thread…</p>
        )}
        {detail?.cards.map((card) => (
          <article className="done-thread-message" key={card.id}>
            <p className="field-hint">
              {card.author.name || card.display.agent_name
                ? `@${card.author.name || card.display.agent_name}`
                : "Result"}{" "}
              · {new Date(card.created_at).toLocaleString()}
            </p>
            <h3>{card.display.title}</h3>
            <CardBody card={card} />
            <div className="card-actions">
              <button
                onClick={() => {
                  onClose();
                  onOpen(
                    card.source.conversation_id!,
                    card.source.message_id ?? undefined,
                    thread.source,
                  );
                }}
              >
                Open original conversation
              </button>
              <button disabled={busy} onClick={() => void remove(card.id)}>
                Remove from thread
              </button>
            </div>
          </article>
        ))}
      </Sheet>
    </SourceProvider>
  );
}
