import type { Connection } from "../shared/types";
import { connectionLocation } from "./modelChoices";

// Connection metadata describes the last successful registration, not a live
// check of a runner's binaries or credentials.
export function ConnectionDetails({ connection }: { connection: Connection }) {
  let metadata: Record<string, any> = {};
  try {
    const value = JSON.parse(connection.metadata);
    if (value && typeof value === "object" && !Array.isArray(value))
      metadata = value;
  } catch {}
  const billing =
    typeof metadata.billing === "string" && metadata.billing.trim()
      ? metadata.billing
      : typeof metadata.billing?.description === "string" &&
          metadata.billing.description.trim()
        ? metadata.billing.description
        : "Billing not reported. Refresh this connection before use.";
  const location = connectionLocation(connection).label;
  return (
    <div className="connection-details">
      <p>
        {location} · {connection.status}
      </p>
      <p>{billing}</p>
      {metadata.loopHarness && (
        <p className="note">
          This is saved connection information, not a live sign-in or runtime
          availability check. Sign-in stays on this computer.
        </p>
      )}
    </div>
  );
}
