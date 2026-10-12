import { beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { hostname, platform } from "node:os";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:os", () => ({ hostname: vi.fn(), platform: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.mocked(platform).mockReturnValue("linux");
  vi.mocked(hostname).mockReturnValue("workstation");
});

it("uses the OS hostname on Linux without a subprocess", async () => {
  const { computerName } = await import("../src/computer-name");
  expect(computerName()).toBe("workstation");
  expect(execFileSync).not.toHaveBeenCalled();
});

it("prefers the Mac's friendly name and caches the bounded lookup", async () => {
  vi.mocked(platform).mockReturnValue("darwin");
  vi.mocked(execFileSync).mockReturnValue("  Alex’s MacBook Pro\n");
  const { computerName } = await import("../src/computer-name");
  expect(computerName()).toBe("Alex’s MacBook Pro");
  expect(computerName()).toBe("Alex’s MacBook Pro");
  expect(execFileSync).toHaveBeenCalledTimes(1);
  expect(execFileSync).toHaveBeenCalledWith(
    "/usr/sbin/scutil",
    ["--get", "ComputerName"],
    expect.objectContaining({ timeout: 1_000, encoding: "utf8" }),
  );
});

it.each(["empty", "failed"])(
  "falls back to the hostname for an %s Mac lookup",
  async (result) => {
    vi.mocked(platform).mockReturnValue("darwin");
    vi.mocked(execFileSync).mockImplementation(() => {
      if (result === "failed") throw new Error("lookup timed out");
      return "\n";
    });
    const { computerName } = await import("../src/computer-name");
    expect(computerName()).toBe("workstation");
  },
);

it.each(["empty", "failed"])(
  "keeps startup available for an %s hostname lookup",
  async (result) => {
    vi.mocked(hostname).mockImplementation(() => {
      if (result === "failed") throw new Error("hostname unavailable");
      return " ";
    });
    const { computerName } = await import("../src/computer-name");
    expect(computerName()).toBe("This computer");
  },
);
