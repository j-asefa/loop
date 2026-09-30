import type { Connection } from "../shared/types";

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
  const location =
    metadata.backend === "hapi"
      ? typeof metadata.environmentName === "string"
        ? metadata.environmentName
        : "Managed environment"
      : metadata.loopHarness
        ? "This computer"
        : "Server connection";
  return (
    <div className="connection-details">
      <p>
        {location} · {connection.status}
      </p>
      <p>{billing}</p>
      {(metadata.backend === "hapi" || metadata.loopHarness) && (
        <p className="note">
          This is saved connection information, not a live sign-in or runtime
          availability check. Sign-in stays on{" "}
          {location === "This computer"
            ? "this computer"
            : "the selected environment"}
          .
        </p>
      )}
    </div>
  );
}
