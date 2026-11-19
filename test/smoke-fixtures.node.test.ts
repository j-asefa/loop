import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { waitForFixtureAnnouncement } from "../scripts/helpers/fixture.mjs";

test("fixture readiness retains exit diagnostics when stdout is buffered", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: 1,
    signalCode: null,
  });
  const ready = waitForFixtureAnnouncement(child);
  child.stderr.write("fixture failed after printing readiness");
  child.stdout.end('{"origin":"http://127.0.0.1:1","pair":"fixture-code"}\n');
  child.stderr.end();
  child.emit("close", 1, null);
  await assert.rejects(ready, (error: Error) => {
    assert.match(error.message, /exited before announcing readiness \(1\)/);
    assert.match(error.message, /fixture failed after printing readiness/);
    assert.doesNotMatch(error.message, /fixture-code/);
    return true;
  });
});
