import { writeFileSync } from "node:fs";
import { createServer } from "node:net";

export async function opencodeControl(path, event, streams) {
  const callsFile = path + ".calls.json";
  const state = {
    history: JSON.parse(process.env.LOOP_TEST_OPENCODE_HISTORY || "[]"),
    status: {},
    failures: {},
    calls: [],
  };
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      try {
        const command = JSON.parse(input);
        for (const key of ["history", "status", "failures"])
          if (key in command) state[key] = command[key];
        if (command.resetCalls) {
          state.calls = [];
          writeFileSync(callsFile, "[]");
        }
        for (const frame of command.events || [])
          event(frame.type, frame.properties);
        if (command.disconnect) for (const stream of streams) stream.destroy();
        socket.end(JSON.stringify({ calls: state.calls }) + "\n");
      } catch (error) {
        socket.end(JSON.stringify({ error: error.message }) + "\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return {
    state,
    fails(url) {
      const parsed = new URL(url, "http://localhost");
      parsed.searchParams.delete("directory");
      const path = parsed.pathname + parsed.search;
      state.calls.push(path);
      writeFileSync(callsFile, JSON.stringify(state.calls));
      const count = state.failures[path] || 0;
      if (!count) return false;
      state.failures[path] = count - 1;
      return true;
    },
  };
}
