import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import Ajv2020 from "ajv/dist/2020.js";
import { workspaceApi, workspaceRoutes } from "../src/shared/workspace-api";
import {
  WorkspaceFrameV3,
  WorkspaceEvent,
  WorkspaceCapabilities,
  WorkspaceClock,
  COMPLETE_WORKSPACE_CAPABILITIES,
} from "../src/shared/workspace-events";
import { cardsFixture } from "./helpers/cards-fixture";
import { compiledServerFixture } from "./helpers/compiled-server";

const channel = workspaceApi.channels.events;
const document = JSON.parse(readFileSync("docs/openapi-channels.json", "utf8"));
const http = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
const validator = new Ajv2020({ strict: false, validateFormats: false });
validator.addSchema(http, "https://loop.test/openapi.json");
validator.addSchema(document, "https://loop.test/openapi-channels.json");
const validateFrame = validator.compile({
  $ref: "https://loop.test/openapi-channels.json#/components/schemas/WorkspaceFrameV3",
});
const validateFallback = validator.compile({
  $ref: new URL(
    document["x-channels"].events.httpFallback.response.$ref,
    "https://loop.test/openapi-channels.json",
  ).href,
});

it("shares the socket, client and fallback schemas without registering a socket as HTTP", () => {
  expect(channel.frames).toBe(WorkspaceFrameV3);
  expect(channel.event).toBe(WorkspaceEvent);
  expect(channel.capabilities).toBe(WorkspaceCapabilities);
  expect(channel.clock).toBe(WorkspaceClock);
  expect(channel.fallback).toBe(workspaceApi.events);
  expect(workspaceRoutes.events).toBe(workspaceApi.events);
  expect(Object.values(workspaceRoutes)).not.toContain(channel);
  expect(http.paths["/api/events/ws"]).toBeUndefined();
  expect(http.paths["/api/events"].get.operationId).toBe("events");
});

it("publishes resolvable channel and HTTP fallback references with one event union", () => {
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      const [file, pointer] = value.$ref.split("#");
      expect(["", "./openapi.json"]).toContain(file);
      const target = pointer
        .slice(1)
        .split("/")
        .reduce(
          (node: any, key: string) =>
            node?.[key.replaceAll("~1", "/").replaceAll("~0", "~")],
          file ? http : document,
        );
      expect(target, value.$ref).toBeDefined();
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(document);
  const published = document["x-channels"].events;
  expect(published).toMatchObject({
    kind: "socket",
    path: "/api" + channel.path,
    pairedPath: channel.pairedPath,
    frames: { $ref: "#/components/schemas/WorkspaceFrameV3" },
    query: { $ref: "#/components/schemas/WorkspaceEventsQuery" },
    httpFallback: {
      operationId: "events",
      method: channel.fallback.method,
      path: "/api" + channel.fallback.path,
      response: { $ref: "./openapi.json#/components/schemas/eventsResponse" },
    },
  });
  const schemas = document.components.schemas;
  const variants = WorkspaceEvent.options.map(
    (variant) => variant.shape.type.value,
  );
  expect(
    schemas.WorkspaceEvent.oneOf.map(
      (variant: any) => variant.properties.type.const,
    ),
  ).toEqual(variants);
  const events = schemas.WorkspaceFrameV3.oneOf.find(
    (frame: any) => frame.properties.type.const === "events",
  );
  expect(events.properties.events.items.properties.event).toEqual({
    $ref: "#/components/schemas/WorkspaceEvent",
  });
  const withoutUnion = { ...schemas, WorkspaceEvent: undefined };
  for (const type of variants)
    expect(JSON.stringify(withoutUnion)).not.toContain(
      JSON.stringify({ const: type }).slice(1, -1),
    );
  const validateQuery = validator.compile({
    $ref: "https://loop.test/openapi-channels.json#/components/schemas/WorkspaceEventsQuery",
  });
  for (const query of [{ v: "3" }, {}, { v: "2" }, { v: 3 }])
    expect(validateQuery(query)).toBe(channel.query.safeParse(query).success);
});

let compiled: Awaited<ReturnType<typeof compiledServerFixture>>;
beforeAll(async () => {
  compiled = await compiledServerFixture();
}, 30_000);
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.terminate();
});
afterAll(async () => compiled?.close());

