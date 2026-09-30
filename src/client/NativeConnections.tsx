import { ConnectionDetails } from "./ConnectionDetails";
import { RuntimeSetup } from "./RuntimeSetup";
import { useState } from "react";
import { api, parse } from "./api";
import { Sheet, Badge } from "./components";
import type { Connection } from "../shared/types";
export function NativeConnections({
  connections,
  onChange,
  onClose,
}: {
  connections: Connection[];
  onChange: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [apiForm, setApiForm] = useState(false);
  return (
    <Sheet title="Connected harnesses" onClose={onClose}>
      <RuntimeSetup onEnabled={onChange} />
      {connections.map((c) => {
        const metadata = parse<any>(c.metadata, {});
        return (
          <section key={c.id} className="native-decision">
            <h3>{c.label}</h3>
            <Badge provider={c.provider} />
            <ConnectionDetails connection={c} />
            {metadata.loopHarness && (
              <p className="note">
                Native tools, project instructions and permissions are
                inherited. Model and instructions apply to new conversations.
                Native pause and takeover of external live sessions are
                unavailable.
              </p>
            )}
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api(
                    metadata.backend === "hapi"
                      ? `/environments/${metadata.environmentId}/provider/${metadata.flavor}/verify`
                      : "/connections/" + c.id + "/refresh",
                    {},
                  );
                  await onChange();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Refresh account and models
            </button>
          </section>
        );
      })}
      <button className="text-button" onClick={() => setApiForm(!apiForm)}>
        Connect an API key for Loop's own agent runtime
      </button>
      {apiForm && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget,
              data = new FormData(form);
            setBusy(true);
            setError("");
            try {
              await api("/connections", {
                provider: data.get("provider"),
                label: data.get("label"),
                secret: data.get("secret"),
              });
              form.reset();
              setApiForm(false);
              await onChange();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="note">
            This explicitly uses API billing and Loop's own agent runtime. It
            does not inherit a desktop harness session.
          </p>
          <label>
            Provider
            <select name="provider">
              <option value="openai">OpenAI API</option>
              <option value="anthropic">Anthropic API</option>
            </select>
          </label>
          <label>
            Label
            <input name="label" required maxLength={80} />
          </label>
          <label>
            API key
            <input type="password" name="secret" required autoComplete="off" />
          </label>
          <button className="primary" disabled={busy}>
            Connect API key
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
