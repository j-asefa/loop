import { useLayoutEffect, useId, useRef, useState } from "react";
import { literalEntry } from "./textEntry";
import type { AgentSource } from "./agentSources";
import {
  exportFleetCommand,
  fleetCommandsChanged,
  importFleetCommand,
  pendingFleetCommands,
  reconcileFleetCommand,
  type PendingFleetCommand,
} from "./fleetCommand";
import { viewGeneration, viewOwner } from "./viewCache";

const showReceipts = "loop-fleet-command-recovery";
export function showFleetCommandReceipts() {
  window.dispatchEvent(new Event(showReceipts));
}

const labels: Record<PendingFleetCommand["route"], string> = {
  agentCreate: "Create agent",
  agentUpdate: "Update agent",
  submit: "Send message",
  shareSend: "Send shared content",
  runAction: "Control run",
  approval: "Answer approval",
  nativeAnswer: "Answer question",
  setting: "Change session settings",
  resultUpdate: "Update result",
  conversationPosition: "Mark conversation position",
  feedUpdate: "Update Feed item",
  feedRead: "Mark Feed item read",
  replyState: "Update reply",
  messageSave: "Save message",
  messageUnsave: "Unsave message",
  savedLabel: "Label saved item",
  laterCreate: "Add reminder",
  laterFinish: "Finish reminder",
  laterSnooze: "Snooze reminder",
  laterReopen: "Reopen reminder",
  projectOpened: "Open project",
  scheduledSendCreate: "Schedule message",
  scheduledSendCancel: "Cancel scheduled message",
  scheduledSendUpdate: "Edit scheduled message",
  scheduledSendRetry: "Resume scheduled message",
  runReorder: "Reorder queued work",
  runUpdate: "Edit queued work",
  runWithdraw: "Withdraw queued work",
  runMove: "Move queued work",
  conversationFork: "Fork conversation",
  conversationContinue: "Continue conversation",
  conversationContinueStart: "Start continuation",
  folderCreate: "Create folder",
  folderUpdate: "Update folder",
  workspaceProjectCreate: "Create project",
  workspaceProjectUpdate: "Update project",
  artifactCreate: "Create artifact",
  artifactUpdate: "Update artifact",
  artifactMove: "Move artifact",
  operationUndo: "Undo change",
};

export function FleetCommandReceipts(props: {
  owner: string;
  sources: AgentSource[];
}) {
  return (
    <ReceiptPanel
      key={JSON.stringify([props.owner, viewGeneration()])}
      {...props}
    />
  );
}

