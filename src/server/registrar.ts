import {
  Router,
  type RouterOptions,
  type RequestHandler,
  type Request,
  type Response,
  type Express,
} from "express";
import { z } from "zod";
import { Problem } from "../shared/problem.js";
import { assertFleetAction } from "./fleet-action-context.js";
import {
  workspaceRoutes,
  type RouteContract,
} from "../shared/workspace-api.js";
import { admitsToken, isTokenMutation } from "../shared/token-scopes.js";
import type { TokenResult, TokenWrite } from "./token-requests.js";

const registeredContracts = new Set<RouteContract>(
  Object.values(workspaceRoutes),
);

type MatchedRoute = { contract: RouteContract; params: unknown };
const probes = new WeakMap<
  object,
  { router: ReturnType<typeof Router>; options: RouterOptions }
>();
const mounted = new WeakMap<Express, ReturnType<typeof Router>[]>();
type RouteLifecycle = { start: () => void; finish: () => void };
const lifecycles = new WeakMap<object, RouteLifecycle>();

/** Internal in-memory requests can expire before dispatch or before an async
 * handler finishes. Stream closure alone does not establish handler completion.
 * Only the bridge holding the actual request object can bind this lifecycle. */
export function bindRouteLifecycle(request: object, lifecycle: RouteLifecycle) {
  lifecycles.set(request, lifecycle);
}

/** Record exactly the mounts used by the application, in dispatch order. The
 * probe routers use Express itself, including each registrar's matching options,
 * but contain only capture callbacks: they never run application middleware. */
export function mountRoutes(app: Express, mount: RequestHandler, path = "/") {
  const probe = probes.get(mount);
  if (!probe) throw new Error("Mount API routes through a registrar");
  // A strict/case-sensitive registry keeps that boundary on the mount spelling
  // too; integration credentials require the canonical /api prefix.
  const wrapper = Router({ caseSensitive: probe.options.caseSensitive });
  wrapper.use(path, probe.router);
  const entries = mounted.get(app) ?? [];
  entries.push(wrapper);
  mounted.set(app, entries);
  app.use(path, mount);
}

