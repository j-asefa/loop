export function containerArgs(prefix, key, image, name) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid runtime key");
  return [
    "run",
    "--rm",
    "-i",
    "--init",
    "--name",
    name,
    "--label",
    "loop.runtime=" + prefix,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--memory=1536m",
    "--cpus=1",
    "--user=1000:1000",
    "--network=bridge",
    "--tmpfs=/tmp:rw,nosuid,nodev,size=256m",
    "--mount",
    `type=volume,source=${prefix}-${key},target=/home/node`,
    image,
    "node",
    "/runtime/entry.mjs",
  ];
}
