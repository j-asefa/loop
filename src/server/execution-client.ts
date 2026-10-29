import { passiveWorkspaceRead } from "./workspace-read-context.js";
import { ExecutionRefused } from "./execution-refusal.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ExecutionProblem, Problem } from "../shared/problem.js";
import {
  ExecutionReady,
  ExecutionRequest,
  ExecutionResponse,
  executionOperations,
  EXECUTION_REQUEST_BYTES,
  EXECUTION_RESPONSE_BYTES,
  type ExecutionMethod,
  type ExecutionInput,
  type ExecutionOutput,
} from "../shared/execution-authority.js";
import { boundedExecutionJson } from "./execution-wire.js";

function passiveInput<M extends ExecutionMethod>(
  method: M,
  input: ExecutionInput<M>,
  owner = "local-workspace",
): ExecutionInput<M> {
  if (!passiveWorkspaceRead(owner)) return input;
  if (
    ![
      "runtime.status",
      "runtime.list",
      "native.controls",
      "native.catalog",
    ].includes(method)
  )
    throw new ExecutionRefused(
      403,
      "A workspace read cannot change native execution.",
    );
  return method === "runtime.list" ||
    method === "native.catalog" ||
    method === "native.controls"
    ? { ...input, cachedOnly: true }
    : input;
}

export type ExecutionTransport = {
  status(): z.infer<typeof ExecutionReady>;
  send(request: ExecutionRequest): Promise<unknown>;
};
const unavailable = () =>
  new ExecutionProblem(
    503,
    "Native execution disconnected. A submitted command may have completed; refresh its state before retrying. No command was replayed.",
    "unknown",
  );

export class ExecutionClient {
  private connection?: { transport: ExecutionTransport; generation: string };
  private pending = new Set<(error: Error) => void>();
  connect(transport: ExecutionTransport) {
    this.disconnect();
    const ready = ExecutionReady.parse(transport.status());
    this.connection = { transport, generation: ready.generation };
  }
  disconnect() {
    this.connection = undefined;
    for (const reject of this.pending) reject(unavailable());
    this.pending.clear();
  }
  get connected() {
    return (
      !!this.connection &&
      this.connection.transport.status().state === "ready" &&
      this.connection.transport.status().generation ===
        this.connection.generation
    );
  }
  async request<M extends ExecutionMethod>(
    method: M,
    input: ExecutionInput<M>,
    options: { owner?: string; commandId?: string } = {},
  ): Promise<ExecutionOutput<M>> {
    input = passiveInput(method, input, options.owner);
    const connection = this.connection;
    if (
      !connection ||
      connection.transport.status().state !== "ready" ||
      connection.transport.status().generation !== connection.generation
    )
      throw unavailable();
    if (this.pending.size >= 128)
      throw new Problem(
        503,
        "Native execution requests are busy. Retry after pending requests settle.",
      );
    const operation = executionOperations[method];
    const request = ExecutionRequest.parse(
      boundedExecutionJson(
        {
          v: 1,
          requestId: randomUUID(),
          generation: connection.generation,
          owner: options.owner ?? "local-workspace",
          method,
          commandId:
            operation.effect === "none"
              ? undefined
              : (options.commandId ?? randomUUID()),
          input: operation.input.parse(input),
        },
        EXECUTION_REQUEST_BYTES,
      ),
    );
    return new Promise<ExecutionOutput<M>>((resolve, reject) => {
      const stop = (error: Error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => stop(unavailable()), 300_000);
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(stop);
      };
      this.pending.add(stop);
      void Promise.resolve()
        .then(() => {
          if (this.connection !== connection || !this.pending.has(stop))
            throw unavailable();
          return connection.transport.send(request);
        })
        .then((raw) => {
          if (
            this.connection !== connection ||
            connection.transport.status().generation !==
              connection.generation ||
            connection.transport.status().state !== "ready"
          )
            throw unavailable();
          const response = ExecutionResponse.parse(
            boundedExecutionJson(raw, EXECUTION_RESPONSE_BYTES),
          );
          if (
            response.requestId !== request.requestId ||
            response.generation !== request.generation
          )
            throw unavailable();
          if (!response.ok)
            throw new ExecutionProblem(
              response.error.status,
              response.error.message,
              response.error.outcome,
            );
          return operation.output.parse(response.result) as ExecutionOutput<M>;
        })
        .then(
          (value) => {
            cleanup();
            resolve(value);
          },
          (error) => stop(error instanceof Problem ? error : unavailable()),
        );
    });
  }
}

export const executionClient = new ExecutionClient();
let remote = false;
let local:
  | Promise<(typeof import("./execution-authority.js"))["executionAuthority"]>
  | undefined;
async function localAuthority() {
  const authority = await (local ??= import("./execution-authority.js").then(
    (module) => module.executionAuthority,
  ));
  if (!remote && !executionClient.connected)
    executionClient.connect({
      status: () => authority.status(),
      send: (request) => authority.request(request),
    });
  return authority;
}
/** Activation installs a parent/child transport once; disconnect never silently
 * falls back to another in-process supervisor or resubmits an action. */
export function setExecutionTransport(transport: ExecutionTransport) {
  remote = true;
  executionClient.connect(transport);
}
export async function executionRequest<M extends ExecutionMethod>(
  method: M,
  input: ExecutionInput<M>,
  options?: { owner?: string; commandId?: string },
) {
  input = passiveInput(method, input, options?.owner);
  if (!remote) await localAuthority();
  return executionClient.request(method, input, options);
}
export async function openExecution() {
  await (await localAuthority()).open();
}
export async function scheduleExecution() {
  (await localAuthority()).schedule();
}
export async function closeExecution() {
  executionClient.disconnect();
  if (local) await (await local).close();
}
