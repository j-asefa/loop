import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

// Only the CLI's specific already-stopped response is idempotent. Other stop
// failures can represent unresolved owned processes and must retain test state.
// Confirm both application and connection are stopped, including after exit 0.
export async function stopAcceptanceCompanion(command) {
  try {
    let alreadyStopped = false;
    try {
      await command(["stop"]);
    } catch (error) {
      if (
        error.code !== 1 ||
        error.stdout?.trim() !== "" ||
        error.stderr?.trim() !== "Loop: No workspace is running."
      )
        throw error;
      alreadyStopped = true;
    }
    const status = JSON.parse((await command(["status", "--json"])).stdout);
    if (status.state !== "stopped" || status.connection?.state !== "stopped")
      throw new Error("The companion is not fully stopped.");
    return alreadyStopped ? "already-stopped" : "stopped";
  } catch {
    // execFile failures can contain private output. Do not expose that object.
    throw new Error(
      "Cleanup could not confirm the isolated companion stopped.",
    );
  }
}

// The real-tunnel runner creates fresh projects and must not import global Git
// hooks or discover the user's existing local Docker workspaces. Keep HOME and
// network trust intact; only these child tools receive private configuration.
export async function isolateAcceptanceEnvironment(env, directory) {
  const configuration = join(directory, "command-config");
  await mkdir(configuration, { mode: 0o700 });
  const git = join(configuration, "git.config");
  const template = join(configuration, "git-template");
  const docker = join(configuration, "docker");
  await mkdir(template, { mode: 0o700 });
  await mkdir(docker, { mode: 0o700 });
  await writeAcceptanceFile(git, "");
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: git,
    GIT_TEMPLATE_DIR: template,
    DOCKER_CONFIG: docker,
    DOCKER_HOST: "unix://" + join(configuration, "no-docker.sock"),
  };
}

// Replace the named output, not the target of a pre-existing symlink. A failed
// write leaves the previous report intact and removes only our exclusive file.
export async function writeAcceptanceFile(path, content) {
  const temporary = join(
    dirname(path),
    `.fleet-acceptance-${randomUUID()}.tmp`,
  );
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

// Capture the installed connection implementation at launch. An application
// upgrade can replace this package while its existing tunnel stays running.
export async function installedTunnelMeasurements(packageRoot) {
  const source = await readFile(join(packageRoot, "dist/tunnel.js"), "utf8");
  const version = source.match(
    /^(?:const|let|var)\s+RELEASE\s*=\s*["'](\d{4}\.\d+\.\d+)["'];?$/m,
  )?.[1];
  if (!version)
    throw new Error("The installed package has no recognized tunnel pin.");
  return (text) => ({
    expectedVersion: version,
    ...tunnelMeasurements(text, version),
  });
}

const metricNames = [
  "cloudflared_tunnel_total_requests",
  "cloudflared_tunnel_concurrent_requests_per_tunnel",
  "cloudflared_tunnel_request_errors",
  "cloudflared_tunnel_active_streams",
  "process_resident_memory_bytes",
  "go_memstats_alloc_bytes",
];

export function fixtureMeasurements(log) {
  return log
    .split("\n")
    .filter((line) => /^(?:[#ℹ] )?FLEET_METRIC /.test(line))
    .map((line) => JSON.parse(line.replace(/^(?:[#ℹ] )?FLEET_METRIC /, "")));
}

// Never copy error messages, captured command output, request objects or URLs.
export function safeFailure(error) {
  const kinds = [
    "Error",
    "AssertionError",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "TimeoutError",
    "AbortError",
  ];
  const result = {
    kind: kinds.includes(error?.name) ? error.name : "Error",
  };
  const networkCodes = [
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
    "UND_ERR_ABORTED",
    "UND_ERR_DESTROYED",
    "UND_ERR_CLOSED",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ];
  const code = error?.cause?.code ?? error?.code;
  if (networkCodes.includes(code)) result.networkCode = code;
  if (Array.isArray(error?.cause?.errors)) {
    const attempts = error.cause.errors.slice(0, 8).flatMap((attempt) => {
      if (!networkCodes.includes(attempt?.code)) return [];
      const family =
        typeof attempt.address === "string" ? isIP(attempt.address) : 0;
      return [{ code: attempt.code, ...(family ? { family } : {}) }];
    });
    if (attempts.length) result.networkAttempts = attempts;
  }
  if (
    [
      "pair-link",
      "pair-readiness",
      "pair-submit",
      "pair-session",
      "pair-state",
    ].includes(error?.phase)
  )
    result.phase = error.phase;
  for (const key of ["exit", "status", "expected", "actual"])
    if (
      typeof error?.[key] === "boolean" ||
      (typeof error?.[key] === "number" && Number.isFinite(error[key]))
    )
      result[key] = error[key];
  const sources =
    typeof error?.stack === "string"
      ? [
          ...error.stack.matchAll(
            /\/(fleet-acceptance(?:-observations)?\.mjs):(\d+):(\d+)/g,
          ),
        ].slice(0, 2)
      : [];
  for (const [index, source] of sources.entries())
    result[index ? "caller" : "source"] = {
      file: source[1],
      line: Number(source[2]),
      column: Number(source[3]),
    };
  return result;
}

export function tunnelMeasurements(text, expectedVersion) {
  // Match the test daemon's expected binary before consuming any observations.
  // Prometheus labels can include origins/tunnel identities: never return them.
  const build = text.match(/^build_info\{([^\n]+)\} 1$/m)?.[1];
  if (
    !build ||
    !expectedVersion ||
    build.match(/(?:^|,)version="([^"]+)"(?:,|$)/)?.[1] !== expectedVersion
  )
    return { state: "unavailable", reason: "unexpected-metrics-build" };
  const values = Object.fromEntries(metricNames.map((name) => [name, null]));
  for (const line of text.split("\n")) {
    const match = line.match(
      /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\{[^\n]*\})? ([+\-\deE.]+)(?: \d+)?$/,
    );
    if (!match || !metricNames.includes(match[1])) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < 0) continue;
    values[match[1]] = (values[match[1]] ?? 0) + value;
  }
  return { state: "observed", values };
}
