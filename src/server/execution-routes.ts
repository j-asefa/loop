import type {
  ExecutionInput,
  ExecutionMethod,
  ExecutionOutput,
} from "../shared/execution-authority.js";
import type { z } from "zod";
import type { RouteContract } from "../shared/route-contract.js";
import { executionRequest } from "./execution-client.js";
import type { registrar, RouteHandler } from "./registrar.js";

export function executionRoute<
  C extends RouteContract,
  M extends ExecutionMethod,
>(
  contract: C,
  method: M &
    (ExecutionOutput<NoInfer<M>> extends z.input<C["response"]>
      ? unknown
      : never),
  prepare: (...args: Parameters<RouteHandler<C>>) => {
    input: ExecutionInput<M>;
    options?: { owner?: string; commandId?: string };
  },
) {
  return (routes: ReturnType<typeof registrar>) => {
    routes.on(contract, async (req, res) => {
      const { input, options } = prepare(req, res);
      // TypeScript cannot carry the declaration's operation/response relation into this generic body.
      // The registrar still projects every result before it leaves the HTTP boundary.
      res.json(
        (await executionRequest(method, input, options)) as Parameters<
          typeof res.json
        >[0],
      );
    });
  };
}
