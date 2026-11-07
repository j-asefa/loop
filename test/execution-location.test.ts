import { afterEach, expect, it } from "vitest";
import { computerName } from "../src/computer-name";
import {
  hostLocation,
  hostEnvironmentName,
} from "../src/server/execution-location";

const container = process.env.LOOP_COMPANION_CONTAINER;
const environmentName = process.env.LOOP_ENVIRONMENT_NAME;
afterEach(() => {
  if (container === undefined) delete process.env.LOOP_COMPANION_CONTAINER;
  else process.env.LOOP_COMPANION_CONTAINER = container;
  if (environmentName === undefined) delete process.env.LOOP_ENVIRONMENT_NAME;
  else process.env.LOOP_ENVIRONMENT_NAME = environmentName;
});

it("records Loop's own process as Docker inside the companion container", () => {
  delete process.env.LOOP_COMPANION_CONTAINER;
  expect(hostLocation()).toBe("laptop");
  expect(hostEnvironmentName()).toBe(computerName());
  process.env.LOOP_COMPANION_CONTAINER = "1";
  expect(hostLocation()).toBe("docker");
  delete process.env.LOOP_ENVIRONMENT_NAME;
  expect(hostEnvironmentName()).toBe(`Docker · ${computerName()}`);
});

it("names standalone Docker environments without changing their location", () => {
  process.env.LOOP_COMPANION_CONTAINER = "1";
  process.env.LOOP_ENVIRONMENT_NAME = "  research/loop  ";
  expect(hostEnvironmentName()).toBe("Docker · research/loop");
  expect(hostLocation()).toBe("docker");
  process.env.LOOP_ENVIRONMENT_NAME = "development";
  expect(hostEnvironmentName()).toBe("Docker · development");
  process.env.LOOP_ENVIRONMENT_NAME = " ";
  expect(hostEnvironmentName()).toBe(`Docker · ${computerName()}`);
  delete process.env.LOOP_COMPANION_CONTAINER;
  process.env.LOOP_ENVIRONMENT_NAME = "container-only";
  expect(hostEnvironmentName()).toBe(computerName());
});
