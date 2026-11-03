import * as nativeDecisionsQueries from "./sql/native-decisions.js";
import { ExecutionRefused } from "./execution-refusal.js";
import { withFleetAction } from "./fleet-action-context.js";
import { authorizeFleetEffect } from "./fleet-effect-authorizations.js";
import {
  assertExecutionGeneration,
  executionGeneration,
} from "./execution-ownership.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NativeToolBridge } from "./native-tool-bridge.js";
import { nativeSessions, OWNER } from "./native-sessions.js";
import { nativeSignIns } from "./native-auth.js";
import {
  providerCatalog,
  saveProviderKey,
  removeProvider,
  refreshProviders,
  reconcileProviderKey,
  requireProviderIdle,
  invalidateProviderConnection,
  completeProviderSignIn,
} from "./native-providers.js";
import {
  providerChangeInProgress,
  reserveProviderChange,
} from "./native-provider-locks.js";
import { harnessUpgrades } from "./harness-upgrades.js";
import { db } from "./db.js";
import {
  ownedConversation,
  ownedFolder,
  ownedAgent,
  ownedConnection,
  Problem,
} from "./domain.js";
import { ExecutionProblem } from "../shared/problem.js";
import { startWorker } from "./worker.js";
import { nextTurnConnection, nextTurnFolder } from "./agent-runtime.js";

import { boundedExecutionJson } from "./execution-wire.js";
import { executionCommand } from "./execution-commands.js";
import {
  authOptions,
  runtimeList,
  runtimeEnable,
  upgradeStatus,
  upgradeStart,
  upgradeDismiss,
  upgradeRecover,
} from "./execution-runtime-actions.js";
import {
  ExecutionRequest,
  ExecutionResponse,
  executionOperations,
  EXECUTION_REQUEST_BYTES,
  EXECUTION_RESPONSE_BYTES,
  type ExecutionInput,
  type ExecutionMethod,
} from "../shared/execution-authority.js";

