import { useEffect, useRef, useState } from "react";
import { Orbit, ShieldCheck } from "lucide-react";
import { authorize, clearAuthorization } from "./api";
import { executionSourceId } from "./sourceRouting";
import { fleetDeviceFromLink } from "../shared/fleet-pairing";
function readPairing(): {
  input: ReturnType<typeof fleetDeviceFromLink> | undefined;
  error: string;
} {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (!fragment.has("pair") && !fragment.has("fleet"))
    return { input: undefined, error: "" };
  try {
    return {
      input: fleetDeviceFromLink(location.href, location.origin),
      error: "",
    };
  } catch (error) {
    return {
      input: undefined,
      error:
        error instanceof Error ? error.message : "Use a fresh pairing link.",
    };
  } finally {
    // Retain only the device projection in memory; never submit the enrollment
    // half to /pair, persist it, or leave either capability in browser history.
    history.replaceState(null, "", location.pathname + location.search);
  }
}
export function Pairing({ onDone }: { onDone: () => void }) {
  const [pairing, setPairing] = useState(readPairing);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(pairing.error);
  const lock = useRef(false);
  useEffect(() => {
    const opened = () => {
      const fragment = new URLSearchParams(location.hash.slice(1));
      if (!fragment.has("pair") && !fragment.has("fleet")) return;
      const next = readPairing();
      // Scrub a new link even while an earlier confirmation is in flight.
      // The submitted request keeps its original, device-only projection.
      setPairing(next);
      setError(next.error);
    };
    window.addEventListener("hashchange", opened);
    // Navigation can occur after the first render but before this effect is
    // installed. Process the current fragment as well as subsequent events.
    // An already scrubbed fragment must not clear the retained device input.
    opened();
    return () => window.removeEventListener("hashchange", opened);
  }, []);
  async function pair() {
    if (lock.current || !pairing.input) return;
    lock.current = true;
    setBusy(true);
    setError("");
    history.replaceState(null, "", location.pathname + location.search);
    try {
      const response = await fetch("/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...pairing.input, name: "Phone" }),
        credentials: "same-origin",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Pairing failed");
      pairing.input = undefined;
      clearAuthorization();
      if (executionSourceId()) {
        location.reload();
        return;
      }
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
        {pairing.input ? (
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
