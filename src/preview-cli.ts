import { parseArgs, promisify } from "node:util";
import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { atomic } from "./state.js";
import { workspaceLock, recordedChildren } from "./process-records.js";

import { selectedHarnesses } from "./start-selection.js";
import {
  previewManifest,
  previewMode,
  previewName,
  PREVIEW_MARKER,
  type PreviewManifest,
} from "./preview-context.js";

const exec = promisify(execFile);
const publicOrigin = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/"
      );
    } catch {
      return false;
    }
  }, "Public origin must be a bare HTTPS origin.");
const recordSchema = z
  .object({
    schema: z.literal(1),
    id: z.string().uuid(),
    name: previewName,
    source: z.string().min(1),
    mode: previewMode,
    localOnly: z.boolean(),
    publicUrl: publicOrigin.optional(),
    providers: z.string().optional(),
    createdAt: z.string(),
    build: z.string().uuid().optional(),
  })
  .strict();
type Record = z.infer<typeof recordSchema>;

/** Do not inherit the running Loop's state, keys, service, tunnel or runtime. */
export function previewEnvironment(
  env: NodeJS.ProcessEnv,
  mode: "design" | "working",
): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      if (key.startsWith("LOOP_TEST_")) return env.NODE_ENV === "test";
      if (
        /^(LOOP_|GIT_)/.test(key) ||
        ["PORT", "NODE_OPTIONS", "NODE_PATH"].includes(key)
      )
        return false;
      if (mode === "design" && /(?:_KEY|_TOKEN|SECRET|PASSWORD)$/.test(key))
        return false;
      return true;
    }),
  );
  clean.NODE_ENV = env.NODE_ENV === "test" ? "test" : "production";
  return clean;
}

