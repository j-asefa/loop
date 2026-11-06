import { proseEntry } from "./textEntry";
import { useEffect, useId, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { callRoute } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import {
  SettingsCommand,
  SettingsEmpty,
  SettingsList,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "./SettingsUI";
import {
  integrationTokenRequest,
  type IntegrationTokenRequest,
  type CardToken,
} from "../shared/card-access";
import { SCOPE_CATALOG, TokenScope } from "../shared/token-scopes";
import { viewOwner } from "./viewCache";

// Pending creation survives closing Settings, scoped to its initiating owner/source.
// This ephemeral receipt never goes to URL, localStorage or sessionStorage.
const pending = new Map<string, IntegrationTokenRequest>();

/** The parent keys this surface by owner and source. Secrets live only in this
 * creation workflow; stale responses cannot reveal them to another owner/source. */
export function CardTokens({
  owner,
  sourceId,
}: {
  owner: string;
  sourceId: string;
}) {
  const key = JSON.stringify([owner, sourceId]);
  const receipt = useRef(pending.get(key));
  const nameId = useId();
  const [tokens, setTokens] = useState<CardToken[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [name, setName] = useState(receipt.current?.name || "");
  const [scopes, setScopes] = useState<TokenScope[]>(
    receipt.current?.scopes || ["read"],
  );
  const [created, setCreated] = useState<{
    token: CardToken;
    secret: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const listRequest = useRef(0);
  const current = () => alive.current && viewOwner() === owner;
  const load = async (clearError = true) => {
    const ticket = ++listRequest.current;
    try {
      const list = await callRoute(workspaceApi.cardTokens, {}, sourceId);
      if (current() && ticket === listRequest.current) {
        setTokens(list);
        setLoaded(true);
        setUnavailable(false);
        if (clearError) setError("");
        const draft = receipt.current;
        const committed =
          draft &&
          list.find(
            (token) =>
              token.id === draft.request_id &&
              token.name === draft.name &&
              JSON.stringify(token.scopes) === JSON.stringify(draft.scopes) &&
              !token.revoked_at,
          );
        if (draft && committed) {
          setCreated({ token: committed, secret: draft.secret });
          receipt.current = undefined;
          pending.delete(key);
          setName("");
          setScopes(["read"]);
          setError("");
        }
      }
      return list;
    } catch (e) {
      if (current() && ticket === listRequest.current) {
        setLoaded(true);
        setUnavailable((e as { status?: number }).status === 404);
        setError((e as Error).message);
      }
      return null;
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      listRequest.current++;
      if (viewOwner() !== owner) pending.delete(key);
    };
  }, []);
  if (unavailable)
    return (
      <SettingsNote tone="attention">
        Integration tokens are unavailable on this source. Update that workspace
        to enable them, or retry when it reconnects.{" "}
        <button type="button" onClick={() => void load()}>
          Retry list
        </button>
      </SettingsNote>
    );
  return (
    <>
      <p className="settings-intro">
        Choose what a script can do in this workspace. Each token belongs to
        this source and your account.
      </p>
      {error && (
        <SettingsNote role="alert" tone="attention">
          {error}{" "}
          <button type="button" onClick={() => void load()}>
            Retry list
          </button>
        </SettingsNote>
      )}
      <SettingsSection title="Create a token">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || !current() || !scopes.length) return;
            const draft =
              receipt.current || integrationTokenRequest(name, scopes);
            receipt.current = draft;
            pending.set(key, draft);
            setBusy(true);
            setError("");
            setCreated(null);
            try {
              const result = await callRoute(
                workspaceApi.cardTokenCreate,
                { body: draft },
                sourceId,
              );
              if (current()) {
                receipt.current = undefined;
                pending.delete(key);
                setCreated(result);
                setName("");
                setScopes(["read"]);
                await load();
              }
            } catch (e) {
              if (current()) {
                const status = (e as { status?: number }).status || 0;
                if (
                  status >= 400 &&
                  status < 500 &&
                  ![408, 429].includes(status)
                ) {
                  receipt.current = undefined;
                  pending.delete(key);
                  await load(false);
                  setError((e as Error).message);
                  return;
                }
                setError(
                  "Creation may have completed. Checking your token list…",
                );
                await load(false);
                if (current() && receipt.current)
                  setError(
                    (e as Error).message +
                      " Retry uses this same creation request; it will not create a second token.",
                  );
              }
            } finally {
              if (current()) setBusy(false);
            }
          }}
        >
          <label htmlFor={nameId}>Token name</label>
          <input
            {...proseEntry}
            id={nameId}
            required
            disabled={busy || !!receipt.current}
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Project dashboard"
          />
          <fieldset disabled={busy || !!receipt.current}>
            <legend>Access</legend>
            {TokenScope.options.map((scope) => (
              <SettingsToggle
                key={scope}
                title={SCOPE_CATALOG[scope].label}
                description={
                  scope === "approvals:decide"
                    ? SCOPE_CATALOG[scope].description +
                      " Enable only when your script should make those decisions."
                    : SCOPE_CATALOG[scope].description
                }
                checked={scopes.includes(scope)}
                disabled={busy || !!receipt.current}
                onChange={(checked) =>
                  setScopes((current) =>
                    checked
                      ? [...current, scope]
                      : current.filter((value) => value !== scope),
                  )
                }
              />
            ))}
          </fieldset>
          <button
            type="submit"
            disabled={busy || !name.trim() || !scopes.length}
          >
            {busy
              ? "Creating…"
              : receipt.current
                ? "Retry token creation"
                : "Create token"}
          </button>
        </form>
        {created && (
          <>
            <SettingsNote title="Copy this token now">
              This is the only time Loop displays its secret. Keep it in your
              script’s secret store.
            </SettingsNote>
            <SettingsCommand
              title={created.token.name}
              command={created.secret}
              copyLabel="Copy token"
            />
            <button type="button" onClick={() => setCreated(null)}>
              Hide token
            </button>
          </>
        )}
      </SettingsSection>
      <SettingsSection title="Your tokens">
        {!loaded ? (
          <p role="status">Loading tokens…</p>
        ) : !tokens.length ? (
          <SettingsEmpty icon={KeyRound} title="No integration tokens">
            Create a token to connect a script.
          </SettingsEmpty>
        ) : (
          <SettingsList label="Integration tokens">
            {tokens.map((token) => (
              <SettingsRow
                key={token.id}
                icon={KeyRound}
                title={token.name}
                description={
                  <>
                    {token.scopes
                      .map((value) => SCOPE_CATALOG[value].label)
                      .join(", ")}{" "}
                    · Created {new Date(token.created_at).toLocaleDateString()}
                    <br />
                    {token.last_used_at
                      ? `Last used about ${new Date(token.last_used_at).toLocaleString()}`
                      : "Not used yet"}
                    {token.revoked_at
                      ? ` · Revoked ${new Date(token.revoked_at).toLocaleDateString()}`
                      : ""}
                  </>
                }
                wrap
              >
                {!token.revoked_at && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Revoke ${token.name}`}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await callRoute(
                          workspaceApi.cardTokenRevoke,
                          { params: { id: token.id } },
                          sourceId,
                        );
                        if (current()) {
                          if (created?.token.id === token.id) setCreated(null);
                          if (receipt.current?.request_id === token.id) {
                            receipt.current = undefined;
                            pending.delete(key);
                          }
                          await load();
                        }
                      } catch (e) {
                        if (current()) setError((e as Error).message);
                      } finally {
                        if (current()) setBusy(false);
                      }
                    }}
                  >
                    Revoke
                  </button>
                )}
              </SettingsRow>
            ))}
          </SettingsList>
        )}
        <p className="field-hint">
          Last used is approximate and updates at most once a minute. Revocation
          takes effect on the next request.
        </p>
      </SettingsSection>
    </>
  );
}
