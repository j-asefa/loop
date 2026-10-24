import type { ErrorRequestHandler } from "express";
import { MulterError } from "multer";
import { ZodError } from "zod";
import { ExecutionProblem, Problem } from "../shared/problem.js";

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const clientStatus =
    err?.expose === true &&
    Number.isInteger(err.status) &&
    err.status >= 400 &&
    err.status < 500
      ? err.status
      : undefined;
  const status =
    err instanceof Problem
      ? err.status
      : err instanceof ZodError || err instanceof MulterError
        ? 400
        : (clientStatus ?? 500);
  // Parser errors can contain request bodies. Only log unexpected failures.
  if (status >= 500 && !(err instanceof Problem))
    console.error(
      `Unexpected error on ${req.method} ${req.path}: ${err?.stack ?? err}`,
    );
  res.status(status).json({
    ...(err instanceof ExecutionProblem
      ? { executionOutcome: err.outcome }
      : {}),
    error:
      err instanceof Problem
        ? err.message
        : err instanceof ZodError
          ? err.issues.map((x) => x.message).join("; ")
          : "Request could not be completed. Please try again.",
  });
};
