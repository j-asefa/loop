import { useEffect, useRef, useState } from "react";
import "./fleet.css";
import { Sheet } from "./components";
import { callRoute } from "./workspace-api";
import { useFleet, fleetAuthorityLabel, type FleetState } from "./FleetContext";
import { FleetCamera } from "./FleetCamera";
import { literalEntry, proseEntry } from "./textEntry";
import { fleetAdminApi } from "../shared/fleet-admin-api";
import type { RouteResponse } from "../shared/workspace-api";
import {
  fleetEnrollmentFromLink,
  type FleetEnrollmentLink,
} from "../shared/fleet-pairing";
import type { FleetOperation } from "../shared/fleet";
import type { FleetEnrollmentMode } from "../shared/fleet-enrollment";
import type { z } from "zod";
import type { FleetHandoffJob } from "../shared/fleet-handoff";

const operations: { id: FleetOperation; label: string }[] = [
  { id: "read", label: "Read agents and conversations" },
  { id: "act", label: "Create and control agent work" },
  { id: "events", label: "Receive live updates" },
  { id: "mail", label: "Exchange agent messages" },
  { id: "files", label: "Read and share authorized files" },
];
type Run = (action: () => Promise<unknown>) => Promise<void>;
type EnrollmentPage = RouteResponse<typeof fleetAdminApi.list>;
type HandoffPage = RouteResponse<typeof fleetAdminApi.handoffList>;
type PendingPage = RouteResponse<typeof fleetAdminApi.pending>;
type DeliveryPage = RouteResponse<typeof fleetAdminApi.deliveries>;

function ScopeChoices({
  value,
  set,
  allowed = operations.map((item) => item.id),
  disabled,
}: {
  value: FleetOperation[];
  set: (value: FleetOperation[]) => void;
  allowed?: FleetOperation[];
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>Allowed fleet operations</legend>
      {operations
        .filter((item) => allowed.includes(item.id))
        .map((item) => (
          <label className="fleet-check" key={item.id}>
            <input
              type="checkbox"
              checked={value.includes(item.id)}
              onChange={(event) =>
                set(
                  event.target.checked
                    ? [...value, item.id]
                    : value.filter((id) => id !== item.id),
                )
              }
            />
            {item.label}
          </label>
        ))}
    </fieldset>
  );
}

