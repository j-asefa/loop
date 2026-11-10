const { engines } = require("../package.json");
const floor = /^>=(\d+)\.(\d+)(?:\.(\d+))?$/.exec(engines.node);
if (!floor)
  throw new Error("package.json.engines.node must specify one minimum version");
const minimum = floor.slice(1).map((part) => Number(part ?? 0));
const current = process.versions.node.split(".").map(Number);
const firstDifference = minimum.findIndex((part, i) => current[i] !== part);
if (
  firstDifference >= 0 &&
  current[firstDifference] < minimum[firstDifference]
) {
  console.error(`Loop needs Node.js ${engines.node}.`);
  process.exitCode = 1;
}
