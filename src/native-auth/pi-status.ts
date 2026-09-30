import { piExistingEnvironment } from "../../native/loopManaged.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createAuthDriver } from "./drivers.js";
import type { AuthOptions } from "../server/native-auth.js";

const catalog = z
  .array(
    z.object({
      id: z.string().min(1).max(200),
      configured: z.boolean().optional(),
    }),
  )
  .max(1000);

/** Fresh native-store presence only; never subscription or token validity. */
export async function inspectPiAuth(
  options: Omit<AuthOptions, "name"> & { env: NodeJS.ProcessEnv },
  factory = createAuthDriver,
) {
  if (
    !options.env ||
    !isAbsolute(options.executable) ||
    !isAbsolute(options.project)
  )
    throw new Error(
      "Pi account checks require host-resolved paths and environment",
    );
  const driver = await factory({ ...options, name: "pi", env: piExistingEnvironment(options.env) });
  try {
    const providers = catalog.parse(await driver.providers());
    if (driver.dead) throw new Error("Pi account process unavailable");
    return {
      authenticated: providers.some((provider) => provider.configured === true),
      authMethod: "existing" as const,
      // Project only IDs, never SDK metadata or credentials.
      providers: [
        ...new Set(
          providers
            .filter((provider) => provider.configured === true)
            .map((provider) => provider.id),
        ),
      ],
    };
  } catch {
    throw new Error("Pi account status could not be checked");
  } finally {
    await driver.dispose();
  }
}

const models = z
  .array(
    z.object({
      provider: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^/\s]+$/),
      id: z.string().min(1).max(500),
      name: z.string().min(1).max(500).optional(),
    }),
  )
  .max(10000);

/** Discover through the same prompt-free native process and credential home. */
export async function discoverPi(
  options: Omit<AuthOptions, "name"> & { env: NodeJS.ProcessEnv },
  factory = createAuthDriver,
) {
  if (
    !options.env ||
    !isAbsolute(options.executable) ||
    !isAbsolute(options.project)
  )
    throw new Error(
      "Pi model discovery requires host-resolved paths and environment",
    );
  const driver = await factory({ ...options, name: "pi", env: piExistingEnvironment(options.env) });
  try {
    if (!driver.models) throw new Error("Native model discovery unavailable");
    const available = models.parse(await driver.models());
    const providers = catalog.parse(await driver.providers());
    if (driver.dead) throw new Error("Pi account process unavailable");
    const configured = new Set(
      providers.filter((p) => p.configured === true).map((p) => p.id),
    );
    const projected = new Map<string, { id: string; name: string }>();
    for (const model of available) {
      if (!configured.has(model.provider)) continue;
      const id = `${model.provider}/${model.id}`;
      projected.set(id, { id, name: model.name || model.id });
    }
    return {
      authenticated: configured.size > 0,
      authMethod: "existing" as const,
      models: [...projected.values()],
    };
  } catch {
    throw new Error("Pi models could not be checked");
  } finally {
    await driver.dispose();
  }
}

/** Runtime-wide sign-out removes configured providers using Pi's own API. */
export async function logoutPi(
  options: Omit<AuthOptions, "name"> & { env: NodeJS.ProcessEnv },
  factory = createAuthDriver,
) {
  if (!options.env || !isAbsolute(options.executable) || !isAbsolute(options.project))
    throw new Error("Pi sign-out requires host-resolved paths and environment");
  const driver = await factory({ ...options, name: "pi", env: piExistingEnvironment(options.env) });
  try {
    if (!driver.logout || driver.dead) throw new Error("Native sign-out unavailable");
    const providers = catalog.parse(await driver.providers());
    for (const provider of providers) {
      if (provider.configured === true) await driver.logout(provider.id);
    }
    if (driver.dead) throw new Error("Native sign-out unavailable");
  } catch {
    throw new Error("Pi sign-out could not be completed");
  } finally {
    await driver.dispose();
  }
}