function ReceiptPanel({
  owner,
  sources,
}: {
  owner: string;
  sources: AgentSource[];
}) {
  const [generation] = useState(viewGeneration);
  const [pending, setPending] = useState<PendingFleetCommand[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [incoming, setIncoming] = useState("");
  const [outgoing, setOutgoing] = useState("");
  const [requested, setRequested] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const outgoingId = useId(),
    incomingId = useId();
  const active = useRef<AbortController | null>(null);
  const alive = useRef(false);
  const belongs = () =>
    viewOwner() === owner && viewGeneration() === generation;
  const refreshVersion = useRef(0);
  const refresh = async () => {
    if (!belongs() || document.hidden) return;
    const version = ++refreshVersion.current;
    const current = () =>
      alive.current &&
      belongs() &&
      !document.hidden &&
      version === refreshVersion.current;
    try {
      const entries = await pendingFleetCommands();
      if (!current()) return;
      setPending(entries);
      setError("");
    } catch (error) {
      if (!current()) return;
      setError(
        error instanceof Error
          ? error.message
          : "Receipts are unavailable. Keep this browser's storage.",
      );
    }
  };
  useLayoutEffect(() => {
    alive.current = true;
    refresh();
    const show = () => {
      if (belongs() && !document.hidden) {
        setRequested(true);
        setExpanded(true);
        refresh();
      }
    };
    const visibility = () => {
      if (document.hidden) {
        active.current?.abort();
        active.current = null;
        setBusy(false);
      } else refresh();
    };
    const updates =
      typeof BroadcastChannel === "undefined"
        ? undefined
        : new BroadcastChannel(fleetCommandsChanged);
    if (updates) updates.onmessage = refresh;
    window.addEventListener(fleetCommandsChanged, refresh);
    window.addEventListener(showReceipts, show);
    window.addEventListener("storage", refresh);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive.current = false;
      refreshVersion.current++;
      updates?.close();
      active.current?.abort();
      active.current = null;
      window.removeEventListener(fleetCommandsChanged, refresh);
      window.removeEventListener(showReceipts, show);
      window.removeEventListener("storage", refresh);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [owner, generation]);
  if (!belongs()) return null;
  if (
    !pending.length &&
    !notice &&
    !requested &&
    !sources.some((source) => source.id.startsWith("peer:"))
  )
    return null;

  async function run(action: (signal: AbortSignal) => Promise<string>) {
    if (active.current || !belongs() || document.hidden) return;
    const controller = new AbortController();
    active.current = controller;
    const current = () =>
      alive.current &&
      belongs() &&
      !document.hidden &&
      active.current === controller &&
      !controller.signal.aborted;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const message = await action(controller.signal);
      if (current()) {
        refresh();
        setNotice(message);
      }
    } catch (error) {
      if (current())
        setError(
          error instanceof Error
            ? error.message
            : "The outcome is unavailable. Keep the original receipt.",
        );
    } finally {
      if (current()) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  const name = (command: PendingFleetCommand) =>
    sources.find((source) => source.id === command.source)?.name ??
    "Owning machine";
  return (
    <details
      className="fleet-command-receipts"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        Actions to check{pending.length ? ` (${pending.length})` : ""}
      </summary>
      <p>
        Check the original outcome before sending the action again. Unsettled
        receipts stay in this browser.
      </p>
      {pending.length === 0 && (
        <p>No actions are waiting for a receipt here.</p>
      )}
      <ul>
        {pending.map((command) => (
          <li key={command.id}>
            <strong>
              {labels[command.route]} · {name(command)}
            </strong>
            <details>
              <summary>Command details</summary>
              <code>{command.id}</code>
              <br />
              <code>{command.source.slice(5)}</code>
            </details>
            {!command.payloadDigest && (
              <p>
                This older receipt requires checking the original action on its
                owning machine. Keep the command ID.
              </p>
            )}
            <div className="fleet-receipt-actions">
              <button
                disabled={busy || !command.payloadDigest}
                onClick={() =>
                  void run(async (signal) => {
                    const receipt = await reconcileFleetCommand(
                      command,
                      signal,
                    );
                    const action = `${labels[command.route]} on ${name(command)}`;
                    if (receipt.state === "completed")
                      return `${action} completed. Open that machine's workspace to inspect the result.`;
                    if (receipt.state === "refused")
                      return `${action} was declined. Its receipt is settled.`;
                    if (receipt.state === "started")
                      return `${action} was accepted and has no final outcome yet. Keep this receipt and check again later.`;
                    return `${action} has an unknown outcome. Keep this receipt and check again after reconnecting.`;
                  })
                }
              >
                Check outcome
              </button>
              <button
                disabled={busy || !command.payloadDigest}
                onClick={() =>
                  void run(async (signal) => {
                    const packet = await exportFleetCommand(command, signal);
                    if (
                      !signal.aborted &&
                      alive.current &&
                      belongs() &&
                      !document.hidden
                    )
                      setOutgoing(packet);
                    return "Receipt ready to copy.";
                  })
                }
              >
                Show receipt to copy
              </button>
            </div>
          </li>
        ))}
      </ul>
      {outgoing && (
        <div>
          <label htmlFor={outgoingId}>Receipt to copy</label>
          <textarea
            {...literalEntry}
            id={outgoingId}
            readOnly
            value={outgoing}
            onFocus={(event) => event.currentTarget.select()}
            rows={4}
          />
        </div>
      )}
      <p>
        Before changing gateways, copy an unsettled receipt. Open and pair the
        other machine, then paste it here to check the same action. The receipt
        contains only its identifiers.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async (signal) => {
            await importFleetCommand(incoming, signal);
            if (!signal.aborted && alive.current && belongs()) setIncoming("");
            return "Receipt retained. Choose Check outcome to contact its owning machine.";
          });
        }}
      >
        <div>
          <label htmlFor={incomingId}>Receipt from another gateway</label>
          <textarea
            {...literalEntry}
            id={incomingId}
            value={incoming}
            onChange={(event) => setIncoming(event.target.value)}
            maxLength={2048}
            rows={3}
            disabled={busy}
          />
        </div>
        <button disabled={busy || !incoming.trim()} type="submit">
          Keep receipt
        </button>
      </form>
      {busy && <p role="status">Checking or retaining the receipt…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