type Context = { commandId: string };
type Handlers = {
  [M in ExecutionMethod]: (
    input: ExecutionInput<M>,
    context: Context,
  ) => unknown | Promise<unknown>;
};
const agent = (id: string) => ownedAgent(id, OWNER);
const handlers: Handlers = {
  "runtime.status": () => ({ nativeProcesses: nativeSessions.count }),
  "runtime.list": runtimeList,
  "runtime.register": ({ options }) => nativeSessions.enable(options),
  "runtime.enable": runtimeEnable,
  "runtime.refresh": ({ connectionId }) => {
    const connection = ownedConnection(connectionId, OWNER);
    const name = connection.metadata.loopHarness;
    if (!name) throw new Problem(409, "Connection has no native harness");
    return nativeSessions.enable(nativeSessions.registration(name));
  },
  "auth.catalog": async (input) =>
    nativeSignIns.catalog(await authOptions(input)),
  "auth.status": ({ name }) => nativeSignIns.status(name),
  "provider.catalog": providerCatalog,
  "provider.key": (input, { commandId }) => saveProviderKey(input, commandId),
  "provider.remove": removeProvider,
  "provider.refresh": refreshProviders,
  "auth.start": async (input, { commandId }) => {
    const checkUpgrade = (ownsProviderChange = false) => {
      if (
        harnessUpgrades.busy(input.name) ||
        (!ownsProviderChange && providerChangeInProgress(input.name))
      )
        throw new ExecutionRefused(
          409,
          "Wait for the runtime upgrade to finish before signing in.",
        );
    };
    checkUpgrade();
    if (input.name === "pi" || input.name === "opencode") {
      const release = reserveProviderChange(input.name);
      try {
        requireProviderIdle(input.name);
        const options = await authOptions(input);
        // Discovery yields. Recheck the upgrade hold before opening a driver,
        // while excluding the provider-change reservation this request owns.
        checkUpgrade(true);
        return await nativeSignIns.start(
          options,
          input.provider,
          input.method,
          commandId,
          {
            beforeStart: async () => {
              await nativeSessions.resetProviderSessions(input.name);
              invalidateProviderConnection(input.name);
            },
            authenticated: (signal) =>
              completeProviderSignIn(
                { ...input, name: input.name as "pi" | "opencode" },
                signal,
              ),
          },
        );
      } finally {
        release();
      }
    }
    const options = await authOptions(input);
    checkUpgrade();
    return nativeSignIns.start(
      options,
      input.provider,
      input.method,
      commandId,
    );
  },
  "auth.input": ({ name, attemptId, promptId, value }) =>
    nativeSignIns.answer(name, attemptId, promptId, value),
  "auth.cancel": ({ name, attemptId }) => nativeSignIns.cancel(name, attemptId),
  "upgrade.status": upgradeStatus,
  "upgrade.start": (input, { commandId }) => upgradeStart(input, commandId),
  "upgrade.dismiss": upgradeDismiss,
  "upgrade.recover": (input, { commandId }) => upgradeRecover(input, commandId),
  "native.answer": ({ decisionId, answer }, { commandId }) => {
    const decision = nativeDecisionsQueries.conversation(db, decisionId) as
      { conversation_id: string } | undefined;
    if (!decision) throw new Problem(404, "Native decision not found.");
    ownedConversation(decision.conversation_id, OWNER);
    return nativeSessions.answer(decisionId, commandId, answer);
  },
  "native.controls": ({ conversationId, cachedOnly }) => {
    ownedConversation(conversationId, OWNER);
    return nativeSessions.controls(conversationId, cachedOnly);
  },
  "native.setting": ({
    conversationId,
    setting,
    value,
    revision,
    generation,
  }) => {
    ownedConversation(conversationId, OWNER);
    return nativeSessions.setSetting(
      conversationId,
      setting,
      value,
      revision,
      generation,
    );
  },
  "native.catalog": ({ agentId, conversationId, cachedOnly }) => {
    const selectedAgent = agent(agentId);
    const selected = conversationId
      ? ownedConversation(conversationId, OWNER)
      : undefined;
    const conversation =
      selected?.agent_id === agentId ? selected.id : undefined;
    const { connection } = nextTurnConnection(OWNER, selectedAgent);
    return nativeSessions.catalog(
      {
        ...selectedAgent,
        connection_id: connection.id,
        folder_id: nextTurnFolder(OWNER, selectedAgent, conversation),
      },
      conversation,
      cachedOnly,
    );
  },
  "pi.trust": ({ agentId, trusted, fingerprint }) =>
    nativeSessions.piTrustDecision(agent(agentId), trusted, fingerprint),
  "pi.filters": ({ agentId, source, scope, filters, settingsHash }) =>
    nativeSessions.piPackageFilters(
      agent(agentId),
      source,
      scope,
      filters,
      settingsHash,
    ),
  "pi.preview": ({ agentId, name, args, conversationId }) =>
    nativeSessions.piPromptPreview(agent(agentId), name, args, conversationId),
  "pi.inspect": ({ agentId, source }) =>
    nativeSessions.piInspectPackage(agent(agentId), source),
  "pi.rollback": ({ agentId, source, scope }) =>
    nativeSessions.piRollbackPackage(agent(agentId), source, scope),
  "pi.action": ({ agentId, action, source, scope }) =>
    nativeSessions.piPackageAction(agent(agentId), action, source, scope),
};

/** The sole owner of live sessions, tool tickets, sign-ins, upgrades and the
 * scheduler. PR 8a invokes it in-process through the same validated wire data. */
