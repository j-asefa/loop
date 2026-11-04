import { expect, it } from "vitest";
import {
  agentModelName,
  connectionLocation,
  modelDisplayName,
  modelOptionLabel,
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

it("labels a harness default as a default in the model picker", () => {
  const nativeDefault = {
    id: "native-default",
    name: "Use native default",
    resolvedModel: "gpt-6.1-sol",
  };
  expect(modelOptionLabel(nativeDefault)).toBe("Use native default");
  expect(modelDisplayName(nativeDefault)).toBe("gpt-6.1-sol");
  expect(
    modelOptionLabel({
      id: "opus",
      name: "Opus",
      resolvedModel: "claude-opus-5-5",
    }),
  ).toBe("Claude Opus 5.5");
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
    {
      id: "laptop",
      metadata: JSON.stringify({
        environmentName: "This laptop",
        location: "laptop",
      }),
    },
    {
      id: "docker",
      metadata: JSON.stringify({
        environmentName: "Docker",
        location: "docker",
      }),
    },
    {
      id: "container",
      metadata: JSON.stringify({ loopHarness: "codex", location: "docker" }),
    },
    // Display names alone never decide the badge.
    { id: "named", metadata: JSON.stringify({ environmentName: "Docker" }) },
    {
      id: "legacy-direct",
      metadata: JSON.stringify({ loopHarness: "codex" }),
    },
    {
      id: "remote",
      metadata: JSON.stringify({ environmentName: "Remote runner" }),
    },
  ] as Connection[];
  const kind = (id: string) =>
    connectionLocation(connections.find((c) => c.id === id)!).kind;
  expect(kind("laptop")).toBe("laptop");
  expect(kind("docker")).toBe("docker");
  expect(kind("container")).toBe("docker");
  expect(kind("named")).toBeNull();
  expect(kind("legacy-direct")).toBeNull();
  expect(kind("remote")).toBeNull();
  // Settings and Feed use the same wording for a recorded location.
  expect(connectionLocation(connections[2]).label).toBe("Docker");
  expect(connectionLocation(connections[4]).label).toBe("This computer");
  expect(connectionLocation(connections[5]).label).toBe("Server connection");
});

it("uses recorded computer names and resolves legacy laptop labels from their source", () => {
  const connection = (metadata: object) =>
    ({ metadata: JSON.stringify(metadata) }) as Connection;
  expect(
    connectionLocation(
      connection({ location: "laptop", environmentName: "Alex’s MacBook Pro" }),
    ),
  ).toEqual({ kind: "laptop", label: "Alex’s MacBook Pro" });
  expect(
    connectionLocation(
      connection({ location: "laptop", environmentName: "This laptop" }),
      "Workstation",
    ),
  ).toEqual({ kind: "laptop", label: "Workstation" });
  expect(
    connectionLocation(
      connection({ location: "docker", environmentName: "container-id" }),
      "Workstation",
    ),
  ).toEqual({ kind: "docker", label: "Docker · container-id" });
  expect(connectionLocation(connection({ location: "laptop" }))).toEqual({
    kind: "laptop",
    label: "This computer",
  });
});

it("keeps distinct Docker names while preserving the recorded location", () => {
  const connection = (metadata: object) =>
    ({ metadata: JSON.stringify(metadata) }) as Connection;
  expect(
    connectionLocation(
      connection({
        location: "docker",
        environmentName: "Docker · research/loop",
      }),
    ),
  ).toEqual({ kind: "docker", label: "Docker · research/loop" });
  expect(
    connectionLocation(
      connection({
        location: "docker",
        environmentName: "Docker · research/app",
      }),
    ),
  ).toEqual({ kind: "docker", label: "Docker · research/app" });
  expect(
    connectionLocation(
      connection({ location: "docker", environmentName: "Docker" }),
      "Docker · research/loop",
    ),
  ).toEqual({ kind: "docker", label: "Docker · research/loop" });
  expect(
    connectionLocation(
      connection({ location: "docker", environmentName: "Docker" }),
      "Office Mac",
    ),
  ).toEqual({ kind: "docker", label: "Docker" });
  expect(
    connectionLocation(
      connection({ location: "laptop", environmentName: "Docker" }),
    ),
  ).toEqual({ kind: "laptop", label: "Docker" });
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
