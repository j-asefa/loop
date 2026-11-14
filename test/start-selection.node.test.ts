import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LaunchRecord,
  launchArguments,
  parseLaunchArguments,
  readLaunch,
  writeLaunch,
  type WorkspaceLaunch,
} from "../src/launch-record.js";
import { serviceDefinitions } from "../src/service.js";
import test from "node:test";
import assert from "node:assert/strict";
import { selectedHarnesses, selectedBilling } from "../src/start-selection.js";

test("one typed launch preserves selected harnesses, stored fields and process arguments", async () => {
  assert.deepEqual(selectedHarnesses(), [
    "codex",
    "claude",
    "pi",
    "opencode",
    "antigravity",
    "muse",
    "grok",
  ]);
  assert.deepEqual(selectedHarnesses("antigravity,codex"), [
    "antigravity",
    "codex",
  ]);
  assert.deepEqual(selectedHarnesses("grok,codex"), ["grok", "codex"]);
  assert.deepEqual(selectedHarnesses("both"), ["codex", "claude"]);
  assert.deepEqual(selectedHarnesses("pi,codex,pi"), ["pi", "codex"]);
  assert.throws(() => selectedHarnesses("acp"), /Register custom ACP/);
  const dir = await mkdtemp(join(tmpdir(), "loop-launch-record-"));
  try {
    const launches: WorkspaceLaunch[] = [
      {
        schema: 1,
        kind: "workspace",
        action: "start",
        project: "/work/project space",
        providers: ["codex", "claude"],
        localOnly: true,
        fleet: true,
      },
      {
        schema: 1,
        kind: "workspace",
        action: "acp",
        project: "/work/project space",
        executable: "/bin/agent space",
        billing: "existing",
        acpArgs: ["--flag", "a=b", "space value"],
        publicUrl: "https://fixture.example",
        tunnelName: "fixture",
        tunnelConfig: "/config/tunnel space.yml",
        fleet: true,
      },
    ];
    const expectedArgs = [
      [
        "start",
        "--project",
        "/work/project space",
        "--providers",
        "codex,claude",
        "--local-only",
        "--fleet",
      ],
      [
        "acp",
        "--project",
        "/work/project space",
        "--executable",
        "/bin/agent space",
        "--billing",
        "existing",
        "--acp-arg=--flag",
        "--acp-arg=a=b",
        "--acp-arg=space value",
        "--public-url",
        "https://fixture.example",
        "--tunnel-name",
        "fixture",
        "--tunnel-config",
        "/config/tunnel space.yml",
        "--fleet",
      ],
    ];
    for (const [index, launch] of launches.entries()) {
      writeLaunch(dir, launch);
      assert.deepEqual(await readLaunch(dir), launch);
      const written = JSON.parse(
        await readFile(join(dir, "launch.json"), "utf8"),
      );
      assert.equal(written.schema, 1);
      assert.deepEqual(
        written.args,
        expectedArgs[index],
        "released 0.1.0 reader can repeat new writes",
      );
      await writeFile(
        join(dir, "launch.json"),
        JSON.stringify({
          schema: 1,
          args: expectedArgs[index],
          version: "0.1.0",
        }),
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(await readLaunch(dir))),
        launch,
        "every released launch field survives upgrade",
      );
      assert.deepEqual(launchArguments(launch), expectedArgs[index]);
      const decoded = parseLaunchArguments(
        "workspace",
        launchArguments(launch, "one-time-session"),
      );
      assert.deepEqual(JSON.parse(JSON.stringify(decoded.launch)), launch);
      assert.equal(decoded.resume, "one-time-session");
      assert.equal("resume" in (await readLaunch(dir))!, false);
      for (const platform of ["linux", "darwin"])
        assert.deepEqual(
          serviceDefinitions(
            platform,
            "/node",
            "/cli",
            "/root",
            launch.project!,
            "/path",
            null,
            launchArguments(launch),
          ),
          serviceDefinitions(
            platform,
            "/node",
            "/cli",
            "/root",
            launch.project!,
            "/path",
            null,
            expectedArgs[index],
          ),
          "the typed launch renders the same service unit as the prior resolved argv",
        );
    }
    for (const mode of [
      { kind: "quick" as const },
      {
        kind: "named" as const,
        name: "fixture",
        origin: "https://fixture.example",
        config: "/config/tunnel space.yml",
      },
    ]) {
      const launch = LaunchRecord.parse({
        schema: 1,
        kind: "connection",
        dir: "/run/connection",
        root: "/root",
        release: "fixture",
        log: true,
        mode,
      });
      const decoded = parseLaunchArguments(
        "connection",
        launchArguments(launch),
      );
      assert.deepEqual(decoded.launch, launch);
    }
    await writeFile(
      join(dir, "launch.json"),
      JSON.stringify({ schema: 1, args: ["start"] }),
    );
    assert.equal((await readLaunch(dir))?.action, "start");
    await writeFile(
      join(dir, "preferences.json"),
      JSON.stringify({
        publicUrl: "https://released.example",
        tunnelName: "released",
        tunnelConfig: "/released/config.yml",
      }),
    );
    const restored = await readLaunch(dir);
    assert.equal(restored?.publicUrl, "https://released.example");
    assert.equal(restored?.tunnelName, "released");
    assert.equal(restored?.tunnelConfig, "/released/config.yml");
    await writeFile(
      join(dir, "launch.json"),
      JSON.stringify({
        schema: 1,
        args: ["start", "--local-only"],
        version: "0.1.0",
      }),
    );
    assert.equal(
      (await readLaunch(dir))?.publicUrl,
      undefined,
      "local-only released launches bypass preference tunnels",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi defaults to existing billing while explicit and saved subscription remain available", () => {
  assert.equal(selectedBilling("pi"), "existing");
  assert.equal(selectedBilling("pi", "subscription"), "subscription");
  assert.equal(
    selectedBilling("pi", undefined, "subscription"),
    "subscription",
  );
  assert.equal(selectedBilling("pi", "existing", "subscription"), "existing");
  assert.equal(selectedBilling("codex"), "subscription");
  assert.equal(
    selectedBilling("opencode"),
    "subscription",
    "retain the CLI consent step",
  );
});
