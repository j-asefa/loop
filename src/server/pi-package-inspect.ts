import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve, join, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";

type Manifest = {
  name?: string;
  version?: string;
  description?: string;
  pi?: Record<string, unknown>;
};
export type PackageInspection = {
  source: string;
  inspected: boolean;
  resolved?: string;
  name?: string;
  description?: string;
  resources: Record<string, string[]>;
  note?: string;
};
const kinds = ["extensions", "skills", "prompts", "themes"] as const;
function summarize(
  source: string,
  manifest: Manifest | undefined,
  paths: string[],
  resolved?: string,
): PackageInspection {
  const resources: Record<string, string[]> = {};
  for (const kind of kinds) {
    const explicit = manifest?.pi?.[kind];
    resources[kind] = Array.isArray(explicit)
      ? explicit.filter((x): x is string => typeof x === "string").slice(0, 100)
      : paths
          .filter((path) => path.startsWith(`${kind}/`) && path !== `${kind}/`)
          .slice(0, 100);
  }
  return {
    source,
    inspected: true,
    resolved,
    name: manifest?.name,
    description: manifest?.description,
    resources,
  };
}
async function getJson(url: string) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    redirect: "error",
    headers: { Accept: "application/json", "User-Agent": "loop-pi-inspection" },
  });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  const raw = await response.text();
  if (raw.length > 2_000_000) throw new Error("Source metadata is too large");
  return JSON.parse(raw);
}
async function tarballIndex(url: string) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.hostname !== "registry.npmjs.org")
    throw new Error("Registry tarball host is unsupported");
  const response = await fetch(target, {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Tarball returned HTTP ${response.status}`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body || []) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > 12_000_000)
      throw new Error("Package tarball is too large to inspect");
    chunks.push(bytes);
  }
  const tar = gunzipSync(Buffer.concat(chunks), {
    maxOutputLength: 30_000_000,
  });
  const paths: string[] = [];
  let manifest: Manifest | undefined;
  for (let offset = 0; offset + 512 <= tar.length && paths.length < 10000;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break;
    const prefix = header
      .subarray(345, 500)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const path = (prefix ? prefix + "/" : "") + name;
    const size = Number.parseInt(
      header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() ||
        "0",
      8,
    );
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > tar.length)
      throw new Error("Invalid package tarball");
    const relative = path.replace(/^package\//, "");
    if (relative !== path) paths.push(relative);
    if (relative === "package.json" && size < 300_000)
      manifest = JSON.parse(
        tar.subarray(offset + 512, offset + 512 + size).toString("utf8"),
      );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { paths, manifest };
}

export async function inspectPiPackage(
  source: string,
  project: string,
): Promise<PackageInspection> {
  try {
    if (source.startsWith("./")) {
      const canonicalProject = realpathSync(project);
      const path = realpathSync(resolve(canonicalProject, ".pi", source));
      if (
        !path.startsWith(canonicalProject + sep) ||
        !statSync(path).isDirectory()
      )
        throw new Error("Local source must be a project directory");
      const manifestPath = join(path, "package.json");
      const manifest = existsSync(manifestPath)
        ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest)
        : undefined;
      const paths = kinds.flatMap((kind) =>
        existsSync(join(path, kind))
          ? readdirSync(join(path, kind)).map((name) => `${kind}/${name}`)
          : [],
      );
      return summarize(source, manifest, paths, path);
    }
    if (source.startsWith("npm:")) {
      const spec = source.slice(4);
      const match = spec.match(/^(@[^/]+\/[^@]+|[^@/]+)(?:@(.+))?$/);
      if (!match) throw new Error("Invalid npm package name");
      const metadata = await getJson(
        `https://registry.npmjs.org/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2] || "latest")}`,
      );
      const { paths, manifest } = await tarballIndex(metadata.dist?.tarball);
      return summarize(
        source,
        manifest,
        paths,
        `${match[1]}@${metadata.version}`,
      );
    }
    const git = source.match(
      /^git:github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:@(.+))?$/,
    );
    if (git) {
      const [, owner, repo, ref = "HEAD"] = git;
      const tree = await getJson(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      );
      const item = await getJson(
        `https://api.github.com/repos/${owner}/${repo}/contents/package.json?ref=${encodeURIComponent(ref)}`,
      ).catch(() => null);
      const manifest = item?.content
        ? (JSON.parse(
            Buffer.from(item.content, "base64").toString("utf8"),
          ) as Manifest)
        : undefined;
      const result = summarize(
        source,
        manifest,
        (tree.tree || [])
          .map((x: any) => x.path)
          .filter((x: unknown): x is string => typeof x === "string"),
        tree.sha,
      );
      if (tree.truncated)
        result.note =
          "The Git tree was truncated; some resources may be missing.";
      return result;
    }
    throw new Error(
      "This Git source cannot be inspected automatically. Review its repository before installing.",
    );
  } catch (error) {
    return {
      source,
      inspected: false,
      resources: {},
      note: (error as Error).message,
    };
  }
}

/** A pin Pi can reinstall to restore the exact revision before an update. */
export function previousPiPackageSource(
  source: string,
  scope: "user" | "project",
  agentDir: string,
  project: string,
): string | undefined {
  const base = scope === "user" ? agentDir : join(project, ".pi");
  const npm = source.match(/^npm:(@[^/]+\/[^@]+|[^@/]+)(?:@.+)?$/);
  if (npm) {
    const path = join(base, "npm", "node_modules", npm[1], "package.json");
    if (!existsSync(path)) return;
    const version = JSON.parse(readFileSync(path, "utf8")).version;
    return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)
      ? `npm:${npm[1]}@${version}`
      : undefined;
  }
  const git = source.match(
    /^git:github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:@.+)?$/,
  );
  if (git) {
    const path = join(base, "git", "github.com", git[1], git[2]);
    if (!existsSync(path)) return;
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path,
      timeout: 5000,
      encoding: "utf8",
    }).trim();
    return /^[a-f0-9]{40}$/.test(sha)
      ? `git:github.com/${git[1]}/${git[2]}@${sha}`
      : undefined;
  }
}
