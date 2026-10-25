import type { RequestHandler, Response } from "express";
import type { z } from "zod";
import { Problem } from "../shared/problem.js";
import type { RouteContract } from "../shared/workspace-api.js";

type Input<C extends RouteContract> = { params: z.output<C["params"]>; query: z.output<C["query"]>; body: z.output<C["body"]> };
/** Keep Express authorization/error middleware and synchronous snapshot transactions.
 * Inputs retain their ZodError -> Problem-shaped 400 handling. Bad server output is
 * a generic 500, never a request error or a dump of private data. */
export function route<C extends RouteContract>(contract: C, handler: (input: Input<C>, response: Response<z.input<C["response"]>>) => unknown): RequestHandler<Record<string, string>> {
  return (req, res) => {
    const json = res.json;
    try {
      const input = { params: contract.params.parse(req.params), query: contract.query.parse(req.query), body: contract.body.parse(req.body) } as Input<C>;
      res.json = body => {
        const parsed = contract.response.safeParse(body);
        if (!parsed.success) throw new Problem(500, "The workspace response is unavailable. Please try again.");
        return json.call(res, parsed.data);
      };
      const result = handler(input, res);
      if (result instanceof Promise) return result.finally(() => { res.json = json; });
      res.json = json;
      return result;
    } catch (error) {
      res.json = json;
      throw error;
    }
  };
}
