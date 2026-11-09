import { z } from "zod";
import { Problem } from "../shared/problem.js";

export const encodeCursor = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export function decodeCursor<T>(
  value: string,
  schema: z.ZodType<T>,
  message = "Invalid page cursor",
  maxLength = Infinity,
): T {
  try {
    if (value.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error("Invalid cursor encoding");
    return schema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new Problem(400, message);
  }
}
