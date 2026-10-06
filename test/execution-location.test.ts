import { afterEach, expect, it } from "vitest";
import {
  LOCAL_ENVIRONMENT_NAMES,
  environmentLocation,
  hostLocation,
} from "../src/server/execution-location";

const container = process.env.LOOP_COMPANION_CONTAINER;
afterEach(() => {
  if (container === undefined) delete process.env.LOOP_COMPANION_CONTAINER;
  else process.env.LOOP_COMPANION_CONTAINER = container;
});

it("records Loop's own process as Docker inside the companion container", () => {
  delete process.env.LOOP_COMPANION_CONTAINER;
  expect(hostLocation()).toBe("laptop");
  process.env.LOOP_COMPANION_CONTAINER = "1";
  expect(hostLocation()).toBe("docker");
});

it("locates only environments this process provisioned locally", () => {
  delete process.env.LOOP_COMPANION_CONTAINER;
  const local = "local-" + "0".repeat(36);
  expect(
    environmentLocation({
      instance_id: local,
      name: LOCAL_ENVIRONMENT_NAMES.native,
    }),
  ).toBe("laptop");
  expect(
    environmentLocation({
      instance_id: local,
      name: LOCAL_ENVIRONMENT_NAMES.docker,
    }),
  ).toBe("docker");
  // A remote runner named "Docker" is not a local Docker environment.
  expect(
    environmentLocation({ instance_id: "i-1234567890abcdef0", name: "Docker" }),
  ).toBeUndefined();
  // The companion container's own runner is inside Docker.
  process.env.LOOP_COMPANION_CONTAINER = "1";
  expect(
    environmentLocation({
      instance_id: local,
      name: LOCAL_ENVIRONMENT_NAMES.native,
    }),
  ).toBe("docker");
});
