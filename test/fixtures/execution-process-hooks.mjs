// Fault injection in the actual compiled worker. Hold after native answer
// delivery, before the durable decision can record confirmation.
if (process.argv[1]?.endsWith("/execution-worker.js") && process.env.LOOP_TEST_DECISION_HOLD) {
  const { Native } = await import("../../dist/native.js");
  const { writeFileSync } = await import("node:fs");
  const write = Native.prototype.write;
  Native.prototype.write = async function (message) {
    await write.call(this, message);
    if (message.id === 101 && message.result) {
      writeFileSync(process.env.LOOP_TEST_DECISION_HOLD, String(process.pid));
      await new Promise(() => {});
    }
  };
}
