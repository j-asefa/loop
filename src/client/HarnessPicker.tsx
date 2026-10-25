import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { listenWorkspaceChanges } from "./workspace-changes";
import { useSourceId, useSourceRoute } from "./SourceContext";
import { useEffect, useRef, useState } from "react";
import { Sheet } from "./components";

type Catalog = RouteResponse<typeof workspaceApi.agentHarness>;
type Snippet = RouteResponse<typeof workspaceApi.snippetList>["items"][number];
/**
 * A snippet's own name, or nothing when its title is just the start of its
 * text (as "Save as snippet" makes them), so the text isn't shown twice.
 */
function snippetName(snippet: Snippet) {
  const name = snippet.title.replace(/^(Snippet|Saved prompt): /, "").trim();
  const start = name.replace(/…$/, "").trim();
  const text = snippet.content.replace(/\s+/g, " ").trim();
  return !start || text.startsWith(start) ? "" : name;
}
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
  const route = useSourceRoute();
  const sourceId = useSourceId();
  const [snippets, setSnippets] = useState<Snippet[] | null>(null),
    [allSnippets, setAllSnippets] = useState(false);
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
    route(workspaceApi.snippetList, {})
      .then((result) => active && setSnippets(result.items))
      .catch(() => active && setSnippets([]));
    return () => {
      active = false;
    };
  }, [open]);
  useEffect(() => {
    if (value === "/" || (agentId && value === "$")) {
      setQuery("");
      setAllSnippets(false);
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
        const result = await route(workspaceApi.agentHarness, { params: { id: agentId }, query: { conversation: conversationId || undefined } });
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
    const stopChanges = listenWorkspaceChanges("activities", update, sourceId, conversationId);
    return () => {
      generation.current++;
      clearInterval(timer);
      stopChanges();
    };
  }, [open, agentId, conversationId, revision, sourceId]);
  function close() {
    setOpen(false);
    requestAnimationFrame(focusInput);
  }
  const matches =
    catalog?.commands.filter((c) =>
      `${c.token} ${c.description}`.toLowerCase().includes(query.toLowerCase()),
    ) || [];
  // Snippets follow the commands, one line each. A few show until you search
  // or ask for all of them.
  const matchingSnippets = (snippets || []).filter((snippet) =>
    `${snippet.title} ${snippet.content}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const shownSnippets =
    query || allSnippets ? matchingSnippets : matchingSnippets.slice(0, 3);
  return (
    <>
      <button
        type="button"
        className={"text-button harness-trigger" + (compact ? " compact" : "")}
        aria-label="Commands & skills"
        title="Commands, skills and snippets (type /)"
        onClick={() => {
          setQuery("");
          setAllSnippets(false);
          setOpen(true);
        }}
      >
        {compact ? "/" : "Commands & skills"}
      </button>
      {open && (
        <Sheet title="Commands & skills" onClose={close}>
          <input
            className="picker-search"
            aria-label="Search commands and skills"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            placeholder="Search commands, skills and snippets"
          />
          <p className="picker-source">
            {catalog?.runtime
              ? `From this agent’s ${catalog.runtime} machine. Choose one, add your instructions, then send.`
              : "Commands come from this agent’s runtime."}
          </p>
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
          ) : matches.length ? (
            <div className="harness-options">
              {matches.map((command) => (
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
                  <span className="harness-option-head">
                    <strong>{command.token}</strong>{" "}
                    <small>{command.kind}</small>
                  </span>
                  <span className="harness-option-text">
                    {command.disabledReason ||
                      command.reason ||
                      command.description}
                    {command.argumentHint && (
                      <em> · {command.argumentHint}</em>
                    )}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="note">
              {catalog.commands.length
                ? "No matching commands."
                : "No commands or skills were discovered on this machine."}
            </p>
          )}
          {!!matchingSnippets.length && (
            <section className="snippet-options" aria-label="Your snippets">
              <h3 className="section-title">Snippets</h3>
              <div className="harness-options">
                {shownSnippets.map((snippet) => {
                  const name = snippetName(snippet);
                  return (
                    <button
                      type="button"
                      key={snippet.id}
                      className="harness-option snippet-option"
                      onClick={() => {
                        const rest = value.replace(/^\s*\/\s*$/, "");
                        onChange(
                          rest ? `${rest}\n${snippet.content}` : snippet.content,
                        );
                        close();
                      }}
                    >
                      {name && <strong>{name}</strong>}
                      <span
                        className={
                          "harness-option-text" + (name ? "" : " unnamed")
                        }
                      >
                        {snippet.content}
                      </span>
                    </button>
                  );
                })}
              </div>
              {shownSnippets.length < matchingSnippets.length && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setAllSnippets(true)}
                >
                  Show all {matchingSnippets.length} snippets
                </button>
              )}
            </section>
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
