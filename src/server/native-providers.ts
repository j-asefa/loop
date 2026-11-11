import {
  nativeConnectionId,
  harnesses,
  type ManagedHarness,
} from "../shared/harnesses.js";
import * as connectionsQueries from "./sql/connections.js";
import * as agentsQueries from "./sql/agents.js";
import * as runsQueries from "./sql/runs.js";
import { z } from "zod";
import { createAuthDriver } from "../native-auth/drivers.js";
import {
  NativeProvider,
  NativeProviderView,
} from "../shared/native-providers.js";
import type { ExecutionInput } from "../shared/execution-authority.js";
import { db, now } from "./db.js";
import { nativeSessions } from "./native-sessions.js";
import { OWNER } from "./workspace-identity.js";
import { nativeSignIns } from "./native-auth.js";
import type { AuthDriver } from "../native-auth/types.js";
import { authOptions } from "./execution-runtime-actions.js";
import { harnessHolds } from "./harness-holds.js";
import { ExecutionRefused } from "./execution-refusal.js";
import { ExecutionProblem } from "../shared/problem.js";
import { writeConnectionStatus } from "./connection-status.js";
import type { Harness } from "../shared/protocol.js";

type Target = ExecutionInput<"provider.catalog">;
// Secret-bearing commands have only HMAC receipts on disk. Keep their safe
// results in the generation that executed them, never replay the credential.
const keyResults = new Map<string, NativeProviderView>();
// Retain only safe catalog failures so a later browser can explain a completed
// sign-in whose models could not be synchronized. Never retain provider errors.
const syncErrors = new Map<string, string>();
export function reconcileProviderKey(commandId: string) {
  const result = keyResults.get(commandId);
  if (!result)
    throw new ExecutionProblem(
      409,
      "Provider change is unconfirmed. Refresh provider status before entering a key again.",
      "unknown",
    );
  return result;
}
const registration = (name: Target["name"]) =>
  nativeSessions.projects.registrations().some((r) => r.name === name)
    ? nativeSessions.projects.registration(name)
    : undefined;

