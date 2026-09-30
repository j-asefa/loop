import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AuthPrompt,
  AuthProvider,
  NativeAuthView,
  SignIn,
} from "../shared/native-auth.js";
import { createAuthDriver } from "../native-auth/drivers.js";
import { Problem } from "../shared/problem.js";

export type AuthOptions = {
  name: string;
  executable: string;
  project: string;
  /** Complete runner environment; never merge with the host when supplied. */
  env?: NodeJS.ProcessEnv;
};
export type AuthInteraction = {
  signal: AbortSignal;
  link(url: string, code?: string, instructions?: string): void;
  prompt(prompt: Omit<AuthPrompt, "id">, signal?: AbortSignal): Promise<string>;
};
export type AuthDriver = {
  readonly dead?: boolean;
  providers(): Promise<AuthProvider[]>;
  /** Optional prompt-free native model catalog; validated by the runner. */
  models?(): Promise<unknown>;
  /** Remove a provider credential through its native store API. */
  logout?(provider: string): Promise<void>;
  login(
    provider: string,
    method: string,
    interaction: AuthInteraction,
  ): Promise<void>;
  dispose(): Promise<void>;
};
const identifier = z.string().min(1).max(200);
const label = z.string().min(1).max(500);
const providersSchema = z
  .array(
    z.object({
      id: identifier,
      name: label,
      configured: z.boolean().optional(),
      methods: z
        .array(
          z.object({ id: identifier, label, type: z.enum(["oauth", "api"]) }),
        )
        .min(1)
        .max(64),
    }),
  )
  .max(512);
const promptSchema = z.object({
  type: z.enum(["text", "secret", "select", "manual_code"]),
  message: label,
  options: z
    .array(z.object({ id: identifier, label }))
    .max(100)
    .optional(),
});
type Session = {
  options: AuthOptions;
  driver: AuthDriver;
  providers: AuthProvider[];
  attempt?: SignIn;
  abort?: AbortController;
  answer?: (value: string) => void;
  timer?: NodeJS.Timeout;
  disposed?: Promise<void>;
};
const active = (attempt?: SignIn) =>
  !!attempt && ["starting", "waiting"].includes(attempt.state);
const sameEnvironment = (a?: NodeJS.ProcessEnv, b?: NodeJS.ProcessEnv) =>
  a === undefined || b === undefined
    ? a === b
    : Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => a[key] === b[key]);

