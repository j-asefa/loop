import { afterAll, expect, it, vi } from "vitest";
import express from "express";
import { once } from "node:events";
import { MulterError } from "multer";
import { z } from "zod";
import { errorHandler } from "../src/server/error-handler";
import { Problem, ExecutionProblem } from "../src/shared/problem";

import { ExecutionRefused } from "../src/server/execution-refusal";

const app = express();
app.use(express.json({ limit: 32 }));
app.post("/json", (_req, res) => res.json({ ok: true }));
app.get("/unexpected", () => {
  throw new Error("private diagnostic");
});
app.get("/validation", () => z.string().parse(null));
app.get("/problem", () => {
  throw new Problem(409, "Conflict");
});
app.get("/multipart", () => {
  throw new MulterError("LIMIT_UNEXPECTED_FILE");
});
app.get("/limited", () => {
  throw new Problem(
    429,
    "Wait",
    { private: "diagnostic" },
    {
      headers: { "Retry-After": "17" },
    },
  );
});
app.get("/execution/:outcome", (req) => {
  if (req.params.outcome === "local-refused")
    throw new ExecutionRefused(409, "No dispatch");
  const outcome = z
    .enum(["refused", "unknown", "completed"])
    .parse(req.params.outcome);
  throw new ExecutionProblem(409, "Execution failed", outcome);
});
app.get("/oversized", () => {
  throw new MulterError("LIMIT_FILE_SIZE");
});
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    ),
);

it("returns 500 for unexpected errors without exposing diagnostics", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await fetch(origin + "/unexpected");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Request could not be completed. Please try again.",
    });
    expect(log).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
  }
});
it("preserves parser status without exposing the request body", async () => {
  for (const [body, status] of [
    ["{private", 400],
    [JSON.stringify({ secret: "x".repeat(40) }), 413],
  ] as const) {
    const response = await fetch(origin + "/json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: "Request could not be completed. Please try again.",
    });
  }
});
it("keeps validation, upload and domain failures as client errors", async () => {
  for (const [path, status] of [
    ["/validation", 400],
    ["/multipart", 400],
    ["/problem", 409],
  ] as const)
    expect((await fetch(origin + path)).status).toBe(status);
});

it("carries safe problem headers without exposing diagnostics", async () => {
  const response = await fetch(origin + "/limited");
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("17");
  expect(await response.json()).toEqual({ error: "Wait" });
});
it("preserves execution outcomes from local guards and execution replies", async () => {
  for (const outcome of ["refused", "unknown", "completed", "local-refused"]) {
    const response = await fetch(origin + "/execution/" + outcome);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: outcome === "local-refused" ? "No dispatch" : "Execution failed",
      executionOutcome: outcome === "local-refused" ? "refused" : outcome,
    });
  }
});
it("reports a multipart size limit as 413", async () => {
  const response = await fetch(origin + "/oversized");
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: "Request could not be completed. Please try again.",
  });
});
