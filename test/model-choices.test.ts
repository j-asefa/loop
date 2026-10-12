import { expect, it } from "vitest";
import {
  agentModelName,
  connectionEnvironments,
  connectionLocation,
  modelDisplayName,
  runModelName,
} from "../src/client/modelChoices";
import type { Connection } from "../src/shared/types";

it("shows harness-resolved versions without guessing the version of an alias", () => {
  expect(
    modelDisplayName({
      id: "opus",
      name: "Opus",
      resolvedModel: "claude-opus-5-5[1m]",
    }),
  ).toBe("Claude Opus 5.5 (1M)");
  expect(
    modelDisplayName({
      id: "sonnet",
      name: "Sonnet",
      resolvedModel: "claude-sonnet-5",
    }),
  ).toBe("Claude Sonnet 5");
  expect(
    modelDisplayName({
      id: "haiku",
      name: "Haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
    }),
  ).toBe("Claude Haiku 4.5");
  expect(modelDisplayName({ id: "claude-opus-4-8", name: "Opus" })).toBe(
    "Claude Opus 4.8",
  );
  expect(modelDisplayName({ id: "opus", name: "Opus" })).toBe("Opus");
  expect(
    modelDisplayName({
      id: "default",
      name: "Default",
      resolvedModel: "future-model-exact-version",
    }),
  ).toBe("future-model-exact-version");
  expect(modelDisplayName({ id: "gpt-6-astra", name: "GPT-6 Astra" })).toBe(
    "GPT-6 Astra",
  );
});

it("resolves the model using the agent's own connection", () => {
  const connections = [
    {
      id: "first",
      models: JSON.stringify([
        { id: "opus", name: "Opus", resolvedModel: "claude-opus-4-8" },
      ]),
    },
    {
      id: "second",
      models: JSON.stringify([
        { id: "opus", name: "Opus", resolvedModel: "claude-opus-5-5" },
      ]),
    },
  ] as Connection[];
  expect(
    agentModelName({ connection_id: "first", model: "opus" }, connections),
  ).toBe("Claude Opus 4.8");
  expect(
    agentModelName({ connection_id: "second", model: "opus" }, connections),
  ).toBe("Claude Opus 5.5");
  expect(
    agentModelName({ connection_id: "missing", model: "opus" }, connections),
  ).toBe("opus");
});

it("labels only connections with a recorded local location", () => {
  const connections = [
    { id: "laptop", metadata: JSON.stringify({ backend: "hapi", environmentName: "This laptop", location: "laptop" }) },
    { id: "docker", metadata: JSON.stringify({ backend: "hapi", environmentName: "Docker", location: "docker" }) },
    { id: "container", metadata: JSON.stringify({ loopHarness: "codex", location: "docker" }) },
    // Display names alone never decide the badge.
    { id: "named", metadata: JSON.stringify({ backend: "hapi", environmentName: "Docker" }) },
    { id: "legacy-direct", metadata: JSON.stringify({ loopHarness: "codex" }) },
    { id: "remote", metadata: JSON.stringify({ backend: "hapi", environmentName: "Remote runner" }) },
  ] as Connection[];
  const kinds = connectionEnvironments(connections);
  expect(kinds.get("laptop")).toBe("laptop");
  expect(kinds.get("docker")).toBe("docker");
  expect(kinds.get("container")).toBe("docker");
  expect(kinds.get("named")).toBeNull();
  expect(kinds.get("legacy-direct")).toBeNull();
  expect(kinds.get("remote")).toBeNull();
  expect(kinds.get("missing")).toBeUndefined();
  // Settings and Feed use the same wording for a recorded location.
  expect(connectionLocation(connections[2]).label).toBe("Docker");
  expect(connectionLocation(connections[4]).label).toBe("This computer");
  expect(connectionLocation(connections[5]).label).toBe("Remote runner");
});

it("uses recorded computer names and resolves legacy laptop labels from their source", () => {
  const connection = (metadata: object) => ({ metadata: JSON.stringify(metadata) }) as Connection;
  expect(connectionLocation(connection({ location: "laptop", environmentName: "Alex’s MacBook Pro" })))
    .toEqual({ kind: "laptop", label: "Alex’s MacBook Pro" });
  expect(connectionLocation(connection({ location: "laptop", environmentName: "This laptop" }), "Workstation"))
    .toEqual({ kind: "laptop", label: "Workstation" });
  expect(connectionLocation(connection({ location: "docker", environmentName: "container-id" }), "Workstation"))
    .toEqual({ kind: "docker", label: "Docker" });
  expect(connectionLocation(connection({ location: "laptop" })))
    .toEqual({ kind: "laptop", label: "This computer" });
});

const runConnections = [
  {
    id: "older-account",
    provider: "anthropic",
    models: JSON.stringify([
      { id: "default", name: "Default", resolvedModel: "claude-opus-4-8" },
    ]),
  },
  {
    id: "run-account",
    provider: "anthropic",
    models: JSON.stringify([
      { id: "default", name: "Default", resolvedModel: "claude-opus-5-5" },
    ]),
  },
] as Connection[];

it("resolves a saved default through the run's connection, not another account", () => {
  expect(
    runModelName(
      { model: "default", connectionId: "run-account", provider: "anthropic" },
      runConnections,
    ),
  ).toBe("Claude Opus 5.5");
});

it("preserves the execution model when the connection's default has changed", () => {
  const snapshot = { connectionId: "run-account", provider: "anthropic" };
  expect(
    runModelName({ ...snapshot, model: "claude-opus-4-8" }, runConnections),
  ).toBe("Claude Opus 4.8");
  expect(
    runModelName(
      { ...snapshot, model: "default", resolvedModel: "claude-opus-4-8" },
      runConnections,
    ),
  ).toBe("Claude Opus 4.8");
});

it("does not guess a model when the saved account or provider does not match", () => {
  for (const snapshot of [
    { model: "default" },
    { model: "default", connectionId: "deleted-account" },
    { model: "default", connectionId: "run-account", provider: "codex" },
  ]) {
    expect(runModelName(snapshot, runConnections)).toBe("default");
  }
  expect(runModelName({}, runConnections)).toBe("");
});