// Only the paired, single-owner workspace exposes this service. Exchanges live
// in memory and credentials stay in the harness's store, never workspace events.
export class NativeSignIns {
  private sessions = new Map<string, Session>();
  private opening = new Map<string, Promise<Session>>();
  private commands = new Map<
    string,
    { name: string; provider: string; method: string; attemptId: string }
  >();
  private closing = false;
  constructor(
    private factory: (
      options: AuthOptions,
    ) => Promise<AuthDriver> = createAuthDriver,
    private lifetime = 15 * 60 * 1000,
  ) {}
  private dispose(session: Session) {
    return (session.disposed ||= Promise.resolve()
      .then(() => session.driver.dispose())
      .catch(() => {}));
  }
  private async session(
    options: AuthOptions,
    restart = false,
  ): Promise<Session> {
    if (this.closing) throw new Problem(503, "The workspace is stopping.");
    const pending = this.opening.get(options.name);
    if (pending) {
      await pending;
      return this.session(options, restart);
    }
    const prior = this.sessions.get(options.name);
    if (prior) {
      if (
        prior.options.executable === options.executable &&
        prior.options.project === options.project &&
        sameEnvironment(prior.options.env, options.env) &&
        !(restart && prior.disposed) &&
        !prior.driver.dead
      )
        return prior;
      if (active(prior.attempt))
        throw new Problem(
          409,
          "Finish or cancel this sign-in before changing its runtime or project.",
        );
      clearTimeout(prior.timer);
      // Delete before yielding so concurrent requests share the replacement.
      this.sessions.delete(options.name);
    }
    const opening = (async () => {
      if (prior) await this.dispose(prior);
      let driver: AuthDriver | undefined;
      try {
        // Snapshot the runner environment so later caller mutation cannot reuse
        // a driver tied to a different credential home or launch policy.
        options = {
          ...options,
          ...(options.env ? { env: { ...options.env } } : {}),
        };
        driver = await this.factory(options);
        const providers = providersSchema.parse(await driver.providers());
        if (this.closing) throw new Error("Workspace stopping");
        const session: Session = { options, driver, providers };
        this.sessions.set(options.name, session);
        this.arm(session);
        return session;
      } catch {
        await driver?.dispose().catch(() => {});
        throw new Problem(
          422,
          "Could not load provider sign-in. Check the installed harness and try again.",
        );
      }
    })().finally(() => this.opening.delete(options.name));
    this.opening.set(options.name, opening);
    return opening;
  }
  private arm(session: Session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (active(session.attempt)) this.end(session, "expired");
      void this.dispose(session);
    }, this.lifetime);
    session.timer.unref();
  }
  private view(session: Session): NativeAuthView {
    // Retain terminal status for reconnects, but never return raw driver data.
    return structuredClone({
      providers: session.providers,
      attempt: session.attempt,
    });
  }
  async catalog(options: AuthOptions) {
    return this.view(await this.session(options));
  }
  status(name: string): NativeAuthView {
    const session = this.sessions.get(name);
    return session ? this.view(session) : { providers: [] };
  }
  inProgress(name: string) {
    return active(this.sessions.get(name)?.attempt);
  }
  open() {
    this.closing = false;
  }
  private end(session: Session, state: SignIn["state"]) {
    if (session.attempt) {
      session.attempt.state = state;
      delete session.attempt.url;
      delete session.attempt.code;
      delete session.attempt.instructions;
      delete session.attempt.prompt;
    }
    session.answer = undefined;
    session.abort?.abort();
    clearTimeout(session.timer);
    void this.dispose(session);
  }
  async start(
    options: AuthOptions,
    provider: string,
    method: string,
    commandId: string,
  ): Promise<NativeAuthView> {
    let session = await this.session(options);
    const old = this.commands.get(commandId);
    if (old) {
      if (
        old.name !== options.name ||
        old.provider !== provider ||
        old.method !== method ||
        old.attemptId !== session.attempt?.id
      )
        throw new Problem(
          409,
          "This sign-in request has already been used. Check the current status before starting again.",
        );
      return this.view(session);
    }
    if (active(session.attempt))
      throw new Problem(
        409,
        "A sign-in is already in progress. Continue or cancel it first.",
      );
    if (session.disposed) {
      session = await this.session(options, true);
      // Another device may have started while this driver's catalog was loading.
      if (active(session.attempt))
        return this.start(options, provider, method, commandId);
    }
    const choice = session.providers
      .find((p) => p.id === provider)
      ?.methods.find((m) => m.id === method);
    if (!choice)
      throw new Problem(
        422,
        "Choose a sign-in method offered by this harness.",
      );
    if (this.commands.size >= 4096)
      throw new Problem(
        429,
        "Too many sign-in attempts. Restart the workspace before trying again.",
      );
    const attempt: SignIn = {
      id: randomUUID(),
      provider,
      method,
      state: "starting",
      expiresAt: Date.now() + this.lifetime,
    };
    session.attempt = attempt;
    this.commands.set(commandId, {
      name: options.name,
      provider,
      method,
      attemptId: attempt.id,
    });
    const abort = (session.abort = new AbortController());
    this.arm(session);
    const live = () => session.attempt === attempt && !abort.signal.aborted;
    const interaction: AuthInteraction = {
      signal: abort.signal,
      link: (value, code, instructions) => {
        if (!live()) return;
        const url = new URL(value);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          value.length > 12000
        )
          throw new Error("Unsupported sign-in URL");
        attempt.url = value;
        attempt.code = code?.slice(0, 100);
        attempt.instructions = instructions?.slice(0, 1000);
        attempt.state = "waiting";
      },
      prompt: (value, signal) =>
        new Promise<string>((resolve, reject) => {
          if (!live() || signal?.aborted)
            return reject(new Error("Sign-in cancelled"));
          if (session.answer)
            return reject(new Error("Overlapping sign-in prompts"));
          const prompt = promptSchema.parse(value);
          const id = randomUUID();
          const cleanup = () => {
            abort.signal.removeEventListener("abort", cancelled);
            signal?.removeEventListener("abort", cancelled);
            if (attempt.prompt?.id === id) {
              delete attempt.prompt;
              session.answer = undefined;
            }
          };
          const cancelled = () => {
            cleanup();
            reject(new Error("Sign-in cancelled"));
          };
          abort.signal.addEventListener("abort", cancelled, { once: true });
          signal?.addEventListener("abort", cancelled, { once: true });
          attempt.prompt = { id, ...prompt };
          attempt.state = "waiting";
          session.answer = (answer) => {
            cleanup();
            resolve(answer);
          };
        }),
    };
    void Promise.resolve()
      .then(() => session.driver.login(provider, method, interaction))
      .then(
        () => {
          if (!live()) return;
          const providerInfo = session.providers.find((p) => p.id === provider);
          if (providerInfo) providerInfo.configured = true;
          this.end(session, "complete");
        },
        () => {
          if (live()) this.end(session, "failed");
        },
      );
    return this.view(session);
  }
  answer(name: string, id: string, promptId: string, value: string) {
    const session = this.sessions.get(name);
    const prompt = session?.attempt?.prompt;
    if (
      !session ||
      session.attempt?.id !== id ||
      !active(session.attempt) ||
      prompt?.id !== promptId ||
      !session.answer
    )
      throw new Problem(
        409,
        "This sign-in step has ended. Refresh to see its current status.",
      );
    if (
      prompt.type === "select" &&
      !prompt.options?.some((o) => o.id === value)
    )
      throw new Problem(422, "Choose one of the available options.");
    session.answer(value);
    return this.view(session);
  }
  async cancel(name: string, id: string) {
    const session = this.sessions.get(name);
    if (!session || session.attempt?.id !== id)
      throw new Problem(409, "This sign-in attempt has ended.");
    if (active(session.attempt)) this.end(session, "cancelled");
    await this.dispose(session);
    return this.view(session);
  }
  async close() {
    this.closing = true;
    await Promise.allSettled(this.opening.values());
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        clearTimeout(session.timer);
        this.end(session, "cancelled");
        await this.dispose(session);
      }),
    );
    this.sessions.clear();
    this.commands.clear();
  }
}
export const nativeSignIns = new NativeSignIns();