function EnrollmentForm({
  state,
  busy,
  run,
}: {
  state: FleetState;
  busy: boolean;
  run: Run;
}) {
  const [text, setText] = useState(""),
    [link, setLink] = useState<FleetEnrollmentLink | null>(null);
  const [name, setName] = useState(""),
    [mode, setMode] = useState<z.infer<typeof FleetEnrollmentMode>>("enroll");
  const [scope, setScope] = useState<FleetOperation[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState("");
  const inspect = (value: string) => {
    setText("");
    setLink(null);
    setConfirmed(false);
    setError("");
    try {
      // Only this projection can reach local administration. The original link
      // and its device half are never put in history, storage or a request.
      const parsed = fleetEnrollmentFromLink(value.trim());
      if (parsed.machine.machineId === state.identity.machineId)
        throw new Error(
          "This is the current machine. Use another machine's pairing link.",
        );
      const existing = state.directory?.document.members.find(
        (m) => m.machineId === parsed.machine.machineId,
      );
      setLink(parsed);
      setName(existing?.name ?? "");
      setMode(existing ? "repair" : "enroll");
      setScope(parsed.scope);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Use a fresh pairing link.",
      );
    }
  };
  return (
    <section className="fleet-section" aria-labelledby="fleet-add-heading">
      <h3 id="fleet-add-heading">Add or re-pair a machine</h3>
      <p>
        Run <code>loop pair</code> on the other machine. Scan its code here or
        paste the complete link. Its device-pairing secret stays in this
        browser.
      </p>
      {!link ? (
        <>
          <FleetCamera onValue={inspect} disabled={busy} />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              inspect(text);
            }}
          >
            <label htmlFor="fleet-pairing-input">Pairing link</label>
            <textarea
              {...literalEntry}
              id="fleet-pairing-input"
              disabled={busy}
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={4096}
            />
            <button type="submit" disabled={busy || !text.trim()}>
              Inspect machine
            </button>
          </form>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!confirmed || !scope.length || !name.trim() || !state.head)
              return;
            const input = {
              operationId: crypto.randomUUID(),
              expected: state.head,
              link,
              name: name.trim(),
              mode,
              scope,
              confirm: true as const,
            };
            void run(async () => {
              setLink(null);
              setConfirmed(false);
              return callRoute(fleetAdminApi.begin, { body: input }, "");
            });
          }}
        >
          <p>
            <strong>Confirm the destination shown on the other machine.</strong>
          </p>
          <dl>
            <dt>Address</dt>
            <dd>{link.origin}</dd>
            <dt>Machine identity</dt>
            <dd>
              <code>{link.machine.machineId}</code>
            </dd>
            <dt>Fleet controller</dt>
            <dd>
              <code>{state.identity.machineId}</code>
            </dd>
          </dl>
          <label>
            Machine name
            <input
              {...proseEntry}
              disabled={busy}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setConfirmed(false);
              }}
              maxLength={80}
              required
            />
          </label>
          <label htmlFor="fleet-enrollment-mode">Connection purpose</label>
          <select
            id="fleet-enrollment-mode"
            disabled={busy}
            value={mode}
            onChange={(event) => {
              setMode(
                event.target.value as z.infer<typeof FleetEnrollmentMode>,
              );
              setConfirmed(false);
            }}
          >
            <option value="enroll">Add a machine</option>
            <option value="repair">Re-pair its changed address</option>
            <option value="recover">
              Recover into this fleet with fresh local consent
            </option>
          </select>
          <ScopeChoices
            value={scope}
            set={(value) => {
              setScope(value);
              setConfirmed(false);
            }}
            allowed={link.scope}
            disabled={busy}
          />
          <label className="fleet-check">
            <input
              type="checkbox"
              disabled={busy}
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I confirm this machine and authorize this controller to manage its
            peer membership within the selected scope.
          </label>
          <div className="fleet-actions">
            <button
              type="submit"
              className="primary"
              disabled={busy || !confirmed || !scope.length}
            >
              Confirm machine
            </button>
            <button
              type="button"
              onClick={() => {
                setLink(null);
                setConfirmed(false);
              }}
              disabled={busy}
            >
              Discard link
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

