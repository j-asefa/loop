import { afterEach, expect, it } from "vitest";
import { computerName } from "../src/computer-name";
import {
  LOCAL_ENVIRONMENT_NAMES,
  environmentLocation,
  hostLocation,
  hostEnvironmentName,
} from "../src/server/execution-location";

const container = process.env.LOOP55_COMPANION_CONTAINER;
const environmentName = process.env.LOOP55_ENVIRONMENT_NAME;
afterEach(() => {
  if (container === undefined) delete process.env.LOOP55_COMPANION_CONTAINER;
  else process.env.LOOP55_COMPANION_CONTAINER = container;
  if (environmentName === undefined) delete process.env.LOOP55_ENVIRONMENT_NAME;
  else process.env.LOOP55_ENVIRONMENT_NAME = environmentName;
});

it("records Loop55's own process as Docker inside the companion container", () => {
  delete process.env.LOOP55_COMPANION_CONTAINER;
  expect(hostLocation()).toBe("laptop");
  expect(hostEnvironmentName()).toBe(computerName());
  process.env.LOOP55_COMPANION_CONTAINER = "1";
  expect(hostLocation()).toBe("docker");
  delete process.env.LOOP55_ENVIRONMENT_NAME;
  expect(hostEnvironmentName()).toBe(`Docker · ${computerName()}`);
});

it("names standalone Docker environments without changing their location", () => {
  process.env.LOOP55_COMPANION_CONTAINER = "1";
  process.env.LOOP55_ENVIRONMENT_NAME = "  research/loop55  ";
  expect(hostEnvironmentName()).toBe("Docker · research/loop5555");
  expect(hostLocation()).toBe("docker");
  process.env.LOOP55_ENVIRONMENT_NAME = "development";
  expect(hostEnvironmentName()).toBe("Docker · development");
  process.env.LOOP55_ENVIRONMENT_NAME = " ";
  expect(hostEnvironmentName()).toBe(`Docker · ${computerName()}`);
  delete process.env.LOOP55_COMPANION_CONTAINER;
  process.env.LOOP55_ENVIRONMENT_NAME = "container-only";
  expect(hostEnvironmentName()).toBe(computerName());
});

it("locates only environments this process provisioned locally", () => {
  delete process.env.LOOP55_COMPANION_CONTAINER;
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
  process.env.LOOP55_COMPANION_CONTAINER = "1";
  expect(
    environmentLocation({
      instance_id: local,
      name: LOCAL_ENVIRONMENT_NAMES.native,
    }),
  ).toBe("docker");
});
