import { useState } from "react";
import { UncertainEffect } from "./pendingCommands";

export function EffectRecovery({
  failure,
  onReady,
}: {
  failure: UncertainEffect;
  onReady(): void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section aria-label="Unconfirmed change">
      <p>
        The previous change may have completed. Check the current state if
        possible; status alone may not prove what happened. Starting a new
        command may repeat the change.
      </p>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I understand that a new command may repeat the previous change.
      </label>
      <button
        type="button"
        disabled={!confirmed || busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await failure.supersede();
            onReady();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Allow a new command
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