export function mountedRoute(
  app: Express,
  method: string | undefined,
  target: string | undefined,
): RouteContract | undefined {
  if (
    !method ||
    !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
    !target?.startsWith("/") ||
    target.startsWith("//") ||
    /[#\r\n\u2028\u2029]/.test(target)
  )
    return;
  for (const probe of mounted.get(app) ?? []) {
    const response = { locals: {} as { matched?: MatchedRoute } };
    probe(
      { method, url: target, headers: {} } as Request,
      response as Response,
      () => {},
    );
    const match = response.locals.matched;
    if (match)
      return match.contract.params.safeParse(match.params).success
        ? match.contract
        : undefined;
  }
}

type ResponseBody<C extends RouteContract> = C extends { kind: "stream" }
  ? unknown
  : z.input<C["response"]>;
type Input<C extends RouteContract> = {
  params: z.output<C["params"]>;
  query: z.output<C["query"]>;
  body: z.output<C["body"]>;
} & (C extends { multipart: true }
  ? { file: Express.Multer.File | undefined }
  : {});

/** The same projection can run before bookkeeping that depends on valid output. */
export function projectResponse<C extends RouteContract>(
  contract: C,
  body: unknown,
): z.output<C["response"]> {
  const parsed = contract.response.safeParse(body);
  if (!parsed.success)
    throw new Problem(
      500,
      "The workspace response is unavailable. Please try again.",
    );
  return parsed.data as z.output<C["response"]>;
}

const RequestIdentity = z.string().min(8).max(150);

/** Keep Express authorization/error middleware and synchronous snapshot transactions.
 * Inputs retain their ZodError -> Problem-shaped 400 handling. Bad server output is
 * a generic 500, never a request error or a dump of private data. */
function route<C extends RouteContract>(
  contract: C,
  handler: (input: Input<C>, response: Response<ResponseBody<C>>) => unknown,
  identity?: { operation: string; run: TokenWrite },
): RequestHandler<Record<string, string>> {
  return (req, res) => {
    const json = res.json;
    const lifecycle = lifecycles.get(req);
    lifecycle?.start();
    const complete = () => {
      res.json = json;
      lifecycle?.finish();
    };
    try {
      const input = {
        params: contract.params.parse(req.params),
        query: contract.query.parse(req.query),
        body: contract.body.parse(req.body),
        ...(contract.multipart ? { file: req.file } : {}),
      } as Input<C>;
      res.status(contract.status ?? 200);
      if (res.locals.bearer && isTokenMutation(contract)) {
        const field = contract.identity;
        const value =
          field && typeof input.body === "object" && input.body !== null
            ? Reflect.get(input.body, field)
            : undefined;
        const key = RequestIdentity.safeParse(value);
        if (!key.success)
          throw new Problem(
            400,
            `A bearer write requires the ${field} request identity.`,
          );
        if (!identity) throw new Error("Token mutation has no identity policy");
        let captured: TokenResult | undefined;
        res.json = (body) => {
          if (captured)
            throw new Error("A token write must produce one response");
          captured = {
            status: res.statusCode,
            body: projectResponse(contract, body),
          };
          return res;
        };
        const response = () => {
          if (!captured)
            throw new Error("A token write must produce a JSON response");
          return captured;
        };
        const result = identity.run(
          {
            owner: res.locals.owner,
            tokenId: res.locals.bearer.tokenId,
            identity: key.data,
            operation: identity.operation,
            input: { params: input.params, body: input.body },
          },
          () => {
            assertFleetAction(res.locals.owner);
            const effect = handler(input, res);
            return effect instanceof Promise
              ? effect.then(response)
              : response();
          },
        );
        const send = (result: TokenResult) => {
          res.json = json;
          res.status(result.status);
          return json.call(res, projectResponse(contract, result.body));
        };
        // This is outside the local commit / external completion transaction.
        // Losing or throwing from the HTTP response cannot undo the receipt.
        if (result instanceof Promise)
          return result.then(send).finally(complete);
        const sent = send(result);
        complete();
        return sent;
      }
      if (contract.kind !== "stream")
        res.json = (body) => json.call(res, projectResponse(contract, body));
      // A delegated action may have waited in body parsing or middleware. The
      // authenticated internal context must still authorize the owning handler.
      assertFleetAction(res.locals.owner);
      const result = handler(input, res);
      if (result instanceof Promise) return result.finally(complete);
      complete();
      return result;
    } catch (error) {
      complete();
      throw error;
    }
  };
}

type Handler = RequestHandler<Record<string, string>>;
// Inventory counts declared endpoints, excluding their generated OPTIONS fall-through.
export const deferredOptionsMarker = Symbol("registrar.deferredOptions");
const continueRoute: Handler = (_req, _res, next) => next("route");
const deferOptions = Object.assign(continueRoute, {
  [deferredOptionsMarker]: true as const,
});
type Middleware = readonly [Handler] | readonly [string, Handler];
type Options = RouterOptions & {
  middleware?: readonly Middleware[];
  // App routes keep their original full URL and their authorization stage.
  prefix?: "/api";
  // Former app registrations must reach the parent admission/fallback chain.
  automaticOptions?: boolean;
};

/** The Express router stays private; importers receive only a mount handler. */
export function registrar(_name: string, options: Options = {}) {
  const {
    middleware = [],
    prefix = "",
    automaticOptions = true,
    ...routerOptions
  } = options;
  const router = Router(routerOptions);
  const probe = Router(routerOptions);
  for (const entry of middleware) {
    if (entry.length === 1) router.use(entry[0]);
    else router.use(entry[0], entry[1]);
    // Some registrars mount another registrar as middleware (native history,
    // viewport diagnostics). Include its declarations in the same order.
    const nested = probes.get(entry.length === 1 ? entry[0] : entry[1]);
    if (nested) {
      if (entry.length === 1) probe.use(nested.router);
      else probe.use(entry[0], nested.router);
    }
  }
  const mount: RequestHandler = router;
  probes.set(mount, { router: probe, options: routerOptions });
  return {
    mount,
    on<C extends RouteContract>(
      contract: C,
      handler: Parameters<typeof route<C>>[1],
      options: {
        wrap?: (handler: Handler) => Handler;
        middleware?: readonly Handler[];
        tokenWrite?: TokenWrite;
      } = {},
    ) {
      let identity: { operation: string; run: TokenWrite } | undefined;
      if (isTokenMutation(contract)) {
        const operation = contract.operation;
        if (
          !contract.identity ||
          !options.tokenWrite ||
          !operation ||
          !registeredContracts.has(contract) ||
          contract.kind === "stream"
        )
          throw new Error(
            "A token mutation requires its registered identity and JSON replay policy",
          );
        identity = { operation, run: options.tokenWrite };
      }
      const wrapped = route(contract, handler, identity);
      const method = contract.method.toLowerCase() as
        "get" | "post" | "put" | "patch" | "delete";
      const registration = router.route(prefix + contract.path);
      registration[method](
        (_req, res, next) => {
          if (
            res.locals.bearer &&
            !admitsToken(contract, res.locals.bearer.admission)
          )
            throw new Problem(403, "This token does not permit this route");
          next();
        },
        ...(options.middleware ?? []),
        options.wrap ? options.wrap(wrapped) : wrapped,
      );
      probe.route(prefix + contract.path)[method]((req, res) => {
        res.locals.matched = { contract, params: req.params };
      });
      if (!automaticOptions) registration.options(deferOptions);
    },
  };
}
