import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Legacy callers cannot sign a response. Before sharing their old bearer key,
// verify the owner of the *connected peer*, never just the listening port.
// A closed TCP connection cannot be transferred to a replacement listener.
export async function peerIsSameUser(socket, uid = process.geteuid?.()) {
  if (
    !Number.isInteger(uid) ||
    socket.localAddress !== "127.0.0.1" ||
    socket.remoteAddress !== "127.0.0.1" ||
    !socket.localPort ||
    !socket.remotePort ||
    socket.destroyed
  )
    return false;
  try {
    if (process.platform === "linux") {
      // https://docs.kernel.org/networking/proc_net_tcp.html
      const address = (port) =>
        "0100007F:" + port.toString(16).toUpperCase().padStart(4, "0");
      const local = address(socket.remotePort),
        remote = address(socket.localPort);
      const rows = (await readFile("/proc/net/tcp", "utf8"))
        .split("\n")
        .map((line) => line.trim().split(/\s+/));
      return (
        !socket.destroyed &&
        rows.some(
          (row) =>
            row[1] === local &&
            row[2] === remote &&
            row[3] === "01" &&
            row[7] === String(uid),
        )
      );
    }
    if (process.platform === "darwin") {
      // lsof's -a combines UID, address and ESTABLISHED filters; -Fn exposes
      // the exact connection direction without parsing human column output.
      const { stdout } = await exec(
        "/usr/sbin/lsof",
        [
          "-nP",
          "-a",
          "-u",
          String(uid),
          "-iTCP@127.0.0.1:" + socket.remotePort,
          "-sTCP:ESTABLISHED",
          "-Fn",
        ],
        { timeout: 2000, maxBuffer: 1024 * 1024 },
      );
      const peer =
        "n127.0.0.1:" + socket.remotePort + "->127.0.0.1:" + socket.localPort;
      return !socket.destroyed && stdout.split("\n").includes(peer);
    }
  } catch {}
  return false; // Missing ownership evidence never downgrades authentication.
}
