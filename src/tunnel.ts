import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rename, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { privateDir, atomic } from "./state.js";
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
export class Tunnel {
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;
  constructor(
    private root: string,
    private port: number,
    private exited: () => void,
  ) {}
  async start(): Promise<string> {
    const binary = await helper(this.root);
    if (this.stopped) throw new Error("Quick Tunnel startup cancelled.");
    const config = join(this.root, "quick-tunnel.yml");
    await writeFile(config, "{}\n", { mode: 0o600 });
    if (this.stopped) throw new Error("Quick Tunnel startup cancelled.");
    this.child = spawn(
      binary,
      [
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
        const url = tunnelUrl(buffer);
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