export function requireProviderIdle(name: ManagedHarness) {
  if (harnessHolds.first(name, ["upgrade", "sign-in"]))
    throw new ExecutionRefused(
      409,
      "Finish the harness upgrade or provider sign-in first.",
    );
  if (nativeSessions.projects.isEnabling(name as Harness))
    throw new ExecutionRefused(
      409,
      "Wait for the harness model refresh to finish.",
    );
  if (runsQueries.hasActiveProvider(db, OWNER, name))
    throw new ExecutionRefused(
      409,
      `Finish or cancel active ${harnesses[name].label} runs before changing provider credentials.`,
    );
}
export function invalidateProviderConnection(name: ManagedHarness) {
  syncErrors.delete(name);
  const id = nativeConnectionId(name);
  writeConnectionStatus(id, () =>
    connectionsQueries.registerDisconnectedNative(
      db,
      id,
      OWNER,
      name,
      harnesses[name].label,
      JSON.stringify({
        loopHarness: name,
        authMode: "native-existing",
        runtimeKind: "loop-local",
      }),
      now(),
    ),
  );
  nativeSessions.projects.clearProbes();
}
async function withDriver<T>(
  target: Target,
  use: (driver: AuthDriver) => Promise<T>,
) {
  const driver = await createAuthDriver(await authOptions(target));
  try {
    return await use(driver);
  } finally {
    await driver.dispose();
  }
}
export async function providerCatalog(
  target: Target,
): Promise<NativeProviderView> {
  try {
    return await withDriver(target, async (driver) => {
      const providers = z
        .array(NativeProvider)
        .max(512)
        .parse(await driver.providers())
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        );
      let models = NativeProviderView.shape.models.parse(
        (await driver.models?.()) || [],
      );
      const saved = registration(target.name);
      const connection = connectionsQueries.statusModels(
        db,
        nativeConnectionId(target.name),
        OWNER,
      );
      if (saved?.billing === "subscription") {
        // Only the native execution probe can attest this restriction. Do not
        // reintroduce API models through a general provider catalog read.
        const allowed = new Set(
          NativeProviderView.shape.models
            .parse(JSON.parse(connection?.models || "[]"))
            .map((m) => m.id),
        );
        models = models.filter((m) => allowed.has(m.id));
      }
      const agents = agentsQueries.connectionModels(
        db,
        OWNER,
        nativeConnectionId(target.name),
      );
      return NativeProviderView.parse({
        providers,
        models,
        agents,
        billing: saved?.billing || "existing",
        enabled: connection?.status === "connected",
        updatedAt: Date.now(),
        syncError: syncErrors.get(target.name),
      });
    });
  } catch (error) {
    if (error instanceof ExecutionRefused) throw error;
    throw new ExecutionRefused(
      422,
      "Could not read native providers and models. Check the harness configuration and refresh.",
    );
  }
}
async function syncModels(
  target: Target,
  useProviderBilling = false,
  signal?: AbortSignal,
) {
  const saved = registration(target.name);
  let view: NativeProviderView = {
    providers: [],
    models: [],
    agents: [],
    enabled: false,
    billing: saved?.billing || "existing",
    updatedAt: Date.now(),
  };
  // Keep a saved subscription restriction unless this exact action changes it.
  const billing = useProviderBilling
    ? "existing"
    : saved?.billing || "existing";
  try {
    const options = await authOptions(target);
    view = await providerCatalog(target);
    await nativeSessions.projects.enable(
      {
        harness: target.name,
        executable: options.executable,
        project: options.project,
        version: options.version,
        billing,
      },
      true,
      signal,
    );
    const connection = connectionsQueries.readModels(
      db,
      nativeConnectionId(target.name),
      OWNER,
    ) as { models: string };
    syncErrors.delete(target.name);
    return {
      ...view,
      enabled: true,
      billing,
      models: NativeProviderView.shape.models.parse(
        JSON.parse(connection.models),
      ),
      updatedAt: Date.now(),
      syncError: undefined,
    };
  } catch (error) {
    // Specific setup guidance is Loop-authored (NativeSetupError), never
    // provider output; other startup failures keep the refresh hint.
    const syncError =
      error instanceof ExecutionRefused && error.status === 422
        ? error.message
        : "Loop could not refresh the harness models. Check its configuration and saved billing policy, then refresh models.";
    syncErrors.set(target.name, syncError);
    return {
      ...view,
      enabled: false,
      syncError,
    };
  }
}
export async function refreshProviders(
  input: ExecutionInput<"provider.refresh">,
) {
  const release = harnessHolds.reserveProviderChange(input.name);
  try {
    requireProviderIdle(input.name);
    await authOptions(input);
    await nativeSignIns.invalidate(input.name);
    await nativeSessions.resetProviderSessions(input.name);
    invalidateProviderConnection(input.name);
    return await syncModels(input, input.useProviderBilling);
  } finally {
    release();
  }
}
export async function completeProviderSignIn(
  target: Target,
  signal: AbortSignal,
) {
  // The sign-in remains active until this callback finishes, blocking both
  // credential changes and queued runs. Its durable auth command owns this
  // continuation; model probes never submit inference or repeat sign-in.
  const release = harnessHolds.reserveProviderChange(target.name);
  try {
    return await syncModels(target, false, signal);
  } finally {
    release();
  }
}
export async function saveProviderKey(
  input: ExecutionInput<"provider.key">,
  commandId: string,
) {
  const release = harnessHolds.reserveProviderChange(input.name);
  let dispatched = false;
  try {
    requireProviderIdle(input.name);
    await authOptions(input);
    await nativeSignIns.invalidate(input.name);
    await nativeSessions.resetProviderSessions(input.name);
    await withDriver(input, async (driver) => {
      const providers = z.array(NativeProvider).parse(await driver.providers());
      const method = providers
        .find((p) => p.id === input.provider)
        ?.methods.find((m) => m.id === input.method && m.type === "api");
      if (!method)
        throw new ExecutionRefused(
          422,
          "Choose an API-key method offered by this harness.",
        );
      invalidateProviderConnection(input.name);
      dispatched = true;
      const signal = AbortSignal.timeout(30000);
      let prompted = false;
      await Promise.race([
        driver.login(input.provider, input.method, {
          signal,
          link() {
            throw new Error("Use the guided provider sign-in for this method");
          },
          async prompt(prompt) {
            if (prompt.type !== "secret" || prompted)
              throw new Error(
                "Use the guided provider sign-in for this method",
              );
            prompted = true;
            // Pi expands $NAME/${NAME} in stored API keys. Encode dollars so
            // this simple key field preserves its literal value.
            return input.name === "pi"
              ? input.secret.replace(/\$/g, () => "$$")
              : input.secret;
          },
        }),
        new Promise<never>((_, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("Credential save timed out")),
            { once: true },
          ),
        ),
      ]);
    });
    const result = await syncModels(input);
    if (keyResults.size >= 128)
      keyResults.delete(keyResults.keys().next().value!);
    keyResults.set(commandId, result);
    return result;
  } catch (error) {
    if (!dispatched && error instanceof ExecutionRefused) throw error;
    throw new ExecutionProblem(
      409,
      "Credential change could not be confirmed. Refresh provider status before entering the key again.",
      "unknown",
    );
  } finally {
    release();
  }
}
export async function removeProvider(input: ExecutionInput<"provider.remove">) {
  const release = harnessHolds.reserveProviderChange(input.name);
  let dispatched = false;
  try {
    requireProviderIdle(input.name);
    await authOptions(input);
    await nativeSignIns.invalidate(input.name);
    await nativeSessions.resetProviderSessions(input.name);
    await withDriver(input, async (driver) => {
      const provider = z
        .array(NativeProvider)
        .parse(await driver.providers())
        .find((p) => p.id === input.provider);
      if (!provider?.removable || !driver.logout)
        throw new ExecutionRefused(
          422,
          "This credential is managed by the harness environment or configuration.",
        );
      invalidateProviderConnection(input.name);
      dispatched = true;
      await driver.logout(input.provider);
    });
    // Removing stored auth can uncover environment/config credentials. Show
    // those before explicitly re-enabling execution; never switch billing here.
    return {
      ...(await providerCatalog(input)),
      enabled: false,
      syncError:
        "Saved credential removed. Review remaining providers, then refresh models to enable this harness.",
    };
  } catch (error) {
    if (!dispatched && error instanceof ExecutionRefused) throw error;
    throw new ExecutionProblem(
      409,
      "Credential removal could not be confirmed. Refresh provider status before starting another removal.",
      "unknown",
    );
  } finally {
    release();
  }
}