function EnrollmentLink({ busy, run }: { busy: boolean; run: Run }) {
  const [scope, setScope] = useState<FleetOperation[]>(
    operations.map((item) => item.id),
  );
  const [recover, setRecover] = useState(false),
    [confirm, setConfirm] = useState(false),
    [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const active = useRef(true);
  const visibilityGeneration = useRef(0);
  useEffect(() => {
    active.current = true;
    const hidden = () => {
      if (document.hidden) {
        visibilityGeneration.current++;
        setUrl("");
        setConfirm(false);
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      active.current = false;
      visibilityGeneration.current++;
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    if (!url) return;
    const timer = setTimeout(() => setUrl(""), 120_000);
    return () => clearTimeout(timer);
  }, [url]);
  return (
    <details className="fleet-section">
      <summary>Add this machine to an existing fleet</summary>
      <p>
        If your phone camera opened this machine's pairing page, that code has
        already been consumed. Create a fresh enrollment-only link here and
        paste it into the controller's Add machine screen. Your paired devices
        stay authorized. Creating a fresh link invalidates older unused pairing
        links on this machine.
      </p>
      <ScopeChoices
        value={scope}
        set={(value) => {
          setScope(value);
          setConfirm(false);
        }}
        disabled={busy}
      />
      <label className="fleet-check">
        <input
          type="checkbox"
          disabled={busy}
          checked={recover}
          onChange={(event) => {
            setRecover(event.target.checked);
            setConfirm(false);
          }}
        />
        Allow explicit recovery into another fleet. This replaces this machine's
        current grant when confirmed.
      </label>
      <label className="fleet-check">
        <input
          type="checkbox"
          disabled={busy}
          checked={confirm}
          onChange={(event) => setConfirm(event.target.checked)}
        />
        Allow enrollment with the selected operations.
      </label>
      <button
        type="button"
        disabled={busy || !confirm || !scope.length}
        onClick={() =>
          void run(async () => {
            const generation = visibilityGeneration.current;
            const result = await callRoute(
              fleetAdminApi.mint,
              { body: { scope, recover, confirm: true } },
              "",
            );
            if (active.current && generation === visibilityGeneration.current) {
              setConfirm(false);
              if (!document.hidden) {
                setUrl(result.url);
                setCopied(false);
              }
            }
          })
        }
      >
        Create enrollment-only link
      </button>
      {url && (
        <div>
          <label htmlFor="fleet-enrollment-link">Enrollment-only link</label>
          <textarea
            {...literalEntry}
            id="fleet-enrollment-link"
            readOnly
            value={url}
          />
          <p>
            Single use; expires after two minutes. Share it only with your
            intended controller.
          </p>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(url)
                .then(() => {
                  if (active.current) setCopied(true);
                })
                .catch(() => {
                  if (active.current) setCopied(false);
                })
            }
          >
            {copied ? "Copied" : "Copy enrollment link"}
          </button>
          <button type="button" onClick={() => setUrl("")}>
            Hide link
          </button>
        </div>
      )}
    </details>
  );
}

function HandoffOperation({
  job,
  busy,
  run,
}: {
  job: FleetHandoffJob;
  busy: boolean;
  run: Run;
}) {
  const [origin, setOrigin] = useState("");
  return (
    <article className="connection-card">
      <strong>Controller transfer to {job.origin}</strong>
      <p>
        {job.state === "uncertain"
          ? "Outcome uncertain. The old controller stays fenced; check the signed receipt."
          : job.state}
      </p>
      {job.state === "ready" && (
        <button
          disabled={busy}
          onClick={() =>
            void run(() =>
              callRoute(
                fleetAdminApi.handoffAdvance,
                { body: { operationId: job.operationId } },
                "",
              ),
            )
          }
        >
          Send confirmed handoff
        </button>
      )}
      {job.state === "uncertain" && (
        <>
          <label>
            Confirmed new address, if it changed
            <input
              {...literalEntry}
              type="url"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              placeholder="https://…"
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              void run(() =>
                callRoute(
                  fleetAdminApi.handoffReconcile,
                  {
                    body: {
                      operationId: job.operationId,
                      ...(origin.trim() ? { origin: origin.trim() } : {}),
                      confirm: true,
                    },
                  },
                  "",
                ),
              )
            }
          >
            Check handoff receipt
          </button>
        </>
      )}
    </article>
  );
}

export function FleetSettings({ onClose }: { onClose: () => void }) {
  const fleet = useFleet(),
    state = fleet.state;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [name, setName] = useState(""),
    [confirm, setConfirm] = useState(false);
  const [recoveryHead, setRecoveryHead] = useState<string | null>(null);
  const [scope, setScope] = useState<FleetOperation[]>(
    operations.map((item) => item.id),
  );
  const [selection, setSelection] = useState<{
    kind: "remove" | "handoff";
    machineId: string;
    head: string;
  } | null>(null);
  const [enrollments, setEnrollments] = useState<EnrollmentPage>({
    items: [],
    next: null,
  });
  const [handoffs, setHandoffs] = useState<HandoffPage>({
    items: [],
    next: null,
  });
  const [pending, setPending] = useState<PendingPage>({
    items: [],
    next: null,
  });
  const [deliveries, setDeliveries] = useState<DeliveryPage>({
    items: [],
    next: null,
  });
  const [deliveryHead, setDeliveryHead] = useState<string | null>();
  const [deliveryError, setDeliveryError] = useState("");
  const active = useRef(true),
    lock = useRef(false),
    generation = useRef(0),
    deliveryGeneration = useRef(0);
  const lastDeliveryHead = useRef<string | null | undefined>(undefined);
  const loadedDeliveryPages = useRef(1),
    refreshingDeliveries = useRef(false);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const load = async () => {
    const current = ++generation.current;
    const [enrollmentPage, handoffPage, pendingPage] = await Promise.all([
      callRoute(fleetAdminApi.list, { body: { cursor: null } }, ""),
      callRoute(fleetAdminApi.handoffList, { body: { cursor: null } }, ""),
      callRoute(fleetAdminApi.pending, { body: { cursor: null } }, ""),
    ]);
    if (!active.current || current !== generation.current) return;
    setEnrollments(enrollmentPage);
    setHandoffs(handoffPage);
    setPending(pendingPage);
  };
  useEffect(() => {
    active.current = true;
    void fleet.refresh();
    void load().catch(() => {
      if (active.current)
        setError("Could not read fleet operations. Refresh to try again.");
    });
    return () => {
      active.current = false;
      generation.current++;
      deliveryGeneration.current++;
    };
  }, []);
  useEffect(() => {
    const current = ++deliveryGeneration.current;
    if (!state) {
      loadedDeliveryPages.current = 1;
      refreshingDeliveries.current = false;
      setDeliveryLoading(false);
      lastDeliveryHead.current = undefined;
      setDeliveryHead(undefined);
      setDeliveries({ items: [], next: null });
      setDeliveryError("");
      return;
    }
    const head = state.head;
    const pages =
      lastDeliveryHead.current === head ? loadedDeliveryPages.current : 1;
    refreshingDeliveries.current = true;
    setDeliveryLoading(true);
    void (async () => {
      const items: DeliveryPage["items"] = [];
      let cursor: string | null = null;
      let loaded = 0;
      do {
        const page: DeliveryPage = await callRoute(
          fleetAdminApi.deliveries,
          { body: { cursor } },
          "",
        );
        if (!active.current || current !== deliveryGeneration.current) return;
        items.push(...page.items);
        cursor = page.next;
        loaded++;
      } while (cursor && loaded < pages);
      return { page: { items, next: cursor }, loaded };
    })()
      .then((result) => {
        if (
          !result ||
          !active.current ||
          current !== deliveryGeneration.current
        )
          return;
        setDeliveries(result.page);
        loadedDeliveryPages.current = result.loaded;
        lastDeliveryHead.current = head;
        setDeliveryHead(head);
        setDeliveryError("");
      })
      .catch(() => {
        if (active.current && current === deliveryGeneration.current)
          setDeliveryError(
            "Could not read directory synchronization. Refresh to try again.",
          );
      })
      .finally(() => {
        if (active.current && current === deliveryGeneration.current) {
          refreshingDeliveries.current = false;
          setDeliveryLoading(false);
        }
      });
    return () => {
      deliveryGeneration.current++;
    };
  }, [state]);
  const run: Run = async (action) => {
    if (lock.current || !active.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      if (active.current) {
        await fleet.refresh();
        await load();
        if (!active.current) return;
        setConfirm(false);
        setRecoveryHead(null);
        setSelection(null);
      }
    } catch (error) {
      if (active.current) {
        setError(
          error instanceof Error
            ? error.message
            : "The result is unavailable. Check operation receipts before trying again.",
        );
        await fleet.refresh();
        await load().catch(() => {});
      }
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  };
  const more = async (
    kind: "pending" | "enrollments" | "handoffs" | "deliveries",
  ) => {
    if (
      lock.current ||
      !active.current ||
      (kind === "deliveries" && refreshingDeliveries.current)
    )
      return;
    lock.current = true;
    setBusy(true);
    const current =
      kind === "deliveries" ? deliveryGeneration.current : generation.current;
    try {
      if (kind === "deliveries" && deliveries.next) {
        const page = await callRoute(
          fleetAdminApi.deliveries,
          { body: { cursor: deliveries.next } },
          "",
        );
        if (active.current && current === deliveryGeneration.current) {
          loadedDeliveryPages.current++;
          setDeliveries((old) => ({
            items: [...old.items, ...page.items],
            next: page.next,
          }));
        }
      } else if (kind === "pending" && pending.next) {
        const page = await callRoute(
          fleetAdminApi.pending,
          { body: { cursor: pending.next } },
          "",
        );
        if (active.current && current === generation.current)
          setPending((old) => ({
            items: [...old.items, ...page.items],
            next: page.next,
          }));
      } else if (kind === "enrollments" && enrollments.next) {
        const page = await callRoute(
          fleetAdminApi.list,
          { body: { cursor: enrollments.next } },
          "",
        );
        if (active.current && current === generation.current)
          setEnrollments((old) => ({
            items: [...old.items, ...page.items],
            next: page.next,
          }));
      } else if (kind === "handoffs" && handoffs.next) {
        const page = await callRoute(
          fleetAdminApi.handoffList,
          { body: { cursor: handoffs.next } },
          "",
        );
        if (active.current && current === generation.current)
          setHandoffs((old) => ({
            items: [...old.items, ...page.items],
            next: page.next,
          }));
      }
    } catch {
      if (
        active.current &&
        current ===
          (kind === "deliveries"
            ? deliveryGeneration.current
            : generation.current)
      )
        setError("Could not read more fleet operations. Refresh to try again.");
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  };
  const disabled = busy || !!fleet.error;
  const controller = state?.state === "controller";
  const selected = state?.directory?.document.members.find(
    (member) => member.machineId === selection?.machineId,
  );
  const own = state?.directory?.document.members.find(
    (member) => member.machineId === state.identity.machineId,
  );
  return (
    <Sheet
      title="Machines & fleet"
      onClose={onClose}
      className="fleet-settings"
    >
      {!state ? (
        <>
          <p role="status">
            {fleet.error ||
              "Open a non-preview companion at its HTTPS address and pair this device to manage a fleet."}
          </p>
          {fleet.error && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => {})}
            >
              Refresh fleet status
            </button>
          )}
        </>
      ) : (
        <>
          <p role="status">
            <strong>{fleet.error || fleetAuthorityLabel(state)}</strong>
          </p>
          <p>
            This browser uses <strong>{state.origin}</strong> as its gateway.
            Choosing another gateway does not transfer directory control.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => {})}
          >
            Refresh fleet status
          </button>
          <details>
            <summary>Directory details</summary>
            <p>
              Machine <code>{state.identity.machineId}</code>
            </p>
            {state.directory && (
              <p>
                Epoch {state.directory.document.epoch} · Revision{" "}
                {state.directory.document.revision}
              </p>
            )}
            <p>
              {state.pendingDistribution} directory deliveries awaiting
              acknowledgement. Status read{" "}
              {fleet.checkedAt
                ? new Date(fleet.checkedAt).toLocaleTimeString()
                : "not yet"}
              .
            </p>
            <p>
              An unreachable machine may still honor its last approved grant
              until it learns a removal. Ten-minute credential expiry is not a
              global revocation deadline.
            </p>
          </details>
          {state.state === "standalone" && (
            <section className="fleet-section">
              <h3>Create a fleet on this computer</h3>
              <label>
                Machine name
                <input
                  {...proseEntry}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setRecoveryHead(null);
                    setConfirm(false);
                  }}
                  maxLength={80}
                />
              </label>
              <ScopeChoices
                value={scope}
                set={(value) => {
                  setScope(value);
                  setRecoveryHead(null);
                  setConfirm(false);
                }}
                disabled={disabled}
              />
              <label className="fleet-check">
                <input
                  type="checkbox"
                  checked={confirm}
                  onChange={(event) => setConfirm(event.target.checked)}
                />
                This computer will control the fleet directory.
              </label>
              <button
                disabled={disabled || !confirm || !scope.length || !name.trim()}
                onClick={() =>
                  void run(() =>
                    callRoute(
                      fleetAdminApi.create,
                      {
                        body: {
                          mutationId: crypto.randomUUID(),
                          name: name.trim(),
                          scope,
                          confirm: true,
                        },
                      },
                      "",
                    ),
                  )
                }
              >
                Create fleet
              </button>
            </section>
          )}
          {state.directory && (
            <section className="fleet-section">
              <h3>Machines</h3>
              {state.directory.document.members.map((member) => (
                <article className="connection-card" key={member.machineId}>
                  <strong>
                    {member.name}
                    {member.machineId === state.identity.machineId
                      ? " · This gateway"
                      : ""}
                  </strong>
                  <p>{member.origin}</p>
                  <details>
                    <summary>Identity</summary>
                    <code>{member.machineId}</code>
                  </details>
                  {member.machineId !== state.identity.machineId && (
                    <a
                      href={member.origin}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open this gateway
                    </a>
                  )}
                  {controller &&
                    member.machineId !== state.identity.machineId && (
                      <div className="fleet-actions">
                        <button
                          disabled={disabled}
                          onClick={() => {
                            setConfirm(false);
                            setSelection({
                              kind: "remove",
                              machineId: member.machineId,
                              head: state.head!,
                            });
                          }}
                        >
                          Remove machine
                        </button>
                        <button
                          disabled={disabled}
                          onClick={() => {
                            setConfirm(false);
                            setSelection({
                              kind: "handoff",
                              machineId: member.machineId,
                              head: state.head!,
                            });
                          }}
                        >
                          Transfer directory control
                        </button>
                      </div>
                    )}
                </article>
              ))}
              {selected && selection && (
                <div
                  className="fleet-confirm"
                  role="group"
                  aria-label="Confirm fleet change"
                >
                  <p>
                    {selection.kind === "remove"
                      ? `Remove ${selected.name} and revoke its fleet grant? Unreachable machines remain pending until they receive the removal.`
                      : `Transfer directory control to ${selected.name}? This gateway stops directory writes before dispatch and cannot automatically undo an uncertain handoff. Pair locally at the destination to administer it.`}
                  </p>
                  <code>{selected.machineId}</code>
                  <label className="fleet-check">
                    <input
                      type="checkbox"
                      checked={confirm}
                      onChange={(event) => setConfirm(event.target.checked)}
                    />
                    I confirm this change.
                  </label>
                  {selection.head !== state.head && (
                    <p>
                      Directory changed. Select this action again to confirm the
                      current state.
                    </p>
                  )}
                  <button
                    disabled={
                      disabled || !confirm || selection.head !== state.head
                    }
                    onClick={() =>
                      void run(() =>
                        selection.kind === "remove"
                          ? callRoute(
                              fleetAdminApi.remove,
                              {
                                body: {
                                  mutationId: crypto.randomUUID(),
                                  expected: selection.head,
                                  machineId: selected.machineId,
                                  confirm: true,
                                },
                              },
                              "",
                            )
                          : callRoute(
                              fleetAdminApi.handoffBegin,
                              {
                                body: {
                                  operationId: crypto.randomUUID(),
                                  expected: selection.head,
                                  destination: {
                                    machineId: selected.machineId,
                                    publicKey: selected.publicKey,
                                  },
                                  confirm: true,
                                },
                              },
                              "",
                            ),
                      )
                    }
                  >
                    Confirm{" "}
                    {selection.kind === "remove" ? "removal" : "handoff"}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setSelection(null);
                      setConfirm(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </section>
          )}
          {controller && own && own.origin !== state.origin && (
            <section className="fleet-section">
              <h3>This controller has a new address</h3>
              <p>
                Replace {own.origin} with {state.origin} using this machine's
                surviving signing key.
              </p>
              <button
                disabled={disabled}
                onClick={() =>
                  void run(() =>
                    callRoute(
                      fleetAdminApi.repairSelf,
                      {
                        body: {
                          mutationId: crypto.randomUUID(),
                          expected: state.head!,
                          confirm: true,
                        },
                      },
                      "",
                    ),
                  )
                }
              >
                Confirm this address
              </button>
            </section>
          )}
          {(deliveryHead !== state.head || deliveryError) && (
            <p role="status">
              {deliveryError || "Refreshing directory synchronization…"}
            </p>
          )}
          {deliveryHead === state.head &&
            !deliveryError &&
            !!deliveries.items.length && (
              <section className="fleet-section">
                <h3>Directory synchronization</h3>
                <p>
                  An acknowledgement records receipt of a directory revision. It
                  does not prove that a machine is still online.
                </p>
                {deliveries.items.map((delivery) => (
                  <article key={delivery.peerId} className="connection-card">
                    <strong>
                      {state.directory?.document.members.find(
                        (member) => member.machineId === delivery.peerId,
                      )?.name ?? delivery.peerId}
                    </strong>
                    {state.directory?.document.tombstones.includes(
                      delivery.peerId,
                    ) && <p>Revoked from this directory</p>}
                    <p>
                      {!delivery.current
                        ? "Retired directory — fresh consent is required"
                        : delivery.state === "acked"
                          ? "Directory acknowledged"
                          : delivery.state === "incompatible"
                            ? "Address or directory repair needed. Re-pair using a fresh link."
                            : delivery.attempts
                              ? "Temporarily unreachable. Directory synchronization pending; retry or re-pair if its address changed."
                              : "Directory synchronization pending"}
                    </p>
                    <small>
                      Epoch {delivery.epoch} · Revision {delivery.revision}
                    </small>
                    {delivery.current && delivery.state !== "acked" && (
                      <button
                        disabled={
                          disabled ||
                          !["controller", "replica"].includes(state.state)
                        }
                        onClick={() =>
                          void run(() =>
                            callRoute(
                              fleetAdminApi.retryDelivery,
                              {
                                body: {
                                  peerId: delivery.peerId,
                                  digest: delivery.digest,
                                  expected: state.head!,
                                  confirm: true,
                                },
                              },
                              "",
                            ),
                          )
                        }
                      >
                        Retry directory synchronization
                      </button>
                    )}
                  </article>
                ))}
                {deliveries.next && (
                  <button
                    disabled={busy || deliveryLoading}
                    onClick={() => void more("deliveries")}
                  >
                    More directory deliveries
                  </button>
                )}
              </section>
            )}
          {controller && (
            <EnrollmentForm
              key={`enrollment:${state.head}`}
              state={state}
              busy={disabled}
              run={run}
            />
          )}
          <EnrollmentLink
            key={`link:${state.head ?? state.identity.machineId}`}
            busy={disabled}
            run={run}
          />
          {state.head && state.state !== "removed" && (
            <details className="fleet-section">
              <summary>Recover without the old controller</summary>
              <p>
                Explicit recovery starts a directory controlled by this machine.
                Other machines keep their own decisions until they consent
                again. It does not restore their grants or merge conflicting
                directories.
              </p>
              <label>
                Recovered machine name
                <input
                  {...proseEntry}
                  disabled={disabled}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setRecoveryHead(null);
                    setConfirm(false);
                  }}
                  maxLength={80}
                />
              </label>
              <ScopeChoices
                value={scope}
                set={(value) => {
                  setScope(value);
                  setRecoveryHead(null);
                  setConfirm(false);
                }}
                disabled={disabled}
              />
              <label className="fleet-check">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={recoveryHead === state.head}
                  onChange={(event) =>
                    setRecoveryHead(event.target.checked ? state.head : null)
                  }
                />
                I authorize recovery on this machine and understand other
                machines must consent again.
              </label>
              <button
                disabled={
                  disabled ||
                  recoveryHead !== state.head ||
                  !name.trim() ||
                  !scope.length
                }
                onClick={() =>
                  void run(() =>
                    callRoute(
                      fleetAdminApi.recover,
                      {
                        body: {
                          mutationId: crypto.randomUUID(),
                          expected: recoveryHead!,
                          name: name.trim(),
                          scope,
                          confirm: true,
                        },
                      },
                      "",
                    ),
                  )
                }
              >
                Recover this machine
              </button>
            </details>
          )}
          {state.state === "removed" && (
            <p role="status">
              This machine was removed from the fleet. Its local workspace
              remains available; it cannot recover or administer the revoked
              directory.
            </p>
          )}
          {!!state.unconfirmed.length && (
            <section className="fleet-section">
              <h3>Awaiting fresh consent</h3>
              {state.unconfirmed.map((member) => (
                <p key={member.machineId}>
                  {member.name} · {member.origin} · No restored grant
                </p>
              ))}
            </section>
          )}
          {!!pending.items.length && (
            <section className="fleet-section">
              <h3>Pending local consent</h3>
              {pending.items.map((item) => (
                <article key={item.operationId} className="connection-card">
                  <p>
                    {item.mode} · Controller{" "}
                    <code>{item.controller.machineId}</code>
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        callRoute(
                          fleetAdminApi.cancelPending,
                          { body: { operationId: item.operationId } },
                          "",
                        ),
                      )
                    }
                  >
                    Cancel pending consent
                  </button>
                </article>
              ))}
            </section>
          )}
          {pending.next && (
            <button disabled={busy} onClick={() => void more("pending")}>
              More pending consents
            </button>
          )}
          {!!enrollments.items.length && (
            <section className="fleet-section">
              <h3>Enrollment operations</h3>
              {enrollments.items.map((job) => (
                <article key={job.operationId} className="connection-card">
                  <strong>
                    {job.name} · {job.origin}
                  </strong>
                  <p>
                    {job.state === "uncertain" || job.state === "preparing"
                      ? "Outcome uncertain. Check the receipt; do not repeat enrollment."
                      : job.state === "complete"
                        ? "Enrollment complete. Directory acknowledgements are tracked separately."
                        : job.state}
                  </p>
                  {["ready", "prepared", "published"].includes(job.state) && (
                    <button
                      disabled={disabled || !controller}
                      onClick={() =>
                        void run(() =>
                          callRoute(
                            fleetAdminApi.advance,
                            { body: { operationId: job.operationId } },
                            "",
                          ),
                        )
                      }
                    >
                      Continue confirmed enrollment
                    </button>
                  )}
                  {["uncertain", "preparing"].includes(job.state) && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          callRoute(
                            fleetAdminApi.reconcile,
                            { body: { operationId: job.operationId } },
                            "",
                          ),
                        )
                      }
                    >
                      Check enrollment receipt
                    </button>
                  )}
                  {["ready", "prepared"].includes(job.state) && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          callRoute(
                            fleetAdminApi.cancel,
                            { body: { operationId: job.operationId } },
                            "",
                          ),
                        )
                      }
                    >
                      Cancel enrollment
                    </button>
                  )}
                </article>
              ))}
            </section>
          )}
          {enrollments.next && (
            <button disabled={busy} onClick={() => void more("enrollments")}>
              More enrollment operations
            </button>
          )}
          {!!handoffs.items.length && (
            <section className="fleet-section">
              <h3>Controller handoffs</h3>
              {handoffs.items.map((job) => (
                <HandoffOperation
                  key={job.operationId}
                  job={job}
                  busy={busy}
                  run={run}
                />
              ))}
            </section>
          )}
          {handoffs.next && (
            <button disabled={busy} onClick={() => void more("handoffs")}>
              More handoff operations
            </button>
          )}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
