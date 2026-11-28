import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = process.env.LOOP_BEADS_RUNTIME_MODULE
  ? pathToFileURL(resolve(process.env.LOOP_BEADS_RUNTIME_MODULE)).href
  : new URL("../src/beads-runtime.ts", import.meta.url).href;
const { BeadsStore, beadsBinary, beadsRelease } = await import(moduleUrl);
const scope = { ownerId: "owner", profile: "companion", projectId: "project" };
const [, script, rootArg, action, id, request] = process.argv;

async function waitForWorkers(work) {
  const results = await Promise.allSettled(work);
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

if (rootArg) {
  const store = new BeadsStore(rootArg, scope);
  const receipt = join(rootArg, request);
  await writeFile(receipt, "prepared", { flush: true, flag: "wx" });
  if (action === "unsent") process.kill(process.pid, "SIGKILL");
  await writeFile(receipt, "dispatching", { flush: true });
  try {
    if (action === "claim") {
      await store.write(["--actor", request, "update", id, "--claim"]);
    } else {
      await store.write([
        "comments",
        "add",
        id,
        "--author",
        "owner",
        "--",
        "> Selected passage\n\nCheck this again.",
      ]);
    }
  } catch (error) {
    // An ordinary CLI failure is distinguishable from the injected hard kill.
    assert.match(error.cause?.stderr ?? "", /already claimed/);
    process.exit(17);
  }
  // This is the Loop-side crash window: bd exited after committing, and
  // the caller has yet to save a receipt or dispatch any agent work.
  process.kill(process.pid, "SIGKILL");
} else {
  const root = await mkdtemp(join(tmpdir(), "loop-beads-smoke-"));
  try {
    const installed = join(root, "beads-runtime", beadsRelease, "bd");
    const assetRoot = join(root, "release");
    const original = await beadsBinary(assetRoot);
    // Exercise the desktop cache even when a verified image asset seeded it.
    delete process.env.LOOP_BAKED_BEADS;
    const concurrentRoot = join(root, "concurrent");
    const published = join(concurrentRoot, "beads-runtime", beadsRelease, "bd");
    const fetchRelease = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        await copyFile(original, published);
        throw new Error("Simulated failed download after another publication");
      };
      assert.equal(await beadsBinary(concurrentRoot), published);
    } finally {
      globalThis.fetch = fetchRelease;
    }
    await mkdir(resolve(installed, ".."), { recursive: true });
    await copyFile(original, installed);
    const fallbackRoot = join(root, "occupied-cache");
    const occupied = join(fallbackRoot, "beads-runtime", beadsRelease, "bd");
    const alternate = occupied + ".loop-verified";
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, "keep.txt"), "existing data");
    await copyFile(original, alternate);
    assert.equal(await beadsBinary(fallbackRoot), alternate);
    assert.equal(
      await readFile(join(occupied, "keep.txt"), "utf8"),
      "existing data",
    );
    const store = new BeadsStore(root, scope);
    await waitForWorkers([store.initialize(), store.initialize()]);
    await chmod(installed, 0o601);
    assert.equal(await beadsBinary(root), installed);
    assert.deepEqual(await store.read(["list"]), []);
    const work = (action, id, request) =>
      once(
        spawn(
          process.execPath,
          [...process.execArgv, script, root, action, id, request],
          { stdio: "inherit" },
        ),
        "exit",
      );
    const create = async (name) => {
      const issue = await store.write(["create", "--title", name]);
      return issue.id;
    };
    const contested = await create("Claim contention");
    const claims = await waitForWorkers([
      work("claim", contested, "loop-start-first"),
      work("claim", contested, "loop-start-second"),
    ]);
    assert.equal(
      claims.filter(([code, signal]) => code === null && signal === "SIGKILL")
        .length,
      1,
    );
    assert.equal(claims.filter(([code]) => code === 17).length, 1);
    const restarted = new BeadsStore(root, scope);
    const [claim] = await restarted.read(["show", contested]);
    const winningRequest =
      claims[0][1] === "SIGKILL" ? "loop-start-first" : "loop-start-second";
    assert.equal(claim.status, "in_progress");
    assert.equal(claim.assignee, winningRequest);
    assert.equal(
      await readFile(join(root, winningRequest), "utf8"),
      "dispatching",
    );

    const commentTarget = await create("Selected passage");
    assert.deepEqual(await work("comment", commentTarget, "comment-request"), [
      null,
      "SIGKILL",
    ]);
    const comments = await restarted.read(["comments", commentTarget]);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].author, "owner");
    assert.equal(comments[0].text, "> Selected passage\n\nCheck this again.");
    assert.equal(
      await readFile(join(root, "comment-request"), "utf8"),
      "dispatching",
    );

    const unsent = await create("Unsent request");
    assert.deepEqual(await work("unsent", unsent, "unsent-request"), [
      null,
      "SIGKILL",
    ]);
    assert.equal(
      await readFile(join(root, "unsent-request"), "utf8"),
      "prepared",
    );
    assert.equal((await restarted.read(["show", unsent]))[0].status, "open");

    // A parent's Beads repository must never satisfy another scope's read.
    await symlink(
      join(root, "beads-stores", store.id, ".beads"),
      join(root, ".beads"),
    );
    for (const override of [
      { ownerId: "other-owner" },
      { profile: "other-profile" },
      { projectId: "other-project" },
    ]) {
      const unrelated = new BeadsStore(root, { ...scope, ...override });
      await mkdir(join(root, "beads-stores", unrelated.id));
      await assert.rejects(unrelated.read(["list"]), (error) => {
        assert.match(error.cause?.stderr ?? "", /no beads database found/);
        return true;
      });
      await unrelated.initialize();
      assert.deepEqual(await unrelated.read(["list", "--all"]), []);
      assert.notEqual(unrelated.id, restarted.id);
    }

    console.log(
      "PASS: real bd claim contention, committed claim and comment after worker SIGKILL, provably unsent intent, isolated store identities",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
