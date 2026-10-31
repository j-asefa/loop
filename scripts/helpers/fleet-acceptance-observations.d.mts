export function fixtureMeasurements(log: string): unknown[];

export function stopAcceptanceCompanion(
  command: (args: string[]) => Promise<{ stdout: string }>,
): Promise<"stopped" | "already-stopped">;

export function isolateAcceptanceEnvironment(
  env: NodeJS.ProcessEnv,
  directory: string,
): Promise<NodeJS.ProcessEnv>;

export function writeAcceptanceFile(
  path: string,
  content: string,
): Promise<void>;

export function installedTunnelMeasurements(
  packageRoot: string,
): Promise<
  (
    text: string,
  ) => ReturnType<typeof tunnelMeasurements> & { expectedVersion: string }
>;

export function safeFailure(error: unknown): {
  kind: string;
  networkCode?: string;
  networkAttempts?: { code: string; family?: number }[];
  phase?: string;
  exit?: number | boolean;
  status?: number | boolean;
  expected?: number | boolean;
  actual?: number | boolean;
  source?: { file: string; line: number; column: number };
  caller?: { file: string; line: number; column: number };
};

type TunnelMetric =
  | "cloudflared_tunnel_total_requests"
  | "cloudflared_tunnel_concurrent_requests_per_tunnel"
  | "cloudflared_tunnel_request_errors"
  | "cloudflared_tunnel_active_streams"
  | "process_resident_memory_bytes"
  | "go_memstats_alloc_bytes";

export function tunnelMeasurements(
  text: string,
  expectedVersion?: string,
):
  | { state: "unavailable"; reason: "unexpected-metrics-build" }
  | { state: "observed"; values: Record<TunnelMetric, number | null> };
