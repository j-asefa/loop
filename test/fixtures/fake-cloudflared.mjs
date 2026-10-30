#!/usr/bin/env node
// Explicit test subprocess standing in for cloudflared; selected only through
// LOOP55_TEST_CLOUDFLARED outside production. It never opens a network tunnel.
import { appendFileSync } from "node:fs";
if (process.env.LOOP55_TEST_TUNNEL_LOG)
  appendFileSync(
    process.env.LOOP55_TEST_TUNNEL_LOG,
    `${process.pid} ${process.argv.slice(2).join(" ")}\n`,
  );
if (process.env.LOOP55_TEST_TUNNEL_FAIL) {
  console.error("fixture tunnel failure");
  process.exit(1);
}
// A slow edge: the address is confirmed only after this delay.
if (process.env.LOOP55_TEST_TUNNEL_DELAY_MS)
  await new Promise((r) =>
    setTimeout(r, Number(process.env.LOOP55_TEST_TUNNEL_DELAY_MS)),
  );
if (process.argv.includes("run"))
  console.error("INF Registered tunnel connection connIndex=0");
else
  console.error(
    `INF |  https://loop55-fixture-${process.pid}.trycloudflare.com  |`,
  );
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1 << 30);
