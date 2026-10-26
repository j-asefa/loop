import {
  Router,
  type RouterOptions,
  type RequestHandler,
  type Response,
} from "express";
import { LEGACY_ROUTES } from "../shared/legacy-routes.js";
import type { z } from "zod";
import { Problem } from "../shared/problem.js";
import type { RouteContract } from "../shared/workspace-api.js";

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

/** Keep Express authorization/error middleware and synchronous snapshot transactions.
 * Inputs retain their ZodError -> Problem-shaped 400 handling. Bad server output is
 * a generic 500, never a request error or a dump of private data. */
function route<C extends RouteContract>(
  contract: C,
  handler: (input: Input<C>, response: Response<ResponseBody<C>>) => unknown,
): RequestHandler<Record<string, string>> {
  return (req, res) => {
    const json = res.json;
    try {
      const input = {
        params: contract.params.parse(req.params),
        query: contract.query.parse(req.query),
        body: contract.body.parse(req.body),
        ...(contract.multipart ? { file: req.file } : {}),
      } as Input<C>;
      if (contract.kind !== "stream")
        res.json = (body) => json.call(res, projectResponse(contract, body));
      res.status(contract.status ?? 200);
      const result = handler(input, res);
      if (result instanceof Promise)
        return result.finally(() => {
          res.json = json;
        });
      res.json = json;
      return result;
    } catch (error) {
      res.json = json;
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
const registeredLegacy = new Set<keyof typeof LEGACY_ROUTES>();

/** The Express router stays private; importers receive only a mount handler. */
export function registrar(name: string, options: Options = {}) {
  const {
    middleware = [],
    prefix = "",
    automaticOptions = true,
    ...routerOptions
  } = options;
  const router = Router(routerOptions);
  for (const entry of middleware) {
    if (entry.length === 1) router.use(entry[0]);
    else router.use(entry[0], entry[1]);
  }
  const mount: RequestHandler = router;
  return {
    mount,
    on<C extends RouteContract>(
      contract: C,
      handler: Parameters<typeof route<C>>[1],
      options: {
        wrap?: (handler: Handler) => Handler;
        middleware?: readonly Handler[];
      } = {},
    ) {
      const wrapped = route(contract, handler);
      const method = contract.method.toLowerCase() as
        "get" | "post" | "put" | "patch" | "delete";
      const registration = router.route(prefix + contract.path);
      registration[method](
        ...(options.middleware ?? []),
        options.wrap ? options.wrap(wrapped) : wrapped,
      );
      if (!automaticOptions) registration.options(deferOptions);
    },
    legacy(
      key: keyof typeof LEGACY_ROUTES,
      ...handlers: [Handler, ...Handler[]]
    ) {
      if (LEGACY_ROUTES[key] !== name)
        throw new Error(`Legacy route ${key} does not belong to ${name}`);
      if (registeredLegacy.has(key))
        throw new Error(`Legacy route already registered: ${key}`);
      const space = key.indexOf(" ");
      const method = key.slice(0, space).toLowerCase() as
        "get" | "post" | "put" | "patch" | "delete" | "all";
      const registration = router.route(prefix + key.slice(space + 1));
      registration[method](...handlers);
      if (!automaticOptions && method !== "all")
        registration.options(deferOptions);
      registeredLegacy.add(key);
    },
  };
}