type DirectoryAccess = { allowOtherReads?: boolean };
async function privateDirectory(path: string, access: DirectoryAccess = {}) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(path, access);
}
async function assertPrivateDirectory(
  path: string,
  access: DirectoryAccess = {},
) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & (access.allowOtherReads ? 0o022 : 0o077)) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error(
      "Preview directories must be real directories owned by this user and " +
        (access.allowOtherReads
          ? "not writable by group or others: "
          : "accessible only to this user: ") +
        path,
    );
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function git(source: string, ...args: string[]) {
  return (
    await exec("git", ["-C", source, ...args], {
      env: previewEnvironment(process.env, "design"),
      maxBuffer: 32 * 1024 * 1024,
    })
  ).stdout.trimEnd();
}
async function sourceCheckout(path: string) {
  const source = await realpath(path);
  if ((await git(source, "rev-parse", "--show-toplevel")) !== source)
    throw new Error(
      "Choose the root of a Loop Git checkout with --project PATH.",
    );
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (pkg.name !== "@j-asefa/loop" || !pkg.scripts?.build)
    throw new Error("Choose a Loop checkout with a build script.");
  return source;
}
async function sourceFacts(source: string) {
  const commit = await git(source, "rev-parse", "HEAD");
  const branch = await git(
    source,
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ).catch(() => "detached");
  const dirty = !!(await git(source, "status", "--porcelain"));
  const paths = [
    ...new Set(
      (
        await git(
          source,
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
        )
      )
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const hash = createHash("sha256").update(commit);
  for (const path of paths) {
    hash.update(path + "\0");
    try {
      const info = await lstat(join(source, path));
      hash.update(String(info.mode));
      if (info.isSymbolicLink())
        hash.update(await readlink(join(source, path)));
      else if (info.isFile()) hash.update(await readFile(join(source, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("deleted");
    }
  }
  return { commit, branch, dirty, sourceHash: hash.digest("hex") };
}
async function artifactHash(
  path: string,
  hash = createHash("sha256"),
  prefix = "",
) {
  for (const name of (await readdir(path)).sort()) {
    const relative = prefix + name,
      file = join(path, name),
      info = await lstat(file);
    hash.update(relative + "\0");
    if (info.isSymbolicLink()) hash.update(await readlink(file));
    else if (info.isDirectory()) await artifactHash(file, hash, relative + "/");
    else if (info.isFile()) hash.update(await readFile(file));
  }
  return hash;
}
function command(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: "inherit" });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const finish = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
    child.once("error", (error) => {
      finish();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      finish();
      code === 0
        ? resolve()
        : reject(new Error(`${file} ${args[0]} failed (${signal || code}).`));
    });
  });
}
function launchPaths(dir: string, record: Record, build = record.build) {
  if (!build)
    throw new Error(
      "This preview has no successful build. Run loop preview rebuild " +
        record.name,
    );
  const stage = join(dir, "builds", z.string().uuid().parse(build));
  return {
    stage,
    cli: join(stage, "dist", "cli.js"),
    manifest: join(stage, "preview.json"),
  };
}
async function launchEnvironment(
  dir: string,
  record: Record,
  build = record.build,
) {
  const paths = launchPaths(dir, record, build);
  const manifest = previewManifest.parse(
    JSON.parse(await readFile(paths.manifest, "utf8")),
  );
  if (
    manifest.previewId !== record.id ||
    manifest.mode !== record.mode ||
    manifest.name !== record.name ||
    manifest.home !== join(dir, "runtime") ||
    manifest.build.id !== build
  )
    throw new Error("Preview build identity does not match its registration.");
  return {
    ...previewEnvironment(process.env, record.mode),
    LOOP_HOME: manifest.home,
    LOOP_PREVIEW_MANIFEST: paths.manifest,
  };
}
async function run(
  dir: string,
  record: Record,
  args: string[],
  build = record.build,
) {
  const paths = launchPaths(dir, record, build);
  await command(
    process.execPath,
    [paths.cli, ...args],
    paths.stage,
    await launchEnvironment(dir, record, build),
  );
}
async function status(dir: string, record: Record) {
  if (!record.build) return { state: "unbuilt" };
  const paths = launchPaths(dir, record);
  const output = await exec(process.execPath, [paths.cli, "status", "--json"], {
    cwd: paths.stage,
    env: await launchEnvironment(dir, record),
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(output.stdout);
}
async function build(dir: string, record: Record) {
  const source = await sourceCheckout(record.source);
  // Different preview names can point at the same checkout and its dist directory.
  const locks = join(source, ".tmp");
  // The checkout's scratch directory can be readable; it stores locks, not executable builds.
  await privateDirectory(locks, { allowOtherReads: true });
  const unlock = workspaceLock(locks, {
    name: "preview-build.lock",
    owner:
      "Another preview is building this checkout. Wait for it to finish, then rebuild.",
  });
  try {
    return await buildCheckout(dir, record, source);
  } finally {
    unlock();
  }
}
async function buildCheckout(dir: string, record: Record, source: string) {
  // npm scripts need the development dependencies even though launches use production mode.
  const env = {
    ...previewEnvironment(process.env, record.mode),
    NODE_ENV: "development",
  };
  if (!(await exists(join(source, "node_modules", ".package-lock.json"))))
    await command("npm", ["ci", "--no-audit", "--no-fund"], source, env);
  const before = await sourceFacts(source);
  console.log(
    `Building preview ${record.name} from ${before.branch}${before.dirty ? " (with local edits)" : ""}…`,
  );
  await command("npm", ["run", "build"], source, env);
  const after = await sourceFacts(source);
  if (before.sourceHash !== after.sourceHash || before.branch !== after.branch)
    throw new Error(
      "The checkout changed during the build. Rebuild again once edits have finished; the running preview was kept.",
    );
  const id = randomUUID(),
    stage = join(dir, "builds", id);
  await privateDirectory(stage);
  try {
    for (const entry of [
      "dist",
      "migrations",
      "runtime",
      "package.json",
      "package-lock.json",
    ])
      await cp(join(source, entry), join(stage, entry), {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });
    const digest = (await artifactHash(stage)).digest("hex");
    const staged = await sourceFacts(source);
    if (
      before.sourceHash !== staged.sourceHash ||
      before.branch !== staged.branch
    )
      throw new Error(
        "The checkout changed while staging the build. Rebuild again once edits have finished; the running preview was kept.",
      );
    // Builds own their application files. Dependency installation remains owned by the checkout.
    await symlink(
      join(source, "node_modules"),
      join(stage, "node_modules"),
      "dir",
    );
    const manifest: PreviewManifest = {
      schema: 1,
      previewId: record.id,
      name: record.name,
      mode: record.mode,
      home: join(dir, "runtime"),
      build: {
        id,
        ...before,
        builtAt: new Date().toISOString(),
        artifactHash: digest,
      },
    };
    atomic(join(stage, "preview.json"), manifest);
    return id;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
function startArgs(record: Record) {
  return [
    "start",
    "--project",
    record.source,
    ...(record.localOnly ? ["--local-only"] : []),
    ...(record.publicUrl ? ["--public-url", record.publicUrl] : []),
    ...(record.providers ? ["--providers", record.providers] : []),
  ];
}
const HELP = `Loop previews — experiment before merging

loop preview create NAME [--from REF] [--project LOOP_CHECKOUT]
                         Create a branch/worktree, build and start it.
loop preview start NAME [--project LOOP_CHECKOUT]
                         Start a saved preview, or preview this checkout including local edits.
loop preview rebuild NAME [--force]  Build first, then replace this preview's application.
loop preview open NAME               Print a fresh phone pairing link and QR code.
loop preview status NAME [--json]
loop preview list [--json]
loop preview logs NAME [--follow]
loop preview stop NAME               Stop this preview and its tunnel; retain data and code.
loop preview discard NAME            Stop and remove preview state/builds; retain checkout/branch.

New previews: --mode design|working (default design), --local-only or --public-url URL,
              --providers LIST (working previews only).
Design previews use sample data and simulated replies. Working previews use the host's harness sign-ins.
The default phone tunnel keeps its address across rebuilds, but can change after stop.
Preview storage: LOOP_PREVIEWS_DIR or ~/.local/state/loop-previews.
No command installs globally, changes the everyday Loop service, merges, or deletes source code.`;

export async function previewCli(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      project: { type: "string" },
      from: { type: "string" },
      mode: { type: "string" },
      "local-only": { type: "boolean" },
      "public-url": { type: "string" },
      providers: { type: "string" },
      force: { type: "boolean" },
      json: { type: "boolean" },
      follow: { type: "boolean", short: "f" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(HELP);
    return;
  }
  const [action, name] = positionals;
  if (
    ![
      "create",
      "start",
      "rebuild",
      "open",
      "status",
      "list",
      "logs",
      "stop",
      "discard",
    ].includes(action) ||
    positionals.length > (action === "list" ? 1 : 2)
  )
    throw new Error("Unknown preview command. See loop preview --help.");
  if (action !== "list") previewName.parse(name);
  if (values["local-only"] && values["public-url"])
    throw new Error("Choose --local-only or --public-url.");
  if (values["public-url"] !== undefined)
    publicOrigin.parse(values["public-url"]);
  if (values.providers !== undefined) selectedHarnesses(values.providers);
  if (values.from && action !== "create")
    throw new Error("--from applies to preview create.");
  if (
    !["create", "start"].includes(action) &&
    [
      values.project,
      values.mode,
      values.providers,
      values["local-only"],
      values["public-url"],
    ].some((v) => v !== undefined)
  )
    throw new Error(
      "Source, mode and connection options apply only when creating a preview.",
    );
  const base = resolve(
    process.env.LOOP_PREVIEWS_DIR ||
      join(join(homedir(), ".local", "state"), "loop-previews"),
  );
  await privateDirectory(base);
  const registry = join(await realpath(base), "previews");
  await privateDirectory(registry);
  if (action === "list") {
    const items = [];
    for (const entry of (await readdir(registry)).sort()) {
      if (!previewName.safeParse(entry).success) continue;
      const dir = join(registry, entry);
      try {
        await assertPrivateDirectory(dir);
        const record = recordSchema.parse(
          JSON.parse(await readFile(join(dir, "preview.json"), "utf8")),
        );
        if (record.name !== entry) throw new Error("Preview name mismatch");
        items.push({
          name: entry,
          mode: record.mode,
          source: record.source,
          ...(await status(dir, record)),
        });
      } catch (error) {
        // Discard may have removed this entry since readdir. Listing never recreates it.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        items.push({ name: entry, state: "unavailable" });
      }
    }
    console.log(
      values.json
        ? JSON.stringify(items)
        : items
            .map(
              (r) =>
                `${r.name}: ${r.state}${"url" in r && r.url ? " · " + r.url : ""}`,
            )
            .join("\n") || "No previews yet. Run loop preview create NAME.",
    );
    return;
  }
  const dir = join(registry, name);
  if (!(await exists(dir)) && !["create", "start"].includes(action))
    throw new Error("Unknown preview: " + name);
  await privateDirectory(dir);
  const unlock = workspaceLock(dir, {
    name: "preview.lock",
    owner: "Another command is changing this preview. Wait for it to finish.",
  });
  try {
    const recordPath = join(dir, "preview.json");
    let record: Record;
    if (await exists(recordPath)) {
      record = recordSchema.parse(
        JSON.parse(await readFile(recordPath, "utf8")),
      );
      if (record.name !== name)
        throw new Error("Preview registration does not match its directory.");
      if (action === "create")
        throw new Error(
          "Preview already exists. Use start, rebuild or a different name.",
        );
      if (
        [
          values.project,
          values.mode,
          values.providers,
          values["local-only"],
          values["public-url"],
        ].some((v) => v !== undefined)
      )
        throw new Error(
          "This preview's source, mode and connection are already saved. Create another preview to change them.",
        );
    } else {
      if (!["create", "start"].includes(action))
        throw new Error("Preview registration is missing.");
      const mode = previewMode.parse(values.mode || "design");
      if (mode === "design" && values.providers)
        throw new Error(
          "Design previews do not connect providers. Choose --mode working for real execution.",
        );
      let source = await sourceCheckout(
        resolve(values.project || process.cwd()),
      );
      const previewId = randomUUID();
      if (action === "create") {
        if (!values.from && (await git(source, "status", "--porcelain")))
          throw new Error(
            "Commit the experiment's starting point, choose --from REF, or use preview start NAME --project PATH to include local edits.",
          );
        const ref = await git(
          source,
          "rev-parse",
          "--verify",
          "--end-of-options",
          (values.from || "HEAD") + "^{commit}",
        );
        const checkouts = join(base, "checkouts");
        await privateDirectory(checkouts);
        const target = join(checkouts, `${name}-${previewId.slice(0, 8)}`);
        const branch = `preview/${name}-${previewId.slice(0, 8)}`;
        await git(source, "worktree", "add", "-b", branch, target, ref);
        source = target;
        console.log(`Experiment checkout: ${source}\nBranch: ${branch}`);
      }
      record = {
        schema: 1,
        id: previewId,
        name,
        source,
        mode,
        localOnly: !!values["local-only"],
        ...(values["public-url"] ? { publicUrl: values["public-url"] } : {}),
        ...(values.providers ? { providers: values.providers } : {}),
        createdAt: new Date().toISOString(),
      };
      recordSchema.parse(record);
      await privateDirectory(join(dir, "runtime"));
      await privateDirectory(join(dir, "runtime", "workspace"));
      atomic(join(dir, "runtime", "workspace", PREVIEW_MARKER), {
        schema: 1,
        previewId,
        mode,
      });
      atomic(recordPath, record);
    }
    if (["create", "start", "rebuild"].includes(action)) {
      const before = await status(dir, record);
      const replace = action === "rebuild" || !record.build;
      const next = replace ? await build(dir, record) : record.build!;
      const running = !["stopped", "unbuilt", "crashed"].includes(before.state);
      if (record.mode === "working")
        console.log(
          "Working preview: native harnesses retain their host sign-ins and filesystem access.",
        );
      try {
        await run(
          dir,
          record,
          running && replace
            ? ["restart", ...(values.force ? ["--force"] : [])]
            : startArgs(record),
          next,
        );
      } finally {
        // A failed restart can leave an uncertain outcome. Record only an observed serving build.
        const candidate = { ...record, build: next };
        const observed = await status(dir, candidate).catch(() => undefined);
        if (observed?.preview?.build?.id === next) {
          record = candidate;
          atomic(recordPath, record);
        } else if (!record.build) {
          record.build = next;
          atomic(recordPath, record);
        }
      }
      const observed = await status(dir, record);
      if (observed?.preview?.build?.id !== next)
        throw new Error(
          "The requested build is not confirmed as running. Inspect preview status and logs before retrying.",
        );
      console.log(
        `Preview ${name}: ${observed.url}\nEdit: ${record.source}\nRebuild: loop preview rebuild ${name}`,
      );
      return;
    }
    if (action === "status") {
      const observed = await status(dir, record);
      console.log(
        values.json
          ? JSON.stringify({
              name,
              mode: record.mode,
              source: record.source,
              ...observed,
            })
          : `${name} · ${record.mode} · ${observed.state}\nCheckout: ${record.source}${observed.url ? "\n" + observed.url : ""}${observed.preview ? "\nServing build: " + observed.preview.build.id + " · " + observed.preview.build.commit.slice(0, 12) : ""}`,
      );
      return;
    }
    if (action === "open") return run(dir, record, ["pair"]);
    // Return without awaiting: finally releases the mutation lock while logs follow.
    if (action === "logs")
      return run(dir, record, ["logs", ...(values.follow ? ["--follow"] : [])]);
    const observed = await status(dir, record);
    const children = await recordedChildren(join(dir, "runtime", "workspace"));
    if (
      children.length ||
      (observed.state !== "unbuilt" &&
        (observed.state !== "stopped" ||
          observed.connection?.state !== "stopped"))
    )
      await run(dir, record, ["stop"]);
    if (action === "discard") {
      // The registered source checkout and branch always survive a discard.
      await rm(dir, { recursive: true, force: true });
      console.log(
        `Discarded preview ${name}. Source retained at ${record.source}`,
      );
    } else console.log(`Stopped preview ${name}. State and source retained.`);
  } finally {
    unlock();
  }
}
