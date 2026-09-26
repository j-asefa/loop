import { z } from "zod";

export const VERSION = 1;
export const Harness = z.enum(["pi", "claude", "codex", "opencode"]);
export type Harness = z.infer<typeof Harness>;
export const Command = z.discriminatedUnion("type", [
  z
    .object({
      v: z.literal(1),
      id: z.string().uuid(),
      session: z.string().uuid(),
      type: z.literal("prompt"),
      text: z.string().trim().min(1).max(64000),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      id: z.string().uuid(),
      session: z.string().uuid(),
      type: z.literal("cancel"),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      id: z.string().uuid(),
      session: z.string().uuid(),
      type: z.literal("answer"),
      request: z.string().max(300),
      answer: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);
export type Command = z.infer<typeof Command>;
export type Status =
  | "starting"
  | "ready"
  | "running"
  | "awaiting-input"
  | "completed"
  | "interrupted"
  | "failed"
  | "stopped";
export type Billing = {
  mode: "subscription" | "existing";
  description: string;
  provider?: string;
  model?: string;
};
export type Capabilities = {
  approvals: boolean;
  questions: boolean;
  resume: boolean;
  liveAttach: boolean;
  terminal: boolean;
};
export type Request = {
  id: string;
  kind: "approval" | "question";
  title: string;
  detail: string;
  choices?: string[];
  questions?: {
    id: string;
    title: string;
    options?: string[];
    multiple?: boolean;
    secret?: boolean;
  }[];
};
export type Item = {
  id: string;
  kind: "user" | "assistant" | "tool" | "notice";
  text: string;
  title?: string;
  status?: string;
};
export type AdapterEvent =
  | { type: "status"; status: Status; detail?: string; recoverable?: boolean }
  | { type: "metadata"; nativeSession: string; billing?: Billing }
  | { type: "item"; item: Item }
  | { type: "delta"; id: string; text: string }
  | { type: "request"; request: Request }
  | { type: "resolved"; id: string }
  | { type: "error"; message: string };
export type Snapshot = {
  session: string;
  epoch: string;
  cursor: number;
  harness: Harness;
  project: string;
  version: string;
  nativeSession?: string;
  billing: Billing;
  capabilities: Capabilities;
  status: Status;
  recoverable?: boolean;
  detail?: string;
  items: Item[];
  requests: Request[];
  truncated: boolean;
};
export type Event = {
  v: 1;
  epoch: string;
  cursor: number;
  event: AdapterEvent;
};
export type Receipt = {
  id: string;
  status: "accepted" | "rejected" | "unknown";
  message?: string;
};
export type ServerMessage =
  | Event
  | { v: 1; snapshot: Snapshot; receipts: Receipt[] }
  | { v: 1; receipt: Receipt }
  | { v: 1; error: string };

const StatusSchema = z.enum([
  "starting",
  "ready",
  "running",
  "awaiting-input",
  "completed",
  "interrupted",
  "failed",
  "stopped",
]);
const BillingSchema = z.object({
  mode: z.enum(["subscription", "existing"]),
  description: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
});
const ItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["user", "assistant", "tool", "notice"]),
  text: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
});
const RequestSchema = z.object({
  id: z.string(),
  kind: z.enum(["approval", "question"]),
  title: z.string(),
  detail: z.string(),
  choices: z.array(z.string()).optional(),
  questions: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        options: z.array(z.string()).optional(),
        multiple: z.boolean().optional(),
        secret: z.boolean().optional(),
      }),
    )
    .optional(),
});
const ReceiptSchema = z.object({
  id: z.string(),
  status: z.enum(["accepted", "rejected", "unknown"]),
  message: z.string().optional(),
});
export const ServerFrame = z.union([
  z.object({
    v: z.literal(1),
    snapshot: z.object({
      session: z.string(),
      epoch: z.string(),
      cursor: z.number().int(),
      harness: Harness,
      project: z.string(),
      version: z.string(),
      nativeSession: z.string().optional(),
      billing: BillingSchema,
      capabilities: z.object({
        approvals: z.boolean(),
        questions: z.boolean(),
        resume: z.boolean(),
        liveAttach: z.boolean(),
        terminal: z.boolean(),
      }),
      status: StatusSchema,
      recoverable: z.boolean().optional(),
      detail: z.string().optional(),
      items: z.array(ItemSchema).max(200),
      requests: z.array(RequestSchema).max(100),
      truncated: z.boolean(),
    }),
    receipts: z.array(ReceiptSchema),
  }),
  z.object({ v: z.literal(1), receipt: ReceiptSchema }),
  z.object({ v: z.literal(1), error: z.string() }),
  z.object({
    v: z.literal(1),
    epoch: z.string(),
    cursor: z.number().int(),
    event: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("status"),
        status: StatusSchema,
        recoverable: z.boolean().optional(),
        detail: z.string().optional(),
      }),
      z.object({
        type: z.literal("metadata"),
        nativeSession: z.string(),
        billing: BillingSchema.optional(),
      }),
      z.object({ type: z.literal("item"), item: ItemSchema }),
      z.object({ type: z.literal("delta"), id: z.string(), text: z.string() }),
      z.object({ type: z.literal("request"), request: RequestSchema }),
      z.object({ type: z.literal("resolved"), id: z.string() }),
      z.object({ type: z.literal("error"), message: z.string() }),
    ]),
  }),
]);

export function validateAnswer(
  request: Request,
  answer: Record<string, unknown>,
) {
  if (request.kind === "approval") {
    if (
      typeof answer.choice !== "string" ||
      !request.choices?.includes(answer.choice)
    )
      throw new Error("Select a listed native decision.");
  } else {
    for (const q of request.questions ?? []) {
      const a = answer[q.id];
      if (
        !Array.isArray(a) ||
        !a.every((x) => typeof x === "string" && x.length <= 8000) ||
        a.length > 30
      )
        throw new Error("Invalid question answer.");
    }
  }
}
