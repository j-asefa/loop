import { useEffect, useId, useRef, useState } from "react";
import { Webhook } from "lucide-react";
import { callRoute, readRoute } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import {
  webhookRequest,
  type WebhookSubscription,
  type WebhookDelivery,
} from "../shared/webhooks";
import {
  SettingsCommand,
  SettingsEmpty,
  SettingsList,
  SettingsNote,
  SettingsPill,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "./SettingsUI";
import { viewGeneration, viewOwner } from "./viewCache";
import { literalEntry } from "./textEntry";

type Creation = ReturnType<typeof webhookRequest>;
type Operation = "test" | "retry" | "revoke" | "update";
type Receipt = { request_id: string; kinds?: "run.stopped"[] };
// Retain uncertain actions across closing Settings, within one session only.
// Each instance captures its generation's maps, so late completions cannot
// mutate a later session. Secrets never enter persistent browser storage.
let retained: {
  generation: number;
  creations: Map<string, Creation>;
  operations: Map<string, Map<string, Receipt>>;
};
export function Webhooks({
  owner,
  sourceId,
}: {
  owner: string;
  sourceId: string;
}) {
  const key = JSON.stringify([owner, sourceId]);
  const [{ generation, creations, operations }] = useState(() => {
    const generation = viewGeneration();
    if (retained?.generation !== generation) {
      retained?.creations.clear();
      retained?.operations.clear();
      retained = { generation, creations: new Map(), operations: new Map() };
    }
    return retained;
  });
  const draft = useRef(creations.get(key));
  const receipts = useRef(operations.get(key) || new Map<string, Receipt>());
  const alive = useRef(true),
    reads = useRef(new AbortController()),
    ticket = useRef(0),
    historyTicket = useRef(0),
    historyId = useRef<string | undefined>(undefined);
  const [items, setItems] = useState<WebhookSubscription[]>([]);
  const [policy, setPolicy] = useState<{ local_receivers: boolean }>();
  const [url, setUrl] = useState(draft.current?.url || "");
  const [enabled, setEnabled] = useState(
    draft.current?.kinds.includes("run.stopped") ?? true,
  );
  const [secret, setSecret] = useState<{ id: string; value: string }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [history, setHistory] = useState<{
    id: string;
    rows: WebhookDelivery[];
  }>();
  const urlId = useId();
  const current = () =>
    alive.current && viewOwner() === owner && viewGeneration() === generation;
  const load = async () => {
    const request = ++ticket.current;
    try {
      const value = await readRoute(
        workspaceApi.webhooks,
        {},
        sourceId,
        reads.current.signal,
        undefined,
        "manual",
      );
      if (!current() || request !== ticket.current) return;
      setItems(value.subscriptions);
      setPolicy(value.policy);
      setUnavailable(false);
      const receipt = draft.current;
      const found =
        receipt &&
        value.subscriptions.find((row) => row.id === receipt.request_id);
      if (receipt && found) {
        if (found.state !== "revoked")
          setSecret({ id: found.id, value: receipt.secret });
        draft.current = undefined;
        creations.delete(key);
        setUrl("");
        setError("");
      }
    } catch (error) {
      if (current() && request === ticket.current) {
        setUnavailable((error as { status?: number }).status === 404);
        setError((error as Error).message);
      }
    }
  };
  const historyFor = async (id: string) => {
    const request = ++historyTicket.current;
    historyId.current = id;
    const rows = await readRoute(
      workspaceApi.webhookDeliveries,
      { params: { id } },
      sourceId,
      reads.current.signal,
      undefined,
      "manual",
    );
    if (current() && request === historyTicket.current)
      setHistory({ id, rows });
  };
  useEffect(() => {
    alive.current = true;
    reads.current = new AbortController();
    void load();
    const refresh = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load();
      if (historyId.current) void historyFor(historyId.current).catch(() => {});
    }, 10000);
    return () => {
      clearInterval(refresh);
      alive.current = false;
      ticket.current++;
      historyTicket.current++;
      reads.current.abort();
      if (viewOwner() !== owner || viewGeneration() !== generation) {
        creations.delete(key);
        operations.delete(key);
      }
    };
  }, []);
  async function act(
    item: WebhookSubscription,
    action: Operation,
    kinds?: "run.stopped"[],
  ) {
    if (busy || !current()) return;
    const receiptKey = item.id + ":" + action;
    let receipt = receipts.current.get(receiptKey) || {
      request_id: crypto.randomUUID(),
      ...(kinds ? { kinds } : {}),
    };
    receipts.current.set(receiptKey, receipt);
    operations.set(key, receipts.current);
    const forget = () => {
      if (receipts.current.get(receiptKey) === receipt)
        receipts.current.delete(receiptKey);
    };
    setBusy(true);
    setError("");
    try {
      if (action === "update") {
        const updated = await callRoute(
          workspaceApi.webhookUpdate,
          {
            params: { id: item.id },
            body: { request_id: receipt.request_id, kinds: receipt.kinds! },
          },
          sourceId,
        );
        // A recovered request acknowledges its original payload. If the user
        // chose a different value, apply that intent under a new identity only
        // after recovery completes, while the same session still owns the view.
        if (
          current() &&
          updated.kinds.includes("run.stopped") !==
            kinds!.includes("run.stopped")
        ) {
          receipt = { request_id: crypto.randomUUID(), kinds };
          receipts.current.set(receiptKey, receipt);
          await callRoute(
            workspaceApi.webhookUpdate,
            {
              params: { id: item.id },
              body: { request_id: receipt.request_id, kinds: receipt.kinds! },
            },
            sourceId,
          );
        }
      } else if (action === "test")
        await callRoute(
          workspaceApi.webhookTest,
          { params: { id: item.id }, body: { request_id: receipt.request_id } },
          sourceId,
        );
      else if (action === "retry")
        await callRoute(
          workspaceApi.webhookRetry,
          { params: { id: item.id }, body: { request_id: receipt.request_id } },
          sourceId,
        );
      else
        await callRoute(
          workspaceApi.webhookRevoke,
          { params: { id: item.id }, body: { request_id: receipt.request_id } },
          sourceId,
        );
      forget();
      if (current()) {
        if (action === "revoke" && secret?.id === item.id) setSecret(undefined);
        await load();
        await historyFor(item.id);
      }
    } catch (error) {
      const status = (error as { status?: number }).status || 0;
      if (status >= 400 && status < 500 && ![408, 429].includes(status))
        forget();
      if (current())
        setError(
          (error as Error).message +
            (receipts.current.has(receiptKey)
              ? " Retry this action to recover the same request."
              : ""),
        );
    } finally {
      if (current()) setBusy(false);
    }
  }
  if (unavailable)
    return (
      <SettingsNote title="Webhooks unavailable">
        Webhook management is unavailable on this source. Open its local
        workspace or retry when it reconnects.
        <button
          type="button"
          onClick={() => {
            setError("");
            void load();
          }}
        >
          Refresh receivers
        </button>
      </SettingsNote>
    );
  return (
    <>
      <SettingsSection title="Webhooks">
        <p>
          Send a signed notification when a run finishes, pauses, fails, is
          cancelled or needs your input.
        </p>
        {policy && (
          <SettingsNote>
            {policy.local_receivers
              ? "This companion accepts local HTTP receivers on any port. Public receivers require HTTPS. Link-local addresses and URLs containing credentials are refused."
              : "This server accepts public HTTPS receivers on port 443. Private networks, loopback addresses and URLs containing credentials are refused."}
          </SettingsNote>
        )}
        {error && (
          <SettingsNote tone="attention" role="alert">
            {error}
          </SettingsNote>
        )}
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || !current()) return;
            const receipt =
              draft.current ||
              webhookRequest(url, enabled ? ["run.stopped"] : []);
            draft.current = receipt;
            creations.set(key, receipt);
            setSecret(undefined);
            setBusy(true);
            setError("");
            try {
              const value = await callRoute(
                workspaceApi.webhookCreate,
                { body: receipt },
                sourceId,
              );
              if (current()) {
                draft.current = undefined;
                creations.delete(key);
                setUrl("");
                if (value.subscription.state !== "revoked")
                  setSecret({ id: value.subscription.id, value: value.secret });
                await load();
              }
            } catch (error) {
              const status = (error as { status?: number }).status || 0;
              if (
                status >= 400 &&
                status < 500 &&
                ![408, 429].includes(status)
              ) {
                draft.current = undefined;
                if (creations.get(key) === receipt) creations.delete(key);
              }
              if (current()) {
                setError(
                  (error as Error).message +
                    (draft.current
                      ? " Retry uses the same receiver and activation ping."
                      : ""),
                );
                await load();
              }
            } finally {
              if (current()) setBusy(false);
            }
          }}
        >
          <label htmlFor={urlId}>Receiver URL</label>
          <input
            {...literalEntry}
            id={urlId}
            type="url"
            required
            value={url}
            maxLength={2048}
            disabled={busy || !!draft.current || !policy}
            placeholder={
              policy?.local_receivers
                ? "http://localhost:8080/loop"
                : "https://example.com/loop"
            }
            onChange={(event) => setUrl(event.target.value)}
          />
          <SettingsToggle
            title="Run stopped"
            description="Finished, failed, cancelled, interrupted, paused or needs input."
            checked={enabled}
            disabled={busy || !!draft.current}
            onChange={setEnabled}
          />
          <button type="submit" disabled={busy || !url.trim() || !policy}>
            {busy
              ? "Saving…"
              : draft.current
                ? "Retry receiver creation"
                : "Add receiver"}
          </button>
        </form>
        {secret && (
          <>
            <SettingsNote title="Copy the signing secret now">
              Use this secret to verify delivery signatures. Loop shows it only
              during creation.
            </SettingsNote>
            <SettingsCommand
              title="Webhook signing secret"
              command={secret.value}
              copyLabel="Copy signing secret"
            />
            <button type="button" onClick={() => setSecret(undefined)}>
              Hide signing secret
            </button>
          </>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setError("");
            void load();
          }}
        >
          Refresh receivers
        </button>
      </SettingsSection>
      <SettingsSection title="Your receivers">
        {!policy ? (
          <p role="status">Loading receivers…</p>
        ) : !items.length ? (
          <SettingsEmpty icon={Webhook} title="No webhook receivers">
            Add a receiver to get run notifications.
          </SettingsEmpty>
        ) : (
          <SettingsList label="Webhook receivers">
            {items.map((item) => (
              <div key={item.id}>
                <SettingsRow
                  icon={Webhook}
                  title={item.url}
                  wrap
                  state={
                    <SettingsPill
                      tone={
                        item.state === "active"
                          ? "ready"
                          : item.state === "revoked"
                            ? "muted"
                            : "attention"
                      }
                    >
                      {item.state === "pending_activation"
                        ? "Pending activation"
                        : item.state}
                    </SettingsPill>
                  }
                  description={
                    <>
                      {item.local ? "Local receiver" : "Public HTTPS receiver"}
                      {item.state === "pending_activation" && (
                        <> · Ping attempts: {item.activation?.attempts ?? 0}</>
                      )}
                      {item.state === "failed" && (
                        <> · Failed delivery: {item.last_attempts} attempts</>
                      )}
                      {item.last_error && (
                        <>
                          <br />
                          {item.last_error}
                        </>
                      )}
                      {item.activation?.exhausted &&
                        item.state === "pending_activation" && (
                          <>
                            <br />
                            Activation retries exhausted. Retry sends the same
                            ping.
                          </>
                        )}
                    </>
                  }
                />
                {item.state !== "revoked" && (
                  <>
                    <SettingsToggle
                      title="Run stopped"
                      checked={item.kinds.includes("run.stopped")}
                      disabled={busy}
                      description="Changes apply to future stops; queued deliveries remain recorded."
                      onChange={(checked) =>
                        void act(item, "update", checked ? ["run.stopped"] : [])
                      }
                    />
                    {item.state !== "pending_activation" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(item, "test")}
                      >
                        Test receiver
                      </button>
                    )}
                    {(item.state === "pending_activation" ||
                      item.state === "failed") && (
                      <button
                        type="button"
                        disabled={busy || !!item.activation?.in_flight}
                        onClick={() => void act(item, "retry")}
                      >
                        Retry deliveries
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act(item, "revoke")}
                    >
                      Revoke receiver
                    </button>
                  </>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void historyFor(item.id).catch((error) => {
                      if (current()) setError((error as Error).message);
                    });
                  }}
                >
                  Recent deliveries
                </button>
                {history?.id === item.id && (
                  <ul aria-label="Recent webhook deliveries">
                    {history.rows.map((row) => (
                      <li key={row.id}>
                        <strong>
                          {row.kind === "control"
                            ? row.purpose === "activation"
                              ? "Activation ping"
                              : "Test ping"
                            : "Run stopped"}
                        </strong>
                        {" · "}
                        Last outcome: {row.outcome}
                        {row.in_flight ? " (in flight)" : ""}
                        {" · "}
                        {row.attempts} attempts
                        {row.last_status !== null
                          ? " · HTTP " + row.last_status
                          : ""}
                        {row.last_error && <p>{row.last_error}</p>}
                        <div>
                          Delivery <code>{row.id}</code>
                        </div>
                        {!row.delivered_at &&
                          !row.exhausted &&
                          !row.in_flight && (
                            <small>
                              {item.state === "failed" &&
                              row.kind === "run.stopped"
                                ? "Paused until you retry deliveries"
                                : "Next attempt after " +
                                  new Date(row.available_at).toLocaleString()}
                            </small>
                          )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </SettingsList>
        )}
      </SettingsSection>
    </>
  );
}
