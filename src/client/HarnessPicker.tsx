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
};
type Catalog = {
  available: boolean;
  runtime?: string;
  commands: Command[];
  message?: string;
};
export function HarnessPicker({
  agentId,
  value,
  onChange,
  focusInput,
}: {
  agentId?: string;
  value: string;
  onChange: (value: string) => void;
  focusInput: () => void;
}) {
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
  }, [agentId]);
  useEffect(() => {
    if (agentId && ["/", "$"].includes(value)) {
      setQuery("");
      setOpen(true);
    }
  }, [value, agentId]);
  useEffect(() => {
    const current = ++generation.current;
    if (!open || !agentId) return;
    setCatalog(null);
    setError("");
    void api<Catalog>(`/agents/${agentId}/harness`)
      .then((result) => {
        if (current === generation.current) setCatalog(result);
      })
      .catch((e) => {
        if (current === generation.current) setError(e.message);
      });
    return () => {
      generation.current++;
    };
  }, [open, agentId, revision]);
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
        className="text-button harness-trigger"
        disabled={!agentId}
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
      >
        Commands & skills
      </button>
      {open && (
        <Sheet title="Commands & skills" onClose={close}>
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
          {error ? (
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
                matches.map((command, index) => (
                  <button
                    type="button"
                    key={command.token + index}
                    className="harness-option"
                    disabled={!!command.disabledReason}
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
                    <span>{command.disabledReason || command.description}</span>
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