export class ExecutionAuthority {
  readonly generation = executionGeneration() ?? randomUUID();
  private state: "starting" | "ready" | "stopping" | "disconnected" = "ready";
  private tools = new NativeToolBridge();
  private stopWorker?: ReturnType<typeof startWorker>;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  status() {
    return { v: 1 as const, generation: this.generation, state: this.state };
  }
  open() {
    return (this.opening ??= (async () => {
      if (this.state !== "ready")
        throw new Problem(503, "Execution authority is unavailable.");
      this.state = "starting";
      await harnessUpgrades.ready;
      if (this.state !== "starting")
        throw new Problem(503, "Execution authority is stopping.");
      nativeSignIns.open();
      await this.tools.start();
      if (this.state !== "starting")
        throw new Problem(503, "Execution authority is stopping.");
      nativeSessions.tools = (conversation, generation) =>
        this.tools.issue(conversation, generation);
      nativeSessions.revokeTools = (conversation, generation) =>
        this.tools.revoke(conversation, generation);
      this.state = "ready";
    })());
  }
  schedule() {
    assertExecutionGeneration(this.generation);
    if (this.state !== "ready")
      throw new Problem(503, "Execution authority is unavailable.");
    this.stopWorker ??= startWorker();
  }
  quiesce() {
    this.state = "stopping";
    this.stopWorker?.quiesce();
  }
  close() {
    return (this.closing ??= (async () => {
      this.quiesce();
      await nativeSignIns.close();
      await this.opening?.catch(() => {});
      if (this.stopWorker) await this.stopWorker();
      else await nativeSessions.close();
      await this.tools.close();
      this.state = "disconnected";
    })());
  }
  async request(raw: unknown): Promise<ExecutionResponse> {
    const request = ExecutionRequest.parse(
      boundedExecutionJson(raw, EXECUTION_REQUEST_BYTES),
    );
    const base = {
      v: 1 as const,
      requestId: request.requestId,
      generation: this.generation,
    };
    let entered = false;
    try {
      assertExecutionGeneration(this.generation);
      if (this.state !== "ready")
        throw new Problem(503, "Execution authority is not ready.");
      if (request.generation !== this.generation)
        throw new Problem(
          409,
          "Execution authority changed; refresh before retrying.",
        );
      if (request.owner !== OWNER)
        throw new Problem(
          403,
          "Execution authority belongs to another workspace.",
        );
      const operation = executionOperations[request.method];
      if (operation.effect !== "none" && !request.commandId)
        throw new Problem(
          400,
          "Execution actions require a durable command ID.",
        );
      const input = operation.input.parse(request.input);
      // Refuse cross-owner identities before reserving a command ID. A typo
      // or an unauthorized probe must not poison a later authorized request.
      if ("projectId" in input) ownedFolder(input.projectId, OWNER);
      if ("agentId" in input) ownedAgent(input.agentId, OWNER);
      if ("conversationId" in input && input.conversationId)
        ownedConversation(input.conversationId, OWNER);
      if ("connectionId" in input) ownedConnection(input.connectionId, OWNER);
      const apply = async () => {
        entered = true;
        // The mapped handlers are checked against their individual inputs;
        // this one dynamic dispatch follows the method's runtime schema.
        const handler = handlers[request.method] as (
          input: unknown,
          context: Context,
        ) => unknown;
        const result = await handler(input, {
          commandId: request.commandId || "",
        });
        return operation.output.parse(
          boundedExecutionJson(result, EXECUTION_RESPONSE_BYTES),
        );
      };
      const run = () => {
        if (!request.fleet) return apply();
        if (
          request.fleet.operation !== "act" ||
          ![
            "native.answer",
            "native.setting",
            "native.controls",
            "native.catalog",
          ].includes(request.method)
        )
          throw new ExecutionRefused(
            403,
            "This grant cannot control native execution.",
          );
        return withFleetAction(
          {
            owner: request.owner,
            commandId: request.commandId ?? "",
            grant: request.fleet,
          },
          () => authorizeFleetEffect(request.owner, request.fleet!),
          apply,
        );
      };
      const result =
        operation.effect === "receipt" || operation.effect === "session"
          ? await executionCommand(
              request,
              run,
              operation.effect === "session"
                ? () => {
                    if (request.method === "provider.key")
                      return reconcileProviderKey(request.commandId!);
                    if (request.method === "auth.start") {
                      const start = input as ExecutionInput<"auth.start">;
                      return nativeSignIns.reconcileStart(
                        start.name,
                        start.provider,
                        start.method,
                        request.commandId!,
                      );
                    }
                    const action = input as ExecutionInput<
                      "auth.input" | "auth.cancel"
                    >;
                    return nativeSignIns.reconcileAttempt(
                      action.name,
                      action.attemptId,
                    );
                  }
                : undefined,
            )
          : await run();
      if (this.state !== "ready")
        throw new Problem(
          503,
          "Execution authority disconnected; reconcile the command before retrying.",
        );
      return ExecutionResponse.parse(
        boundedExecutionJson(
          { ...base, ok: true, result },
          EXECUTION_RESPONSE_BYTES,
        ),
      );
    } catch (error) {
      return {
        ...base,
        ok: false,
        error: {
          status:
            error instanceof Problem
              ? error.status
              : error instanceof z.ZodError && !entered
                ? 400
                : 500,
          message: (error instanceof Problem
            ? error.message
            : error instanceof z.ZodError && !entered
              ? "Invalid execution request."
              : "Execution request could not be completed. Inspect its current state before retrying."
          ).slice(0, 4000),
          outcome:
            error instanceof ExecutionProblem
              ? error.outcome
              : entered && !(error instanceof ExecutionRefused)
                ? "unknown"
                : "refused",
        },
      };
    }
  }
}

// In 8a there is one in-process authority. The process activation changes the
// transport, not the objects it owns or the operations its routes may invoke.
export const executionAuthority = new ExecutionAuthority();
