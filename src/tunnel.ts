import "../runtime/environment.mjs";
import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rename, rm, chmod } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as yaml } from "yaml";
import { createHash } from "node:crypto";
import { privateDir, atomic } from "./state.js";
import { own } from "./processes.js";
const exec = promisify(execFile);
const RELEASE = "2026.9.3";
// Release asset SHA-256 digests from cloudflare/cloudflared release 2026.9.3.
const BUILDS: Record<string, [string, string]> = {
  "linux-x64": [
    "cloudflared-linux-amd64",
    "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2",
  ],
  "linux-arm64": [
    "cloudflared-linux-arm64",
    "aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d",
  ],
  "darwin-x64": [
    "cloudflared-darwin-amd64.tgz",
    "d1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977",
  ],
  "darwin-arm64": [
    "cloudflared-darwin-arm64.tgz",
    "587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095",
  ],
};
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export async function helper(root: string) {
  const build = BUILDS[`${process.platform}-${process.arch}`];
  if (!build)
    throw new Error(
      "Automatic Quick Tunnels support macOS/Linux x64/arm64. Use a stable --public-url endpoint on other platforms.",
    );
  const dir = join(root, "helpers", RELEASE);
  privateDir(dir);
  const binary = join(dir, "cloudflared");
  try {
    const manifest = JSON.parse(
      await readFile(join(dir, "manifest.json"), "utf8"),
    );
    if (
      manifest.assetHash === build[1] &&
      digest(await readFile(binary)) === manifest.binaryHash
    )
      return binary;
  } catch {
    /* absent/corrupt owned helper is replaced from pinned release */
  }
  // The companion image seeds an immutable helper. Verify against the same
  // release digest before copying into persistent state; never trust its manifest.
  if (process.platform === "linux" && process.env.LOOP55_BAKED_HELPERS) {
    const bytes = await readFile(
      join(process.env.LOOP55_BAKED_HELPERS, "helpers", RELEASE, "cloudflared"),
    ).catch(() => undefined);
    if (bytes && digest(bytes) === build[1]) {
      await writeFile(binary, bytes, { mode: 0o700 });
      await chmod(binary, 0o700);
      atomic(join(dir, "manifest.json"), {
        assetHash: build[1],
        binaryHash: build[1],
        version: RELEASE,
      });
      return binary;
    }
  }
  const response = await fetch(
    `https://github.com/cloudflare/cloudflared/releases/download/${RELEASE}/${build[0]}`,
    { signal: AbortSignal.timeout(120000) },
  );
  if (!response.ok || !response.body)
    throw new Error(
      `cloudflared download failed (${response.status}). Retry or configure --public-url.`,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 100 * 1024 * 1024)
      throw new Error("Helper download exceeds limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (digest(bytes) !== build[1])
    throw new Error(
      "cloudflared integrity check failed. Download was not executed.",
    );
  const tmp = join(dir, "download-" + process.pid);
  await writeFile(tmp, bytes, { mode: 0o600 });
  try {
    if (build[0].endsWith(".tgz")) {
      const { stdout } = await exec("tar", ["-tzf", tmp], { maxBuffer: 10000 });
      if (
        !stdout
          .trim()
          .split("\n")
          .every((n) => ["cloudflared", "./cloudflared"].includes(n))
      )
        throw new Error("Unexpected helper archive");
      await exec("tar", ["-xzf", tmp, "-C", dir]);
    } else await rename(tmp, binary);
    await chmod(binary, 0o700);
    atomic(join(dir, "manifest.json"), {
      assetHash: build[1],
      binaryHash: digest(await readFile(binary)),
      version: RELEASE,
    });
  } finally {
    await rm(tmp, { force: true });
  }
  return binary;
}
export function tunnelUrl(text: string) {
  return text.match(
    /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com(?=[\s|]|$)/,
  )?.[0];
}
export const RECONNECT_MAX_DELAY_MS = 60000;
type Connection = { start(): Promise<string>; stop(): Promise<void> };
/**
 * Keeps a Quick Tunnel up for as long as the workspace runs: after a drop or a
 * failed reconnect it retries with exponential backoff, reset on success.
 */
export class TunnelSupervisor {
  private current?: Connection;
  private stopped = false;
  private delay: number;
  private log: (message: string) => void;
  private initialDelay: number;
  private maxDelay: number;
  private schedule: (ms: number, run: () => void) => void;
  constructor(
    private open: (exited: () => void) => Connection,
    private changed: (origin: string, reconnected: boolean) => void,
    options: {
      log?: (message: string) => void;
      initialDelay?: number;
      maxDelay?: number;
      schedule?: (ms: number, run: () => void) => void;
    } = {},
  ) {
    this.log = options.log ?? console.error;
    this.initialDelay = options.initialDelay ?? 1000;
    this.maxDelay = options.maxDelay ?? RECONNECT_MAX_DELAY_MS;
    this.schedule =
      options.schedule ?? ((ms, run) => setTimeout(run, ms).unref());
    this.delay = this.initialDelay;
  }
  /** Connects once; a failure here is the caller's to report. */
  start() {
    return this.connect(false);
  }
  async stop() {
    this.stopped = true;
    await this.current?.stop();
  }
  private async connect(reconnected: boolean) {
    const tunnel = this.open(() => {
      if (this.stopped) return;
      this.log(
        `Quick Tunnel disconnected; reconnecting in ${this.delay / 1000}s. Desktop work continues.`,
      );
      this.retry();
    });
    this.current = tunnel;
    const origin = await tunnel.start();
    this.delay = this.initialDelay;
    if (!this.stopped) this.changed(origin, reconnected);
    return origin;
  }
  private retry() {
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, this.maxDelay);
    this.schedule(wait, () => {
      if (this.stopped) return;
      this.connect(true).catch((e: Error) => {
        this.log(e.message);
        if (!this.stopped) this.retry();
      });
    });
  }
}
export async function namedTunnelConfig(
  root: string,
  port: number,
  named: { name: string; origin: string; config?: string },
) {
  const source = named.config || join(homedir(), ".cloudflared", "config.yml");
  const contents = await readFile(source, "utf8").catch((error) => {
    if (named.config || error.code !== "ENOENT") throw error;
    return "{}";
  });
  const saved = parseYaml(contents) || {};
  if (saved.tunnel && saved.tunnel !== named.name)
    throw new Error(
      "Use the tunnel ID from your cloudflared config with --tunnel-name",
    );
  const config = join(root, "named-tunnel.yml");
  // Never expose the private runner or retain an old project's ingress rules.
  // Keep the existing tunnel identity and point its sole public origin at Loop55.
  const generated = {
    tunnel: named.name,
    ...(saved["credentials-file"]
      ? {
          "credentials-file": resolve(
            dirname(source),
            saved["credentials-file"],
          ),
        }
      : {}),
    ingress: [
      {
        hostname: new URL(named.origin).hostname,
        service: `http://127.0.0.1:${port}`,
      },
      { service: "http_status:404" },
    ],
  };
  await writeFile(config, yaml(generated), { mode: 0o600 });
  return config;
}
/**
 * Deterministic tests substitute a fake helper. Production images set
 * NODE_ENV=production, where only the pinned, verified helper runs.
 */
