import { proseEntry } from "./textEntry";
import { useEffect, useRef, useState } from "react";
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
import { callRoute, readRoute } from "./workspace-api";
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
  const [revision, setRevision] = useState(0);
  const [loadedGeneration, setLoadedGeneration] = useState(generation);
  const [loadedKey, setLoadedKey] = useState(key);
  const refresh = () => setRevision((value) => value + 1);
  useEffect(() => {
    setSupported([]);
  }, [key, generation]);
  useEffect(() => {
    if (!enabled) {
      setThreads([]);
      return;
    }
    const controller = new AbortController();
    const owner = viewOwner();
    setLoadedGeneration(generation);
    setLoadedKey(key);
    setError("");
    setThreads(
      sources.flatMap(
        (source) => cachedView<SourcedDoneThread[]>(cacheKey(source)) ?? [],
      ),
    );
    void Promise.all(
      sources.map(async (source) => {
        try {
          const reader = contractDoneThreadReader((contract, input, signal) =>
            readRoute(contract, input, source, signal ?? controller.signal),
          );
          const result = await reader.list(query, controller.signal);
          if (controller.signal.aborted || generation !== viewGeneration())
            return;
          const values = result.map((thread) => ({ ...thread, source }));
          cacheView(cacheKey(source), values, owner);
          setThreads((previous) => [
            ...previous.filter((thread) => thread.source !== source),
            ...values,
          ]);
          setSupported((previous) =>
            previous.includes(source) ? previous : [...previous, source],
          );
        } catch (error) {
          if (controller.signal.aborted || generation !== viewGeneration())
            return;
          if ((error as { status?: number }).status === 404) {
            cacheView(cacheKey(source), [], owner);
            setThreads((previous) =>
              previous.filter((thread) => thread.source !== source),
            );
            setSupported((previous) =>
              previous.filter((value) => value !== source),
            );
          } else setError("Couldn’t load card threads. Refresh to try again.");
        }
      }),
    );
    return () => controller.abort();
  }, [key, enabled, generation, revision]);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = listenWorkspaceChanges("feed", (event) => {
      if (
        !sources.some((source) => workspaceChangeAffects(event, "feed", source))
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(refresh, 250);
    });
    const focus = () => refresh();
    window.addEventListener("focus", focus);
    return () => {
      stop();
      clearTimeout(timer);
      window.removeEventListener("focus", focus);
    };
  }, [key, enabled, generation]);
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
    refresh,
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
  const id = useRef(crypto.randomUUID());
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
          { params: { id: target }, body: { cardIds: selection.cardIds } },
          selection.source,
        );
      else
        await callRoute(
          workspaceApi.doneThreadCreate,
          {
            body: {
              id: id.current,
              title: title.trim(),
              cardIds: selection.cardIds,
            },
          },
          selection.source,
        );
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
  const [detail, setDetail] = useState<DoneThreadDetail | null>(null);
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
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((value) => value + 1), 250);
    };
    const stop = listenWorkspaceChanges("feed", refresh, thread.source);
    window.addEventListener("focus", refresh);
    return () => {
      stop();
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [thread.id, thread.source]);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    const reader = contractDoneThreadReader((contract, input, signal) =>
      readRoute(contract, input, thread.source, signal ?? controller.signal),
    );
    void reader
      .detail(thread.id, controller.signal)
      .then((result) => {
        if (
          !controller.signal.aborted &&
          generation.current === viewGeneration()
        )
          setDetail(result);
      })
      .catch((error) => {
        if (
          !controller.signal.aborted &&
          generation.current === viewGeneration()
        ) {
          if (error.status === 404) {
            setDetail(null);
            callbacks.current.onClose();
            callbacks.current.onChanged();
          } else setError(error.message);
        }
      });
    return () => controller.abort();
  }, [thread.id, thread.source, revision]);
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
        {error && (
          <p className="error" role="alert">
            {error}
            <button
              onClick={() => {
                setError("");
                setRevision((value) => value + 1);
              }}
            >
              Retry
            </button>
          </p>
        )}
        {!detail && !error && <p role="status">Loading thread…</p>}
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
