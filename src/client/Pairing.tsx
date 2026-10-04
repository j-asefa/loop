import { useRef, useState } from "react";
import { Orbit, ShieldCheck } from "lucide-react";
import { authorize, clearAuthorization } from "./api";
export function Pairing({ onDone }: { onDone: () => void }) {
  const secret = useRef(
    new URLSearchParams(location.hash.slice(1)).get("pair") || "",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  async function pair() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    history.replaceState(null, "", location.pathname + location.search);
    try {
      const response = await fetch("/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: secret.current, name: "Phone" }),
        credentials: "same-origin",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Pairing failed");
      secret.current = "";
      clearAuthorization();
      await authorize();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-story">
        <div className="wordmark">
          <Orbit />
          loop
          <span className="wordmark-dot" />
        </div>
        <div>
          <span className="eyebrow">Your workspace, with you</span>
          <h1>
            Keep your agents.
            <br />
            Stay in the loop.
          </h1>
          <p>One workspace for your ideas, agents, and everything they make.</p>
        </div>
        <span className="muted">
          <ShieldCheck size={15} /> Your paired devices control this workspace.
        </span>
      </div>
      <section className="auth-form">
        <h2>Pair this device</h2>
        <p>
          This device will be able to create and control agents using your
          desktop harnesses, tools and files.
        </p>
        {secret.current ? (
          <button
            className="primary"
            onClick={() => void pair()}
            disabled={busy}
          >
            {busy ? "Pairing…" : "Pair and open Loop"}
          </button>
        ) : (
          <p className="note">
            Run <code>loop pair</code> on your desktop and scan the new QR code.
            No Loop account is needed.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