function testHelper() {
  return process.env.NODE_ENV !== "production"
    ? process.env.LOOP55_TEST_CLOUDFLARED || undefined
    : undefined;
}
export class Tunnel {
  private child?: ChildProcessWithoutNullStreams;
  /** The running cloudflared process, for status and acceptance evidence. */
  get pid() {
    return this.child?.exitCode === null ? this.child.pid : undefined;
  }
  private stopped = false;
  constructor(
    private root: string,
    private port: number,
    private exited: () => void,
    private named?: { name: string; origin: string; config?: string },
  ) {}
  async start(): Promise<string> {
    const binary = testHelper() ?? (await helper(this.root));
    if (this.stopped) throw new Error("Quick Tunnel startup cancelled.");
    let config = join(this.root, "quick-tunnel.yml");
    if (this.named) {
      const url = new URL(this.named.origin);
      if (
        url.protocol !== "https:" ||
        url.pathname !== "/" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Named tunnel requires a bare HTTPS origin");
      if (!/^[a-zA-Z0-9_-]+$/.test(this.named.name))
        throw new Error("Invalid tunnel name or ID");
    }
    if (this.named)
      config = await namedTunnelConfig(this.root, this.port, this.named);
    else await writeFile(config, "{}\n", { mode: 0o600 });
    if (this.stopped) throw new Error("Quick Tunnel startup cancelled.");
    this.child = spawn(
      binary,
      this.named
        ? [
            "tunnel",
            "--config",
            config,
            "--no-autoupdate",
            "run",
            this.named.name,
          ]
        : [
            "tunnel",
            "--config",
            config,
            "--no-autoupdate",
            "--url",
            `http://127.0.0.1:${this.port}`,
            "--protocol",
            "http2",
          ],
      { stdio: "pipe", shell: false },
    );
    // Recorded so a full stop can still find it if the service itself crashed.
    own(this.child);
    return new Promise((resolve, reject) => {
      let buffer = "",
        ready = false;
      const timer = setTimeout(() => {
        this.child?.kill();
        reject(
          new Error(
            "Quick Tunnel startup timed out. Check outbound Cloudflare connectivity or use --public-url.",
          ),
        );
      }, 45000);
      const data = (b: Buffer) => {
        if (this.stopped) return;
        buffer = (buffer + b.toString()).slice(-16000);
        const url = this.named
          ? /Registered tunnel connection/.test(buffer)
            ? this.named.origin
            : undefined
          : tunnelUrl(buffer);
        if (url && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(url);
        }
      };
      this.child!.stdout.on("data", data);
      this.child!.stderr.on("data", data);
      this.child!.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      this.child!.on("exit", () => {
        clearTimeout(timer);
        if (!ready)
          reject(new Error("Quick Tunnel exited before assigning an address."));
        else if (!this.stopped) this.exited();
      });
    });
  }
  async stop() {
    this.stopped = true;
    if (this.child?.exitCode === null) {
      const p = this.child;
      p.kill("SIGTERM");
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          p.kill("SIGKILL");
          r();
        }, 2000);
        p.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
}
