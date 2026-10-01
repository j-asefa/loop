import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Sheet } from "./components";

type Command = {
  name: string;
  token: string;
  kind: string;
  description: string;
  argumentHint?: string;
  disabledReason?: string;
  available?: boolean;
  reason?: string;
};
type Catalog = {
  available: boolean;
  revision?: number;
  generation?: string;
  runtime?: string;
  commands: Command[];
  message?: string;
};
type Snippet = { id: string; title: string; content: string };
export function HarnessPicker({
  agentId,
  conversationId,
  value,
  onChange,
  focusInput,
  compact = false,
}: {
  agentId?: string;
  conversationId?: string;
  value: string;
  onChange: (value: string) => void;
  focusInput: () => void;
  compact?: boolean;
}) {
  const [snippets, setSnippets] = useState<Snippet[] | null>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    setOpen(false);
    setCatalog(null);
    setError("");
  }, [agentId, conversationId]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    api<{ items: Snippet[] }>("/snippets")
      .then((result) => active && setSnippets(result.items))
      .catch(() => active && setSnippets([]));
    return () => {
      active = false;
    };
  }, [open]);
  useEffect(() => {
    if (value === "/" || (agentId && value === "$")) {
      setQuery("");
      setOpen(true);
    }
  }, [value, agentId]);
  useEffect(() => {
    const current = ++generation.current;
    if (!open || !agentId) {
      setCatalog(null);
      return;
    }
    let request = 0;
    setCatalog(null);
    setError("");
    const refresh = async () => {
      const own = ++request;
      try {
        const result = await api<Catalog>(
          `/agents/${agentId}/harness` +
            (conversationId
              ? "?conversation=" + encodeURIComponent(conversationId)
              : ""),
        );
        if (current === generation.current && own === request) {
          setCatalog((old) =>
            old &&
            old.generation !== undefined &&
            old.generation === result.generation &&
            (old.revision ?? -1) > (result.revision ?? -1)
              ? old
              : result,
          );
          setError("");
        }
      } catch (e) {
        if (current === generation.current && own === request) {
          setError((e as Error).message);
          setCatalog(null);
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    const update = () => void refresh();
    window.addEventListener("loop-workspace-change", update);
    return () => {
      generation.current++;
      clearInterval(timer);
      window.removeEventListener("loop-workspace-change", update);
    };
  }, [open, agentId, conversationId, revision]);
  function close() {
    setOpen(false);
    requestAnimationFrame(focusInput);
  }
  const matches =
    catalog?.commands.filter((c) =>
      `${c.token} ${c.description}`.toLowerCase().includes(query.toLowerCase()),
    ) || [];
  return (
    <>
      <button
        type="button"
        className={"text-button harness-trigger" + (compact ? " compact" : "")}
        aria-label="Commands & skills"
        title="Commands, skills and snippets (type /)"
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
      >
        {compact ? "/" : "Commands & skills"}
      </button>
      {open && (
        <Sheet title="Commands & skills" onClose={close}>
          {!!snippets?.length && (
            <section className="snippet-options" aria-label="Your snippets">
              <h3 className="section-title">Your snippets</h3>
              {snippets
                .filter((snippet) =>
                  `${snippet.title} ${snippet.content}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .slice(0, 8)
                .map((snippet) => (
                  <button
                    type="button"
                    key={snippet.id}
                    className="harness-option"
                    onClick={() => {
                      const rest = value.replace(/^\s*\/\s*$/, "");
                      onChange(rest ? `${rest}\n${snippet.content}` : snippet.content);
                      close();
                    }}
                  >
                    <strong>
                      {snippet.title.replace(/^(Snippet|Saved prompt): /, "")}{" "}
                      <small>snippet</small>
                    </strong>
                    <span>{snippet.content.slice(0, 140)}</span>
                  </button>
                ))}
            </section>
          )}
          <p className="note">
            {catalog?.runtime
              ? `Available on this agent’s ${catalog.runtime} machine.`
              : "Discover commands from this agent’s runtime."}{" "}
            Choose one, add your instructions, then send.
          </p>
          <label>
            Search commands
            <input
              aria-label="Search commands and skills"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              placeholder="Search by name or description"
            />
          </label>
          {!agentId ? (
            <p className="note">Choose an agent to see its commands.</p>
          ) : error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : !catalog ? (
            <p role="status">Loading from the runtime…</p>
          ) : !catalog.available ? (
            <p className="note">{catalog.message}</p>
          ) : (
            <div className="harness-options">
              {matches.length ? (
                matches.map((command) => (
                  <button
                    type="button"
                    key={command.kind + ":" + command.token}
                    className="harness-option"
                    disabled={
                      !!command.disabledReason || command.available === false
                    }
                    onClick={() => {
                      const rest = value.replace(
                        /^\s*[/\$][\w.:-]*(?:\s+|$)/,
                        "",
                      );
                      onChange(`${command.token} ${rest}`);
                      close();
                    }}
                  >
                    <strong>
                      {command.token} <small>{command.kind}</small>
                    </strong>
                    <span>
                      {command.disabledReason ||
                        command.reason ||
                        command.description}
                    </span>
                    {command.argumentHint && (
                      <small>{command.argumentHint}</small>
                    )}
                  </button>
                ))
              ) : (
                <p className="note">
                  {catalog.commands.length
                    ? "No matching commands."
                    : "No commands or skills were discovered on this machine."}
                </p>
              )}
            </div>
          )}
          <button
            type="button"
            className="text-button"
            onClick={() => setRevision((r) => r + 1)}
          >
            Refresh from machine
          </button>
        </Sheet>
      )}
    </>
  );
}
