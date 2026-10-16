import { claudeTokens, tokenCount, type Tokens } from "../../adapters/usage.js";
import type { BriefGenerationUsage } from "../../shared/brief-usage.js";
import { db } from "../db.js";

/** Usage events within one request are snapshots; retries are separate requests. */
export class BriefUsage {
  private requests: Record<string, unknown>[] = [];
  private providers: string[] = [];

  start(provider: string) {
    this.providers.push(provider);
    this.requests.push({});
  }

  observe(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const request = this.requests.at(-1);
    if (!request) return;
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ]) {
      const count = tokenCount((value as Record<string, unknown>)[key]);
      if (count !== undefined) request[key] = count;
    }
  }

  snapshot(): Pick<
    BriefGenerationUsage,
    | "attempts"
    | "reported_attempts"
    | "input_tokens"
    | "output_tokens"
    | "total_tokens"
  > {
    const reported = this.requests.flatMap((request, index): Tokens[] => {
      if (this.providers[index] === "anthropic") {
        const tokens = claudeTokens(request);
        return tokens ? [tokens] : [];
      }
      const input = tokenCount(request.input_tokens),
        output = tokenCount(request.output_tokens);
      return input === undefined || output === undefined
        ? []
        : [{ input_tokens: input, output_tokens: output }];
    });
    const input = reported.reduce((sum, usage) => sum + usage.input_tokens, 0);
    const output = reported.reduce(
      (sum, usage) => sum + usage.output_tokens,
      0,
    );
    const known = reported.length > 0 && Number.isSafeInteger(input + output);
    return {
      attempts: this.requests.length,
      reported_attempts: reported.length,
      input_tokens: known ? input : null,
      output_tokens: known ? output : null,
      total_tokens: known ? input + output : null,
    };
  }
}

export function latestBriefUsage(
  owner: string,
  project: string,
): BriefGenerationUsage | null {
  const row = db
    .prepare(
      `SELECT usage FROM brief_generation_usage
    WHERE owner_id=? AND project_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1`,
    )
    .get(owner, project) as { usage: string } | undefined;
  return row ? JSON.parse(row.usage) : null;
}
