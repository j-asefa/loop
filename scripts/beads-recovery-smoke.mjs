import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = process.env.LOOP_BEADS_RUNTIME_MODULE
  ? pathToFileURL(resolve(process.env.LOOP_BEADS_RUNTIME_MODULE)).href
  : new URL("../src/beads-runtime.ts", import.meta.url).href;
const { BeadsStore } = await import(moduleUrl);
const scope = { ownerId: "owner", profile: "companion", projectId: "project" };
const [, script, rootArg, action, id, request] = process.argv;

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
    process.exit(1);
  }
  // This is the Loop-side crash window: bd exited after committing, and
  // the caller has yet to save a receipt or dispatch any agent work.
  process.kill(process.pid, "SIGKILL");
} else {
  const root = await mkdtemp(join(tmpdir(), "loop-beads-smoke-"));
  try {
    const store = new BeadsStore(root, scope);
    await Promise.all([store.initialize(), store.initialize()]);
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
    const claims = await Promise.all([
      work("claim", contested, "loop-start-first"),
      work("claim", contested, "loop-start-second"),
    ]);
    assert.equal(
      claims.filter(([code, signal]) => code === null && signal === "SIGKILL")
        .length,
      1,
    );
    assert.equal(claims.filter(([code]) => code === 1).length, 1);
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

    for (const override of [
      { ownerId: "other-owner" },
      { profile: "other-profile" },
      { projectId: "other-project" },
    ]) {
      const unrelated = new BeadsStore(root, { ...scope, ...override });
      await assert.rejects(unrelated.read(["list"]), /unavailable/);
      assert.notEqual(unrelated.id, restarted.id);
    }

    console.log(
      "PASS: real bd claim contention, committed claim and comment after worker SIGKILL, provably unsent intent, isolated store identities",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