async function firstFrame(
  fixture: Awaited<ReturnType<typeof cardsFixture>>,
  path: string,
  query: string,
) {
  const socket = new WebSocket(
    fixture.origin.replace("http:", "ws:") + path + query,
    {
      headers: fixture.browser,
    },
  );
  sockets.push(socket);
  const frames: string[] = [];
  socket.on("message", (data) => frames.push(data.toString()));
  socket.on("error", () => {});
  await expect.poll(() => frames.length, { timeout: 7000 }).toBeGreaterThan(0);
  socket.close();
  await expect.poll(() => socket.readyState).toBe(WebSocket.CLOSED);
  return { raw: frames[0], frame: JSON.parse(frames[0]) };
}

for (const path of ["/api/events/ws", "/ws"] as const) {
  it(`companion ${path} serves canonical reset/replay frames and rejects retired versions`, async () => {
    const fixture = await cardsFixture(compiled.source);
    const reset = await firstFrame(fixture, path, "?v=3");
    expect(reset.frame.type).toBe("reset");
    expect(channel.frames.parse(reset.frame)).toEqual(reset.frame);
    expect(
      validateFrame(reset.frame),
      JSON.stringify(validateFrame.errors),
    ).toBe(true);
    const capabilities = COMPLETE_WORKSPACE_CAPABILITIES;
    expect(reset.frame).toEqual({
      v: 3,
      type: "reset",
      epoch: reset.frame.epoch,
      cursor: reset.frame.cursor,
      serverNow: expect.any(Number),
      nextDeadline: null,
      build: reset.frame.build,
      buildIdentity: reset.frame.buildIdentity,
      capabilities,
    });
    const id = Number(
      fixture.db
        .prepare(
          "INSERT INTO events(owner_id,run_id,subject_kind,subject_id,type,payload,created_at) VALUES(?,NULL,'collection','all','future.event','{}',1)",
        )
        .run(fixture.owner).lastInsertRowid,
    );
    const replay = await firstFrame(
      fixture,
      path,
      `?v=3&epoch=${reset.frame.epoch}&cursor=${reset.frame.cursor}`,
    );
    const expected = {
      v: 3,
      type: "events",
      epoch: reset.frame.epoch,
      cursor: id,
      serverNow: replay.frame.serverNow,
      nextDeadline: null,
      events: [
        {
          id,
          event: {
            type: "invalidate",
            scope: { kind: "collection", id: "all" },
          },
        },
      ],
      capabilities,
    };
    expect(replay.raw).toBe(JSON.stringify(expected));
    expect(channel.frames.parse(replay.frame)).toEqual(expected);
    expect(
      validateFrame(replay.frame),
      JSON.stringify(validateFrame.errors),
    ).toBe(true);
    const tip = await firstFrame(
      fixture,
      path,
      `?v=3&epoch=${reset.frame.epoch}&cursor=${id}`,
    );
    expect(tip.frame).toEqual({ ...expected, serverNow: tip.frame.serverNow });
    expect(tip.frame.serverNow).toBeGreaterThanOrEqual(replay.frame.serverNow);
    const response = await fixture.request(
      `/api/events?after=${reset.frame.cursor}`,
      { headers: fixture.browser },
    );
    expect(response.status).toBe(200);
    const fallback = await response.json();
    expect(channel.fallback.response.parse(fallback)).toEqual(fallback);
    expect(fallback).toContainEqual(
      expect.objectContaining({ id, type: "future.event", payload: "{}" }),
    );
    expect(validateFallback(fallback)).toBe(true);

    for (const query of ["", "?v=invalid", "?v=2", "?v=2&v=3"]) {
      const socket = new WebSocket(
        fixture.origin.replace("http:", "ws:") + path + query,
        {
          headers: fixture.browser,
        },
      );
      sockets.push(socket);
      const frames: unknown[] = [];
      socket.on("message", (data) => frames.push(data));
      const closed = await new Promise<{ code: number; reason: string }>(
        (resolve, reject) => {
          socket.once("error", reject);
          socket.once("close", (code, reason) =>
            resolve({ code, reason: reason.toString() }),
          );
        },
      );
      expect(closed).toEqual({
        code: 1008,
        reason: "Workspace events require v=3",
      });
      expect(frames).toEqual([]);
    }
    const current = await firstFrame(fixture, path, "?v=3&v=2");
    expect(validateFrame(current.frame)).toBe(true);
  }, 30_000);
}
